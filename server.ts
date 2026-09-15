import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import net from 'net';
import { Server as SocketIOServer } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import { botManager } from './server/botManager.js';
import { authManager } from './server/auth.js';
import { ChatManager } from './server/chat.js';

const ROOT_DIR = process.cwd();
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

function getLocalIp(): string {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
  } catch {}
  return '127.0.0.1';
}

const chatManager = new ChatManager();

// Prevent any unhandled network errors (DNS lookup failures, broken pipes, timeouts) from crashing the server
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION GUARD]:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION GUARD]:', reason);
});

// Suppress known annoying warnings from third-party plugins (mineflayer-pvp uses old physicTick event)
const originalConsoleWarn = console.warn;
console.warn = function (...args) {
  if (
    args.length > 0 &&
    typeof args[0] === 'string' &&
    args[0].includes('physicTick') &&
    args[0].includes('deprecated')
  ) {
    return;
  }
  originalConsoleWarn.apply(console, args);
};

async function startServer() {
  const app = express();
  const server = http.createServer(app);

  // Port resolution: AI Studio sandbox routes strictly to port 3000 via internal proxy.
  // On Railway or standard production hosts, listen dynamically on the assigned process.env.PORT.
  const isAiStudioSandbox = Boolean(process.env.APPLET_ID || process.env.CONTROL_PLANE_PORT);
  const PORT = isAiStudioSandbox
    ? (Number(process.env.DEFAULT_APP_PORT) || 3000)
    : (Number(process.env.PORT) || 3000);

  // Create a single proxy middleware instance for all viewers
  const viewerProxy = createProxyMiddleware({
    changeOrigin: true,
    ws: true,
    pathRewrite: (path, req) => (req as any).originalUrl || req.url,
    router: (req) => {
      const url = (req as any).originalUrl || req.url;
      const match = url?.match(/^\/viewer\/([^/?]+)/);
      if (match) {
        const botId = match[1];
        const bot = botManager.getBot(botId);
        if (bot && bot.viewerPort) {
          return `http://127.0.0.1:${bot.viewerPort}`;
        }
      }
      return 'http://127.0.0.1:65535'; // Dead end for invalid/offline bots
    }
  });

  // Proxy Prismarine Viewer (On-demand activation to save RAM)
  app.use('/viewer/:botId', (req, res, next) => {
    const botId = req.params.botId;
    const bot = botManager.getBot(botId);
    if (!bot) {
      return res.status(404).send('Bot not found.');
    }
    if (bot.status !== 'online') {
      return res.status(400).send('Bot must be online to view 3D world stream.');
    }

    // Lazily spin up prismarine viewer on-demand
    const viewerPort = bot.startViewer();
    if (!viewerPort) {
      return res.status(500).send('Could not initialize 3D viewer.');
    }
    bot.resetViewerIdleTimeout();
    
    return (viewerProxy as any)(req, res, next);
  });

  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ limit: '15mb', extended: true }));

  // Helper auth extraction
  function getAuthUser(req: express.Request) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : (req.query.token as string | undefined);
    if (!token) return null;
    return authManager.getUserFromToken(token);
  }

  function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const user = getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    (req as any).user = user;
    next();
  }

  function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
    const user = getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!user.isAdmin) {
      return res.status(403).json({ error: 'Administrator access required' });
    }
    (req as any).user = user;
    next();
  }

  function getClientIp(req: express.Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string') return cfIp.trim();
    const realIp = req.headers['x-real-ip'];
    if (typeof realIp === 'string') return realIp.trim();
    return req.socket.remoteAddress || 'unknown';
  }

  function getDeviceId(req: express.Request): string {
    const headerFp = req.headers['x-device-fingerprint'] || req.headers['x-device-id'];
    if (typeof headerFp === 'string' && headerFp.trim().length > 3) {
      return headerFp.trim();
    }
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(/ninimo_device_id=([^;]+)/);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
    const ip = getClientIp(req);
    return `ip_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  }

  // API Health & Public Stats
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', brand: 'Ninimo', time: Date.now() });
  });

  app.get('/api/stats/public', (req, res) => {
    const stats = botManager.getPlatformPublicStats();
    res.json(stats);
  });

  // Auth Routes
  app.post('/api/auth/signup', (req, res) => {
    try {
      const { username, email, password } = req.body;
      if (!username || !email || !password) {
        return res.status(400).json({ error: 'Username, email, and password are required' });
      }
      const clientIp = getClientIp(req);
      const deviceId = getDeviceId(req);
      const result = authManager.createUser(username, email, password, clientIp, deviceId);
      // Ensure user has their isolated default bot ready
      botManager.getUserBots(result.user.id, deviceId, clientIp, result.user.isAdmin);
      botManager.broadcastPublicStats();
      res.status(201).json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create user' });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const { usernameOrEmail, password } = req.body;
      if (!usernameOrEmail || !password) {
        return res.status(400).json({ error: 'Username/email and password are required' });
      }
      const clientIp = getClientIp(req);
      const deviceId = getDeviceId(req);
      const result = authManager.login(usernameOrEmail, password, clientIp, deviceId);
      // Ensure user has their isolated default bot ready
      botManager.getUserBots(result.user.id, deviceId, clientIp, result.user.isAdmin);
      res.json(result);
    } catch (err: any) {
      res.status(401).json({ error: err.message || 'Login failed' });
    }
  });

  app.post('/api/auth/firebase', (req, res) => {
    try {
      const { uid, email, displayName, photoURL } = req.body;
      if (!uid) {
        return res.status(400).json({ error: 'Firebase UID is required' });
      }
      const clientIp = getClientIp(req);
      const deviceId = getDeviceId(req);
      const result = authManager.loginWithFirebase(
        uid,
        email || '',
        displayName || '',
        photoURL || '',
        clientIp,
        deviceId
      );
      // Ensure user has their isolated default bot ready
      botManager.getUserBots(result.user.id, deviceId, clientIp, result.user.isAdmin);
      botManager.broadcastPublicStats();
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Firebase login failed' });
    }
  });

  app.post('/api/auth/quick-login', (req, res) => {
    try {
      const { userId, quickToken } = req.body;
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required for quick login' });
      }
      const clientIp = getClientIp(req);
      const deviceId = getDeviceId(req);
      const result = authManager.quickLogin(userId, quickToken, clientIp, deviceId);
      // Ensure user has their isolated default bot ready
      botManager.getUserBots(result.user.id, deviceId, clientIp, result.user.isAdmin);
      res.json(result);
    } catch (err: any) {
      res.status(401).json({ error: err.message || 'Quick login failed' });
    }
  });

  app.post('/api/auth/revoke-quick-login', (req, res) => {
    try {
      const { quickToken } = req.body;
      if (quickToken) {
        authManager.revokeQuickLogin(quickToken);
      }
      res.json({ success: true });
    } catch {
      res.json({ success: true });
    }
  });

  app.get('/api/auth/me', (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }
    res.json({ user });
  });

  app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
    if (token) {
      authManager.invalidateSession(token);
    }
    res.json({ success: true });
  });

  app.post('/api/auth/restore-session', (req, res) => {
    try {
      const { token, user } = req.body;
      if (!token || !user) {
        return res.status(400).json({ error: 'Token and user required' });
      }
      const result = authManager.restoreSessionAndUser(token, user);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to restore session' });
    }
  });

  // User-isolated bot management routes
  app.get('/api/bots', requireAuth, (req, res) => {
    const user = (req as any).user;
    const deviceId = getDeviceId(req);
    const clientIp = getClientIp(req);
    res.json({ bots: botManager.getUserBots(user.id, deviceId, clientIp, user.isAdmin) });
  });

  app.post('/api/bots/sync', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const deviceId = getDeviceId(req);
      const clientIp = getClientIp(req);
      const clientBots = req.body?.bots || [];
      const updatedBots = botManager.syncUserBots(user.id, clientBots, deviceId, clientIp);
      res.json({ bots: updatedBots });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to sync bots' });
    }
  });

  // Heartbeat ping route to keep connection alive and prevent cloud idle timeout
  app.post('/api/ping', (req, res) => {
    res.json({ pong: true, time: Date.now() });
  });

  app.get('/api/bots/:id', requireAuth, (req, res) => {
    const user = (req as any).user;
    const bot = botManager.getUserBot(user.id, req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    res.json({ bot: bot.getState() });
  });

  app.post('/api/bots', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const deviceId = getDeviceId(req);
      const clientIp = getClientIp(req);
      const isPrivileged = user.isAdmin || user.isTester || user.username?.toUpperCase() === 'TESTER';
      const newBot = botManager.createBot(user.id, deviceId, clientIp, req.body, isPrivileged);
      res.status(201).json({ bot: newBot });
    } catch (err: any) {
      res.status(403).json({ error: err.message });
    }
  });

  app.put('/api/bots/:id', requireAuth, (req, res) => {
    const user = (req as any).user;
    const updated = botManager.updateBot(user.id, req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ error: 'Bot not found or unauthorized' });
    }
    res.json({ bot: updated });
  });

  app.delete('/api/bots/:id', requireAuth, (req, res) => {
    const user = (req as any).user;
    const ok = botManager.deleteBot(user.id, req.params.id);
    if (!ok) {
      return res.status(404).json({ error: 'Bot not found or unauthorized' });
    }
    res.json({ success: true });
  });

  app.post('/api/bots/:id/start', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const deviceId = getDeviceId(req);
      const clientIp = getClientIp(req);
      const isPrivileged = user.isAdmin || user.isTester || user.username?.toUpperCase() === 'TESTER';
      const ok = botManager.startBot(user.id, req.params.id, clientIp, deviceId, isPrivileged);
      if (!ok) {
        return res.status(404).json({ error: 'Bot not found or unauthorized' });
      }
      res.json({ success: true, message: 'Bot starting' });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Cannot activate bot' });
    }
  });

  app.post('/api/bots/:id/stop', requireAuth, (req, res) => {
    const user = (req as any).user;
    const ok = botManager.stopBot(user.id, req.params.id);
    if (!ok) {
      return res.status(404).json({ error: 'Bot not found or unauthorized' });
    }
    res.json({ success: true, message: 'Bot stopped' });
  });

  // Multi-bot Swarm (TESTER / Admin exclusive feature)
  app.post('/api/bots/swarm', requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const isPrivileged = user.isAdmin || user.isTester || user.username?.toUpperCase() === 'TESTER';
      if (!isPrivileged) {
        return res.status(403).json({ error: 'Multi-bot swarm joining is exclusive to the TESTER account.' });
      }

      const deviceId = getDeviceId(req);
      const clientIp = getClientIp(req);
      const { count, baseName, host, port, version, auth, password, onJoinCommand, autoStart } = req.body;

      const swarmBots = await botManager.createAndLaunchSwarm(user.id, deviceId, clientIp, {
        count: Number(count) || 8,
        baseName: baseName || 'Ninimo',
        host: host || 'play.hypixel.net',
        port: Number(port) || 25565,
        version: version || '',
        auth: auth || 'offline',
        password: password || '',
        onJoinCommand: onJoinCommand || '',
        autoStart: autoStart !== false,
      });

      res.json({ success: true, count: swarmBots.length, bots: swarmBots });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to spawn swarm' });
    }
  });

  app.post('/api/bots/stop-all', requireAuth, (req, res) => {
    const user = (req as any).user;
    botManager.stopAllUserBots(user.id);
    res.json({ success: true, message: 'All user bots stopped' });
  });

  app.post('/api/bots/delete-all', requireAuth, (req, res) => {
    const user = (req as any).user;
    botManager.deleteAllUserBots(user.id);
    res.json({ success: true, message: 'All user bots deleted' });
  });

  // User Bot Defaults / Presets
  app.get('/api/user/bot-defaults', requireAuth, (req, res) => {
    const user = (req as any).user;
    const defaults = botManager.getUserDefaults(user.id);
    res.json({ defaults });
  });

  app.post('/api/user/bot-defaults', requireAuth, (req, res) => {
    const user = (req as any).user;
    botManager.saveUserDefaults(user.id, req.body);
    res.json({ success: true, message: 'Defaults saved successfully' });
  });

  app.post('/api/bots/:id/clear-chat', requireAuth, (req, res) => {
    const user = (req as any).user;
    const ok = botManager.clearChat(user.id, req.params.id);
    if (!ok) {
      return res.status(404).json({ error: 'Bot not found or unauthorized' });
    }
    res.json({ success: true, message: 'Chat history cleared' });
  });

  app.post('/api/bots/:id/restart', requireAuth, (req, res) => {
    const user = (req as any).user;
    const ok = botManager.restartBot(user.id, req.params.id);
    if (!ok) {
      return res.status(404).json({ error: 'Bot not found or unauthorized' });
    }
    res.json({ success: true, message: 'Bot restarting' });
  });

  app.post('/api/bots/:id/chat', requireAuth, (req, res) => {
    const user = (req as any).user;
    const { message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }
    const ok = botManager.sendChat(user.id, req.params.id, message);
    if (!ok) {
      return res.status(400).json({ error: 'Failed to send chat message' });
    }
    res.json({ success: true });
  });

  app.post('/api/bots/:id/control', requireAuth, (req, res) => {
    const user = (req as any).user;
    const bot = botManager.getUserBot(user.id, req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    const { command, state } = req.body;
    bot.handleControl(command, state);
    res.json({ success: true });
  });

  app.get('/api/stats', requireAuth, (req, res) => {
    const user = (req as any).user;
    res.json(botManager.getUserStats(user.id));
  });

  // Public/User settings
  app.get('/api/settings', (req, res) => {
    res.json({
      globalBotLimit: botManager.getGlobalBotLimit(),
    });
  });

  // --- ADMIN ROUTES ---
  // Admin: Get all accounts and their bots
  app.get('/api/admin/accounts', requireAdmin, (req, res) => {
    const allUsers = authManager.getAllUsers(true);
    const accounts = allUsers.map((u) => {
      const userBots = botManager.getBotsByUserId(u.id);
      return {
        id: u.id,
        username: u.username,
        email: u.email,
        photoURL: u.photoURL || null,
        password: u.plainPassword || (u.username.toLowerCase() === 'shifin' ? '0508552513' : u.username === 'TESTER' ? 'TESTER' : null),
        isAdmin: u.isAdmin,
        registrationIp: u.registrationIp,
        deviceFingerprint: u.deviceFingerprint,
        createdAt: u.createdAt,
        botCount: userBots.length,
        bots: userBots.map((b) => ({
          id: b.id,
          name: b.config.name,
          username: b.config.username,
          host: b.config.host,
          port: b.config.port,
          status: b.status,
          uptimeSeconds: b.uptimeSeconds,
        })),
      };
    });
    res.json({
      accounts,
      globalBotLimit: botManager.getGlobalBotLimit(),
    });
  });

  // Admin: Create a new user account directly
  app.post('/api/admin/accounts/create', requireAdmin, (req, res) => {
    try {
      const { username, email, password } = req.body;
      if (!username || !email || !password) {
        return res.status(400).json({ error: 'Username, email, and password are required' });
      }
      const clientIp = getClientIp(req);
      const deviceId = getDeviceId(req);
      const result = authManager.createUser(username, email, password, clientIp, deviceId);
      // Ensure user has default bot profile initialized
      botManager.getUserBots(result.user.id, deviceId, clientIp, result.user.isAdmin);
      botManager.broadcastPublicStats();
      res.status(201).json({ success: true, user: result.user });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create account' });
    }
  });

  // Admin: Directly update/set password for any user account
  app.post('/api/admin/accounts/:id/password', requireAdmin, (req, res) => {
    try {
      const { newPassword } = req.body;
      if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 3) {
        return res.status(400).json({ error: 'New password must be at least 3 characters' });
      }
      const rawTarget = decodeURIComponent(req.params.id);
      const ok = authManager.setPasswordAdmin(rawTarget, newPassword);
      if (!ok) {
        return res.status(404).json({ error: 'User account not found' });
      }
      res.json({ success: true, message: 'Password updated successfully' });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to update password' });
    }
  });

  // Admin: Delete a user account and all their bots
  app.delete('/api/admin/accounts/:id', requireAdmin, (req, res) => {
    try {
      const admin = (req as any).user;
      const rawTarget = decodeURIComponent(req.params.id);
      
      const targetUser = authManager.getUser(rawTarget) ||
        authManager.getAllUsers().find(
          (u) =>
            u.id === rawTarget ||
            u.id.toLowerCase() === rawTarget.toLowerCase() ||
            u.username.toLowerCase() === rawTarget.toLowerCase() ||
            (u.email && u.email.toLowerCase() === rawTarget.toLowerCase())
        );

      const actualTargetId = targetUser ? targetUser.id : rawTarget;
      
      if (admin.id === actualTargetId || (admin.username && targetUser && admin.username.toLowerCase() === targetUser.username.toLowerCase())) {
        return res.status(400).json({ error: 'Cannot delete your own active admin account.' });
      }
      
      // Delete all bots associated with this user
      botManager.deleteAllBotsForUser(actualTargetId);
      
      // Delete user account
      const ok = authManager.deleteUser(actualTargetId);
      if (!ok) {
        return res.status(404).json({ error: 'User account not found.' });
      }
      
      res.json({ success: true, message: `Account "${targetUser?.username || actualTargetId}" and associated bots deleted successfully.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to delete account.' });
    }
  });

  // Admin: Impersonate / switch directly to any account
  app.post('/api/admin/impersonate', requireAdmin, (req, res) => {
    try {
      const admin = (req as any).user;
      const { targetUserId } = req.body;
      if (!targetUserId) {
        return res.status(400).json({ error: 'targetUserId is required' });
      }
      const impersonated = authManager.impersonateUser(admin.id, targetUserId);
      res.json(impersonated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to switch to user account' });
    }
  });

  // Admin: Update global bot limit for all accounts
  app.post('/api/admin/settings', requireAdmin, (req, res) => {
    const { globalBotLimit } = req.body;
    if (typeof globalBotLimit !== 'number' || globalBotLimit < 1) {
      return res.status(400).json({ error: 'globalBotLimit must be a number of at least 1' });
    }
    const updatedLimit = botManager.setGlobalBotLimit(globalBotLimit);
    res.json({
      globalBotLimit: updatedLimit,
      success: true,
      message: `Global bot limit updated to ${updatedLimit}`,
    });
  });

  // Admin: List all bots in the system
  app.get('/api/admin/bots', requireAdmin, (req, res) => {
    res.json({ bots: botManager.getAllBotsAdmin() });
  });

  // Admin: Start any bot
  app.post('/api/admin/bots/:id/start', requireAdmin, (req, res) => {
    const ok = botManager.adminStartBot(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Bot not found' });
    res.json({ success: true, message: 'Bot started by admin' });
  });

  // Admin: Stop any bot
  app.post('/api/admin/bots/:id/stop', requireAdmin, (req, res) => {
    const ok = botManager.adminStopBot(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Bot not found' });
    res.json({ success: true, message: 'Bot stopped by admin' });
  });

  // Admin: Delete any bot
  app.delete('/api/admin/bots/:id', requireAdmin, (req, res) => {
    const ok = botManager.adminDeleteBot(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Bot not found' });
    res.json({ success: true, message: 'Bot deleted by admin' });
  });

  // Admin: Broadcast Global Notification
  app.post('/api/admin/broadcast-notification', requireAdmin, (req, res) => {
    try {
      const { title, body } = req.body;
      if (!title || !body) {
        return res.status(400).json({ error: 'Title and body are required' });
      }
      botManager.broadcastGlobalNotification(title, body);
      res.json({ success: true, message: 'Notification broadcasted to all active clients.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin: Mass Fleet Operations (Start All, Stop All, Reconnect All, Broadcast Command)
  app.post('/api/admin/mass-fleet', requireAdmin, (req, res) => {
    const { action, commandText } = req.body;
    if (!action || !['start_all', 'stop_all', 'reconnect_all', 'broadcast_command'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Allowed: start_all, stop_all, reconnect_all, broadcast_command' });
    }
    const result = botManager.massFleetAction(action, commandText);
    res.json(result);
  });

  // Admin: Prune Memory & Run Garbage Collection
  app.post('/api/admin/prune-memory', requireAdmin, (req, res) => {
    const result = botManager.pruneAllMemory();
    res.json({
      success: true,
      message: `Pruned memory cache across ${result.botsPruned} bot instance(s). Freed ~${result.freedEstKb} KB.`,
      ...result,
    });
  });

  // Admin: Ping & Diagnostic Test for Minecraft Server (Host:Port)
  app.post('/api/admin/ping-server', requireAdmin, (req, res) => {
    const { host, port = 25565 } = req.body;
    if (!host || typeof host !== 'string') {
      return res.status(400).json({ error: 'Server host is required' });
    }
    const cleanHost = host.trim();
    const cleanPort = Number(port) || 25565;

    const startTime = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(4500);

    let resolved = false;

    socket.connect(cleanPort, cleanHost, () => {
      if (resolved) return;
      resolved = true;
      const latencyMs = Date.now() - startTime;
      socket.destroy();
      res.json({
        online: true,
        host: cleanHost,
        port: cleanPort,
        latencyMs,
        statusMessage: `Host is reachable (${latencyMs}ms)`,
      });
    });

    socket.on('timeout', () => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      res.json({
        online: false,
        host: cleanHost,
        port: cleanPort,
        latencyMs: null,
        statusMessage: 'Connection timed out (Host offline or unreachable)',
      });
    });

    socket.on('error', (err: any) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      res.json({
        online: false,
        host: cleanHost,
        port: cleanPort,
        latencyMs: null,
        statusMessage: `Connection refused or unresolved (${err.code || err.message})`,
      });
    });
  });

  // General Chat Routes (Persistent across users & sessions)
  app.get('/api/chat/messages', requireAuth, (req, res) => {
    try {
      const messages = chatManager.getMessages(200);
      const config = chatManager.getConfig();
      res.json({ messages, config });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch chat messages' });
    }
  });

  app.post('/api/chat/messages', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const { text, imageUrl, replyTo } = req.body;
      const msg = chatManager.addMessage(user, { text, imageUrl, replyTo });
      res.status(201).json(msg);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to send message' });
    }
  });

  app.delete('/api/chat/messages/:id', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const ok = chatManager.deleteMessage(req.params.id, user);
      if (!ok) {
        return res.status(404).json({ error: 'Message not found' });
      }
      res.json({ success: true, message: 'Message deleted' });
    } catch (err: any) {
      res.status(403).json({ error: err.message || 'Cannot delete message' });
    }
  });

  app.get('/api/chat/config', requireAuth, (req, res) => {
    const conf = chatManager.getConfig();
    res.json({
      ...conf,
      allowImages: conf.allowImageUploads,
    });
  });

  // Admin: Update general chat settings (e.g. toggle allowImageUploads)
  app.post('/api/admin/chat/settings', requireAdmin, (req, res) => {
    try {
      const { allowImageUploads, allowImages } = req.body;
      const targetAllow =
        typeof allowImageUploads === 'boolean'
          ? allowImageUploads
          : typeof allowImages === 'boolean'
          ? allowImages
          : null;

      if (targetAllow === null) {
        return res.status(400).json({ error: 'allowImageUploads (boolean) is required' });
      }
      const updated = chatManager.setAllowImageUploads(targetAllow);
      res.json({
        success: true,
        config: {
          ...updated,
          allowImages: updated.allowImageUploads,
        },
        message: `Image sending is now ${targetAllow ? 'enabled' : 'disabled'} for users.`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to update chat settings' });
    }
  });

  app.post('/api/admin/chat/clear', requireAdmin, (req, res) => {
    try {
      chatManager.clearAllMessages();
      res.json({ success: true, message: 'General chat cleared by admin.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // User-isolated Server-Sent Events (SSE) stream
  app.get('/api/events', (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized SSE connection' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const deviceId = getDeviceId(req);
    // Send initial snapshot for this specific user
    const initialData = JSON.stringify({
      event: 'initial_state',
      data: {
        bots: botManager.getUserBots(user.id, deviceId),
        stats: botManager.getUserStats(user.id),
        globalBotLimit: botManager.getGlobalBotLimit(),
      },
      timestamp: Date.now(),
    });
    res.write(`data: ${initialData}\n\n`);

    // Listener for broadcasts strictly for this user
    const onEvent = (payload: any) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    botManager.addSseClient(user.id, onEvent);

    // Keepalive ping every 25s
    const pingInterval = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(pingInterval);
      botManager.removeSseClient(user.id, onEvent);
      res.end();
    });
  });

  // Public real-time platform stats SSE stream for landing & guest page
  app.get('/api/events/public', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const stats = botManager.getPlatformPublicStats();
    const initialData = JSON.stringify({
      event: 'initial_public_state',
      data: stats,
      timestamp: Date.now(),
    });
    res.write(`data: ${initialData}\n\n`);

    const onPublicEvent = (payload: any) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    botManager.addPublicSseClient(onPublicEvent);

    const pingInterval = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(pingInterval);
      botManager.removePublicSseClient(onPublicEvent);
      res.end();
    });
  });

  // Standard web info endpoint
  app.get('/api/tunnel', (req, res) => {
    res.json({
      port: PORT,
      status: 'active',
      railwayDomain: process.env.RAILWAY_PUBLIC_DOMAIN || null,
    });
  });

  // Vite middleware setup (development mode in AI Studio or PC/Linux dev) vs static files (production / Railway)
  const distPath = path.join(process.cwd(), 'dist');
  const hasDist = fs.existsSync(path.join(distPath, 'index.html'));
  const isDev = (process.env.NODE_ENV !== 'production' && !process.argv.includes('--prod')) || !hasDist;

  if (isDev) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Railway or production: serve pre-compiled frontend assets
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
    }
    app.get('*', (req, res) => {
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(503).send('Application build in progress, please refresh in a moment...');
      }
    });
  }

  server.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/viewer/')) {
      const match = req.url.match(/^\/viewer\/([^/?]+)/);
      if (match) {
        const botId = match[1];
        const bot = botManager.getBot(botId);
        if (bot && bot.status === 'online') {
          bot.startViewer();
          if ((viewerProxy as any).upgrade) {
            (viewerProxy as any).upgrade(req, socket, head);
            return;
          }
        }
      }
    }
  });

  // Graceful shutdown handler for PC terminal (Ctrl+C), Linux (SIGTERM), and Railway redeploys
  let isShuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[${signal}] Initiating clean shutdown... Saving all data...`);
    try { botManager.shutdown(); } catch (err) { console.error('Error shutting down botManager:', err); }
    try { authManager.shutdown(); } catch (err) { console.error('Error shutting down authManager:', err); }
    try { chatManager.shutdown(); } catch (err) { console.error('Error shutting down chatManager:', err); }
    server.close(() => {
      console.log('✅ Ninimo server closed cleanly. All bot and user data saved.');
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(0);
    }, 2500);
  };

  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

  server.listen(PORT, '0.0.0.0', () => {
    const localIp = getLocalIp();
    console.log('\n' + '='.repeat(60));
    console.log('🤖 Ninimo 24/7 Minecraft Bot Server is ONLINE!');
    console.log('='.repeat(60));
    console.log(`  ➜  Local:    http://localhost:${PORT}/`);
    console.log(`  ➜  Network:  http://${localIp}:${PORT}/`);
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
      console.log(`  ➜  Railway:  https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
    }
    console.log(`  ➜  Data Dir: ${DATA_DIR}`);
    console.log(`  ➜  Mode:     ${isDev ? 'Development (Instant Hot-Reload)' : 'Production (Optimized static bundle)'}`);
    console.log('='.repeat(60) + '\n');

    // Server-wide memory watchdog: prevents Railway container OOM kills
    setInterval(() => {
      try {
        const mem = process.memoryUsage();
        const rssMb = Math.round(mem.rss / 1024 / 1024);
        const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
        if (rssMb > 220 || heapMb > 160) {
          console.log(`[RAM WATCHDOG] Memory at RSS: ${rssMb}MB, Heap: ${heapMb}MB. Running memory sweep & cache purge...`);
          botManager.pruneAllMemory();
          if ((global as any).gc) {
            try { (global as any).gc(); } catch {}
          }
        }
      } catch {}
    }, 30000);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
