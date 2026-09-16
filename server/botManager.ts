import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { BotConfig, BotState, GlobalStats, PublicPlatformStats } from '../src/types.js';
import { BotInstance } from './botInstance.js';
import { authManager } from './auth.js';
import { DATA_DIR } from './dataDir.js';

const ROOT_DIR = process.cwd();

const CONFIG_FILE = path.join(DATA_DIR, 'bot-configs.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'system-settings.json');
const USER_DEFAULTS_FILE = path.join(DATA_DIR, 'user-defaults.json');
const LEGACY_CONFIG_FILE = path.join(ROOT_DIR, 'bot-configs.json');
const LEGACY_SETTINGS_FILE = path.join(ROOT_DIR, 'system-settings.json');
const LEGACY_USER_DEFAULTS_FILE = path.join(ROOT_DIR, 'user-defaults.json');

export interface SystemSettings {
  globalBotLimit: number;
}

export class BotManager extends EventEmitter {
  private bots: Map<string, BotInstance> = new Map(); // botId -> BotInstance
  private sseClients: Map<string, Set<(data: any) => void>> = new Map(); // userId -> Set of callbacks
  private publicSseClients: Set<(data: any) => void> = new Set();
  private systemSettings: SystemSettings = { globalBotLimit: 1 };
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.loadSettings();
    this.loadSavedConfigs();
    this.startHealthCheckLoop();
  }

  private startHealthCheckLoop() {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    // Keep server warm and verify 24/7 bots are healthy
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, 25000);
  }

  private performHealthCheck() {
    try {
      for (const bot of this.bots.values()) {
        if (bot.config.shouldRun && (bot.status === 'stopped' || bot.status === 'error')) {
          console.log(`[AUTO-HEALING] Bot "${bot.config.name}" was marked active but was stopped. Re-initiating connection...`);
          bot.start();
        }
      }
    } catch (err) {
      console.error('[HEALTH-CHECK ERROR]:', err);
    }
  }

  private loadSettings() {
    const filesToTry = [SETTINGS_FILE, `${SETTINGS_FILE}.backup`, LEGACY_SETTINGS_FILE];
    for (const file of filesToTry) {
      if (fs.existsSync(file)) {
        try {
          const raw = fs.readFileSync(file, 'utf-8');
          const data = JSON.parse(raw);
          if (typeof data.globalBotLimit === 'number' && data.globalBotLimit >= 1) {
            this.systemSettings.globalBotLimit = data.globalBotLimit;
            return;
          }
        } catch (err) {
          console.error(`Failed to load ${file}:`, err);
        }
      }
    }
  }

  private saveSettings() {
    try {
      const data = JSON.stringify(this.systemSettings, null, 2);
      const tmpFile = `${SETTINGS_FILE}.tmp`;
      fs.writeFileSync(tmpFile, data, 'utf-8');
      fs.renameSync(tmpFile, SETTINGS_FILE);
      try {
        fs.writeFileSync(`${SETTINGS_FILE}.backup`, data, 'utf-8');
      } catch {}
    } catch (err) {
      console.error('Failed to save system-settings.json:', err);
    }
  }

  public getGlobalBotLimit(): number {
    return this.systemSettings.globalBotLimit || 1;
  }

  public setGlobalBotLimit(limit: number): number {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    this.systemSettings.globalBotLimit = safeLimit;
    this.saveSettings();

    // Enforce active bot limits across all non-admin users and broadcast
    const botsByUser = new Map<string, BotInstance[]>();
    for (const bot of this.bots.values()) {
      if (!bot.config.userId) continue;
      // Admin bots are completely exempt from global limit restrictions
      if (authManager.isUserAdmin(bot.config.userId)) continue;

      if (!botsByUser.has(bot.config.userId)) {
        botsByUser.set(bot.config.userId, []);
      }
      botsByUser.get(bot.config.userId)!.push(bot);
    }

    for (const [userId, userBots] of botsByUser.entries()) {
      const activeBots = userBots.filter(
        b => b.status === 'online' || b.status === 'reconnecting' || b.status === 'starting'
      );
      if (activeBots.length > safeLimit) {
        // Stop excess bots
        const excess = activeBots.slice(safeLimit);
        for (const excessBot of excess) {
          excessBot.config.shouldRun = false;
          excessBot.stop();
        }
        this.saveConfigs();
      }
      // Broadcast settings and stats updates
      this.broadcastUser(userId, 'settings_update', { globalBotLimit: safeLimit });
      this.broadcastUser(userId, 'stats', this.getUserStats(userId));
    }

    return safeLimit;
  }

  private loadSavedConfigs() {
    let configs: BotConfig[] = [];
    const filesToTry = [CONFIG_FILE, `${CONFIG_FILE}.backup`, LEGACY_CONFIG_FILE];
    for (const file of filesToTry) {
      if (fs.existsSync(file)) {
        try {
          const raw = fs.readFileSync(file, 'utf-8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            configs = parsed;
            break;
          }
        } catch (err) {
          console.error(`Failed to load ${file}:`, err);
        }
      }
    }

    for (const conf of configs) {
      this.registerBot(conf);
    }

    // Fast Auto-resume bots that were active before server restart / OOM recovery
    setTimeout(() => {
      let staggerDelayMs = 0;
      for (const bot of this.bots.values()) {
        if (bot.config.shouldRun && bot.status === 'stopped') {
          const currentBot = bot;
          setTimeout(() => {
            console.log(`[FAST BOOT AUTO-RESUME] Resuming 24/7 bot "${currentBot.config.name}" for user ${currentBot.config.userId}...`);
            currentBot.start();
          }, staggerDelayMs);
          staggerDelayMs += 600; // Fast 600ms stagger for immediate recovery
        }
      }
    }, 300);

    // Global Proactive Railway Memory Sweeper (Runs every 20s to prevent OOM)
    setInterval(() => {
      this.pruneAllMemory();
    }, 20000);
  }

  public getActiveUiClientCount(): number {
    let count = this.publicSseClients.size;
    for (const set of this.sseClients.values()) {
      count += set.size;
    }
    return count;
  }

  private updateUiClientActivity() {
    const isAnyClientActive = this.getActiveUiClientCount() > 0;
    for (const bot of this.bots.values()) {
      bot.setUiActive(isAnyClientActive);
    }
  }

  private saveConfigs() {
    try {
      const configs = Array.from(this.bots.values()).map(b => b.config);
      const data = JSON.stringify(configs, null, 2);
      const tmpFile = `${CONFIG_FILE}.tmp`;
      fs.writeFileSync(tmpFile, data, 'utf-8');
      fs.renameSync(tmpFile, CONFIG_FILE);
      try {
        fs.writeFileSync(`${CONFIG_FILE}.backup`, data, 'utf-8');
      } catch {}
    } catch (err) {
      console.error('Failed to save configs:', err);
    }
  }

  private registerBot(config: BotConfig): BotInstance {
    const instance = new BotInstance(config);

    instance.on('update', (state: BotState) => {
      if (config.userId) {
        this.broadcastUser(config.userId, 'bot_update', state);
        this.broadcastUser(config.userId, 'stats', this.getUserStats(config.userId));
      }
      this.broadcastPublicStats();
    });

    instance.on('chat', (log: any) => {
      if (config.userId) {
        this.broadcastUser(config.userId, 'chat_message', { botId: config.id, message: log });
      }
    });

    this.bots.set(config.id, instance);
    return instance;
  }

  public getUserBots(userId: string, deviceId?: string, clientIp?: string, isAdmin?: boolean): BotState[] {
    const userBots = Array.from(this.bots.values())
      .filter(b => b.config.userId === userId)
      .map(b => b.getState());

    if (userBots.length > 0) {
      const bot = this.bots.get(userBots[0].id);
      if (bot) {
        let changed = false;
        if (deviceId && !bot.config.deviceId) {
          bot.config.deviceId = deviceId;
          changed = true;
        }
        if (clientIp && !bot.config.clientIp) {
          bot.config.clientIp = clientIp;
          changed = true;
        }
        if (changed) this.saveConfigs();
      }
      return userBots;
    }

    // New user profile creation
    const initialBot = this.createBot(userId, deviceId, clientIp, {
      name: 'NinimoBot',
      host: 'play.hypixel.net',
      port: 25565,
      username: 'NinimoBot',
      auth: 'offline',
      version: '',
      autoReconnect: true,
      reconnectDelaySeconds: 5,
      onJoinCommand: '',
      onJoinDelayMs: 2000,
      antiAfk: {
        enabled: true,
        intervalSeconds: 30,
        movementType: 'strafe_lr',
        strafeDurationMs: 400,
        swingArm: true,
        sneakWiggle: true,
      },
      shouldRun: false,
    }, isAdmin);
    return [initialBot];
  }

  public syncUserBots(
    userId: string,
    clientBots: BotConfig[],
    deviceId?: string,
    clientIp?: string
  ): BotState[] {
    if (!Array.isArray(clientBots) || clientBots.length === 0) {
      return this.getUserBots(userId, deviceId, clientIp);
    }

    const userExistingBots = Array.from(this.bots.values()).filter(b => b.config.userId === userId);

    for (const rawBot of clientBots) {
      if (!rawBot || !rawBot.id) continue;

      // Cross-account leakage protection:
      // 1. If rawBot specifies a userId and it is NOT this user, reject it!
      if (rawBot.userId && rawBot.userId !== userId) {
        console.warn(`[ISOLATION BLOCKED] Rejected bot ${rawBot.id} belonging to user "${rawBot.userId}" from being synced into account "${userId}"`);
        continue;
      }

      // 2. If this bot ID is already registered to a different user, reject it!
      const botOnSystem = this.bots.get(rawBot.id);
      if (botOnSystem && botOnSystem.config.userId !== userId) {
        console.warn(`[ISOLATION BLOCKED] Bot ${rawBot.id} is registered to user "${botOnSystem.config.userId}". Refusing transfer to "${userId}"`);
        continue;
      }

      const existing = this.getUserBot(userId, rawBot.id);
      if (existing) {
        existing.updateConfig({
          name: rawBot.name || existing.config.name,
          host: rawBot.host || existing.config.host,
          port: rawBot.port || existing.config.port,
          username: rawBot.username || existing.config.username,
          auth: rawBot.auth || existing.config.auth,
          password: rawBot.password !== undefined ? rawBot.password : existing.config.password,
          version: rawBot.version !== undefined ? rawBot.version : existing.config.version,
          autoReconnect: rawBot.autoReconnect !== undefined ? rawBot.autoReconnect : existing.config.autoReconnect,
          reconnectDelaySeconds: rawBot.reconnectDelaySeconds || existing.config.reconnectDelaySeconds,
          onJoinCommand: rawBot.onJoinCommand !== undefined ? rawBot.onJoinCommand : existing.config.onJoinCommand,
          onJoinDelayMs: rawBot.onJoinDelayMs || existing.config.onJoinDelayMs,
          antiAfk: rawBot.antiAfk || existing.config.antiAfk,
          shouldRun: rawBot.shouldRun !== undefined ? rawBot.shouldRun : existing.config.shouldRun,
        });
      } else if (userExistingBots.length === 0) {
        // ONLY allow registering from client backup if the user currently has ZERO bots on the server
        const newConfig: BotConfig = {
          ...rawBot,
          userId,
          deviceId: deviceId || rawBot.deviceId,
          clientIp: clientIp || rawBot.clientIp,
          name: rawBot.name || 'NinimoBot',
          host: rawBot.host || 'play.hypixel.net',
          port: Number(rawBot.port) || 25565,
          username: rawBot.username || 'NinimoBot',
          auth: rawBot.auth || 'offline',
          autoReconnect: rawBot.autoReconnect !== undefined ? rawBot.autoReconnect : true,
          reconnectDelaySeconds: rawBot.reconnectDelaySeconds || 5,
          onJoinCommand: rawBot.onJoinCommand || '',
          onJoinDelayMs: rawBot.onJoinDelayMs || 2000,
          antiAfk: rawBot.antiAfk || {
            enabled: true,
            intervalSeconds: 30,
            movementType: 'strafe_lr',
            strafeDurationMs: 400,
            swingArm: true,
            sneakWiggle: true,
          },
          shouldRun: rawBot.shouldRun || false,
        };
        const newInstance = this.registerBot(newConfig);
        if (newConfig.shouldRun) {
          newInstance.start();
        }
      }
    }

    this.saveConfigs();
    return this.getUserBots(userId, deviceId, clientIp);
  }

  public getUserBot(userId: string, botId: string): BotInstance | undefined {
    const bot = this.bots.get(botId);
    if (!bot || bot.config.userId !== userId) {
      return undefined;
    }
    return bot;
  }

  public createBot(
    userId: string,
    deviceId?: string,
    clientIp?: string,
    data?: Partial<BotConfig>,
    isPrivileged?: boolean
  ): BotState {
    const limit = this.getGlobalBotLimit();

    if (!isPrivileged) {
      // Bot Profile Limit per User Account
      const existingUserBots = Array.from(this.bots.values()).filter(b => b.config.userId === userId);
      if (existingUserBots.length >= limit) {
        throw new Error(`Account bot limit reached: Current limit is ${limit} bot${limit > 1 ? 's' : ''} per account profile.`);
      }
    }

    const payload = data || {};
    const id = `bot-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const newConfig: BotConfig = {
      id,
      userId,
      deviceId,
      clientIp,
      name: payload.name || 'NinimoBot',
      host: payload.host || 'play.hypixel.net',
      port: Number(payload.port) || 25565,
      username: payload.username || 'NinimoBot',
      auth: payload.auth || 'offline',
      password: payload.password || '',
      version: payload.version || '',
      autoReconnect: payload.autoReconnect !== undefined ? payload.autoReconnect : true,
      reconnectDelaySeconds: payload.reconnectDelaySeconds || 5,
      onJoinCommand: payload.onJoinCommand || '',
      onJoinDelayMs: payload.onJoinDelayMs || 2000,
      antiAfk: {
        enabled: payload.antiAfk?.enabled !== undefined ? payload.antiAfk.enabled : true,
        intervalSeconds: payload.antiAfk?.intervalSeconds || 30,
        movementType: payload.antiAfk?.movementType || 'strafe_lr',
        strafeDurationMs: payload.antiAfk?.strafeDurationMs || 400,
        swingArm: payload.antiAfk?.swingArm !== undefined ? payload.antiAfk.swingArm : true,
        sneakWiggle: payload.antiAfk?.sneakWiggle !== undefined ? payload.antiAfk.sneakWiggle : true,
      },
    };

    const bot = this.registerBot(newConfig);
    this.saveConfigs();
    this.broadcastUser(userId, 'bot_created', bot.getState());
    this.broadcastUser(userId, 'stats', this.getUserStats(userId));
    this.broadcastPublicStats();
    return bot.getState();
  }

  public updateBot(userId: string, botId: string, updates: Partial<BotConfig>): BotState | null {
    const bot = this.getUserBot(userId, botId);
    if (!bot) return null;

    const safeUpdates = { ...updates };
    delete (safeUpdates as any).userId;
    delete (safeUpdates as any).id;

    bot.updateConfig(safeUpdates);
    this.saveConfigs();
    this.broadcastUser(userId, 'bot_update', bot.getState());
    this.broadcastPublicStats();
    return bot.getState();
  }

  public deleteBot(userId: string, botId: string): boolean {
    const bot = this.getUserBot(userId, botId);
    if (!bot) return false;

    bot.stop();
    this.bots.delete(botId);
    this.saveConfigs();
    this.broadcastUser(userId, 'bot_deleted', { id: botId });
    this.broadcastUser(userId, 'stats', this.getUserStats(userId));
    this.broadcastPublicStats();
    return true;
  }

  public startBot(
    userId: string,
    botId: string,
    clientIp?: string,
    deviceId?: string,
    isPrivileged?: boolean
  ): boolean {
    const bot = this.getUserBot(userId, botId);
    if (!bot) return false;

    if (clientIp) bot.config.clientIp = clientIp;
    if (deviceId) bot.config.deviceId = deviceId;
    this.saveConfigs();

    if (!isPrivileged) {
      const limit = this.getGlobalBotLimit();

      // 1. Check account active concurrency
      const activeUserBots = Array.from(this.bots.values()).filter(
        b => b.config.userId === userId &&
             b.config.id !== botId &&
             (b.status === 'online' || b.status === 'reconnecting' || b.status === 'starting')
      );
      if (activeUserBots.length >= limit) {
        throw new Error(`Active bot limit reached: Current limit is ${limit} running bot${limit > 1 ? 's' : ''} for your account. Please stop a running bot first.`);
      }

      // 2. Check Device active concurrency across ALL accounts on this browser/device (excluding admin bots)
      const targetDeviceId = deviceId || bot.config.deviceId;
      if (targetDeviceId && targetDeviceId.length > 5) {
        const activeDeviceBots = Array.from(this.bots.values()).filter(
          b => b.config.deviceId === targetDeviceId &&
               b.config.id !== botId &&
               !authManager.isUserAdmin(b.config.userId) &&
               (b.status === 'online' || b.status === 'reconnecting' || b.status === 'starting')
        );
        if (activeDeviceBots.length >= limit) {
          throw new Error(`Shared bot limit reached: You are running ${limit} active bot${limit > 1 ? 's' : ''} across your accounts on this device. Stop a running bot in one of your accounts to activate this one.`);
        }
      }

      // 3. Check Network IP active concurrency across ALL accounts on this IP network (excluding admin bots)
      const targetIp = clientIp || bot.config.clientIp;
      if (targetIp && targetIp !== 'unknown' && !targetIp.startsWith('127.') && targetIp !== '::1') {
        const activeIpBots = Array.from(this.bots.values()).filter(
          b => b.config.clientIp === targetIp &&
               b.config.id !== botId &&
               !authManager.isUserAdmin(b.config.userId) &&
               (b.status === 'online' || b.status === 'reconnecting' || b.status === 'starting')
        );
        if (activeIpBots.length >= limit) {
          throw new Error(`Network bot limit reached: You are running ${limit} active bot${limit > 1 ? 's' : ''} across accounts on this network/IP. Stop a running bot on your other account to activate this one.`);
        }
      }
    }

    bot.config.shouldRun = true;
    bot.config.lastStartedAt = Date.now();
    this.saveConfigs();

    bot.start();
    this.broadcastPublicStats();
    return true;
  }

  public stopBot(userId: string, botId: string): boolean {
    const bot = this.getUserBot(userId, botId);
    if (!bot) return false;
    bot.config.shouldRun = false;
    this.saveConfigs();
    bot.stop();
    this.broadcastPublicStats();
    return true;
  }

  public restartBot(userId: string, botId: string): boolean {
    const bot = this.getUserBot(userId, botId);
    if (!bot) return false;
    bot.restart();
    return true;
  }

  public sendChat(userId: string, botId: string, message: string): boolean {
    const bot = this.getUserBot(userId, botId);
    if (!bot) return false;
    return bot.sendChat(message);
  }

  public clearChat(userId: string, botId: string): boolean {
    const bot = this.getUserBot(userId, botId);
    if (!bot) return false;
    bot.clearChatHistory();
    this.broadcastUser(userId, 'bot_update', bot.getState());
    return true;
  }

  public getUserDefaults(userId: string): any {
    try {
      const filesToTry = [USER_DEFAULTS_FILE, `${USER_DEFAULTS_FILE}.backup`, LEGACY_USER_DEFAULTS_FILE];
      for (const filePath of filesToTry) {
        if (fs.existsSync(filePath)) {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const data = JSON.parse(raw);
          if (data && data[userId]) {
            return data[userId];
          }
        }
      }
    } catch {}
    return null;
  }

  public saveUserDefaults(userId: string, defaults: any): void {
    try {
      let data: Record<string, any> = {};
      const filesToTry = [USER_DEFAULTS_FILE, LEGACY_USER_DEFAULTS_FILE];
      for (const filePath of filesToTry) {
        if (fs.existsSync(filePath)) {
          try {
            data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            break;
          } catch {}
        }
      }
      data[userId] = defaults;
      const tmpFile = `${USER_DEFAULTS_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, USER_DEFAULTS_FILE);
      try {
        fs.writeFileSync(`${USER_DEFAULTS_FILE}.backup`, JSON.stringify(data, null, 2), 'utf-8');
      } catch {}
    } catch (err) {
      console.error('Failed to save user-defaults.json:', err);
    }
  }

  public getUserStats(userId: string): GlobalStats {
    let totalBots = 0;
    let activeBots = 0;
    let reconnectingBots = 0;
    let stoppedBots = 0;
    let totalUptimeSeconds = 0;

    for (const bot of this.bots.values()) {
      if (bot.config.userId === userId) {
        totalBots++;
        if (bot.status === 'online') {
          activeBots++;
          if (bot.onlineSince) {
            totalUptimeSeconds += Math.floor((Date.now() - bot.onlineSince) / 1000);
          }
        } else if (bot.status === 'reconnecting' || bot.status === 'starting') {
          reconnectingBots++;
        } else {
          stoppedBots++;
        }
      }
    }

    return {
      totalBots,
      activeBots,
      reconnectingBots,
      stoppedBots,
      totalUptimeSeconds,
    };
  }

  // Admin Fleet and Bot Control
  public getAllBotsAdmin(): {
    bot: BotState;
    userId?: string;
  }[] {
    return Array.from(this.bots.values()).map((b) => ({
      bot: b.getState(),
      userId: b.config.userId,
    }));
  }

  public getBotsByUserId(userId: string): BotState[] {
    return Array.from(this.bots.values())
      .filter((b) => b.config.userId === userId)
      .map((b) => b.getState());
  }

  public getBot(botId: string): BotInstance | undefined {
    return this.bots.get(botId);
  }

  public adminStartBot(botId: string): boolean {
    const bot = this.bots.get(botId);
    if (!bot) return false;
    bot.start();
    if (bot.config.userId) {
      this.broadcastUser(bot.config.userId, 'bot_update', bot.getState());
    }
    return true;
  }

  public adminStopBot(botId: string): boolean {
    const bot = this.bots.get(botId);
    if (!bot) return false;
    bot.stop();
    if (bot.config.userId) {
      this.broadcastUser(bot.config.userId, 'bot_update', bot.getState());
    }
    return true;
  }

  public adminDeleteBot(botId: string): boolean {
    const bot = this.bots.get(botId);
    if (!bot) return false;
    bot.stop();
    this.bots.delete(botId);
    this.saveConfigs();
    if (bot.config.userId) {
      this.broadcastUser(bot.config.userId, 'bot_deleted', { id: botId });
      this.broadcastUser(bot.config.userId, 'stats', this.getUserStats(bot.config.userId));
    }
    return true;
  }

  public deleteAllBotsForUser(userId: string): number {
    const userBots = Array.from(this.bots.values()).filter((b) => b.config.userId === userId);
    for (const b of userBots) {
      b.stop();
      this.bots.delete(b.config.id);
      this.broadcastUser(userId, 'bot_deleted', { id: b.config.id });
    }
    if (userBots.length > 0) {
      this.saveConfigs();
      this.broadcastPublicStats();
    }
    return userBots.length;
  }

  // SSE per-user subscription
  public addSseClient(userId: string, cb: (data: any) => void) {
    if (!this.sseClients.has(userId)) {
      this.sseClients.set(userId, new Set());
    }
    this.sseClients.get(userId)!.add(cb);
    this.updateUiClientActivity();
  }

  public removeSseClient(userId: string, cb: (data: any) => void) {
    const set = this.sseClients.get(userId);
    if (set) {
      set.delete(cb);
      if (set.size === 0) {
        this.sseClients.delete(userId);
      }
    }
    this.updateUiClientActivity();
  }

  private broadcastUser(userId: string, event: string, payload: any) {
    const set = this.sseClients.get(userId);
    if (!set) return;

    const msg = { event, data: payload, timestamp: Date.now() };
    for (const client of set) {
      try {
        client(msg);
      } catch {
        set.delete(client);
      }
    }
  }

  // Public Platform Metrics & Real-time Live Counters
  public getPlatformPublicStats(): PublicPlatformStats {
    let activeBotsOnline = 0;

    for (const bot of this.bots.values()) {
      if (bot.status === 'online' || bot.status === 'reconnecting' || bot.status === 'starting') {
        activeBotsOnline++;
      }
    }

    return {
      activeBotsOnline,
    };
  }

  public addPublicSseClient(cb: (data: any) => void) {
    this.publicSseClients.add(cb);
    this.updateUiClientActivity();
  }

  public removePublicSseClient(cb: (data: any) => void) {
    this.publicSseClients.delete(cb);
    this.updateUiClientActivity();
  }

  public broadcastGlobalNotification(title: string, body: string) {
    const msg = { event: "admin_notification", data: { title, body }, timestamp: Date.now() };
    for (const [userId, set] of this.sseClients.entries()) {
      for (const client of set) {
        client(msg);
      }
    }
  }

  public broadcastPublicStats() {
    if (this.publicSseClients.size === 0) return;
    const stats = this.getPlatformPublicStats();
    const msg = { event: 'public_stats_update', data: stats, timestamp: Date.now() };
    for (const client of this.publicSseClients) {
      try {
        client(msg);
      } catch {
        this.publicSseClients.delete(client);
      }
    }
  }

  public async createAndLaunchSwarm(
    userId: string,
    deviceId: string | undefined,
    clientIp: string | undefined,
    options: {
      count: number;
      baseName: string;
      host: string;
      port: number;
      version?: string;
      auth?: 'offline' | 'microsoft';
      password?: string;
      onJoinCommand?: string;
      autoStart?: boolean;
    }
  ): Promise<BotState[]> {
    const rawCount = Math.floor(Number(options.count) || 8);
    const count = Math.max(1, Math.min(25, rawCount));
    const baseName = (options.baseName || 'Ninimo').trim();
    const createdBots: BotState[] = [];

    for (let i = 1; i <= count; i++) {
      const botName = `${baseName}${i}`;
      const id = `bot-swarm-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 6)}`;
      const newConfig: BotConfig = {
        id,
        userId,
        deviceId,
        clientIp,
        name: botName,
        host: options.host || 'play.hypixel.net',
        port: Number(options.port) || 25565,
        username: botName,
        auth: options.auth || 'offline',
        password: options.password || '',
        version: options.version || '',
        autoReconnect: true,
        reconnectDelaySeconds: 5,
        onJoinCommand: options.onJoinCommand || '',
        onJoinDelayMs: 2000,
        antiAfk: {
          enabled: true,
          intervalSeconds: 30,
          movementType: 'strafe_lr',
          strafeDurationMs: 400,
          swingArm: true,
          sneakWiggle: true,
        },
        shouldRun: options.autoStart !== false,
      };

      const botInstance = this.registerBot(newConfig);
      createdBots.push(botInstance.getState());
      this.broadcastUser(userId, 'bot_created', botInstance.getState());
    }

    this.saveConfigs();
    this.broadcastUser(userId, 'stats', this.getUserStats(userId));
    this.broadcastPublicStats();

    // If autoStart is true, start bots staggered by 1.2s to prevent server throttle
    if (options.autoStart !== false) {
      let delay = 0;
      for (const botState of createdBots) {
        setTimeout(() => {
          try {
            this.startBot(userId, botState.id, clientIp, deviceId, true);
          } catch (e) {
            console.error(`[SWARM] Failed to start bot ${botState.config.name}:`, e);
          }
        }, delay);
        delay += 1200;
      }
    }

    return createdBots;
  }

  public stopAllUserBots(userId: string) {
    for (const bot of this.bots.values()) {
      if (bot.config.userId === userId) {
        bot.stop();
      }
    }
    this.saveConfigs();
    this.broadcastUser(userId, 'stats', this.getUserStats(userId));
    this.broadcastPublicStats();
  }

  public deleteAllUserBots(userId: string) {
    const toDelete: string[] = [];
    for (const [id, bot] of this.bots.entries()) {
      if (bot.config.userId === userId) {
        bot.stop();
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      this.bots.delete(id);
      this.broadcastUser(userId, 'bot_deleted', { id });
    }
    this.saveConfigs();
    this.broadcastUser(userId, 'stats', this.getUserStats(userId));
    this.broadcastPublicStats();
  }

  // Super Admin Fleet Operations
  public massFleetAction(action: 'start_all' | 'stop_all' | 'reconnect_all' | 'broadcast_command', commandText?: string): {
    affectedCount: number;
    message: string;
  } {
    let affected = 0;
    const allBots = Array.from(this.bots.values());

    if (action === 'start_all') {
      for (const bot of allBots) {
        if (bot.status !== 'online' && bot.status !== 'starting') {
          bot.config.shouldRun = true;
          bot.start();
          affected++;
          if (bot.config.userId) {
            this.broadcastUser(bot.config.userId, 'bot_update', bot.getState());
          }
        }
      }
      this.saveConfigs();
      this.broadcastPublicStats();
      return { affectedCount: affected, message: `Successfully started ${affected} bot(s) across all accounts.` };
    }

    if (action === 'stop_all') {
      for (const bot of allBots) {
        if (bot.status === 'online' || bot.status === 'starting' || bot.status === 'reconnecting') {
          bot.config.shouldRun = false;
          bot.stop();
          affected++;
          if (bot.config.userId) {
            this.broadcastUser(bot.config.userId, 'bot_update', bot.getState());
          }
        }
      }
      this.saveConfigs();
      this.broadcastPublicStats();
      return { affectedCount: affected, message: `Successfully stopped ${affected} bot(s) across all accounts.` };
    }

    if (action === 'reconnect_all') {
      for (const bot of allBots) {
        bot.restart();
        affected++;
        if (bot.config.userId) {
          this.broadcastUser(bot.config.userId, 'bot_update', bot.getState());
        }
      }
      this.saveConfigs();
      return { affectedCount: affected, message: `Reconnecting ${affected} bot(s)...` };
    }

    if (action === 'broadcast_command' && commandText) {
      for (const bot of allBots) {
        if (bot.status === 'online') {
          bot.sendChat(commandText);
          affected++;
        }
      }
      return { affectedCount: affected, message: `Broadcasted command "${commandText}" to ${affected} online bot(s).` };
    }

    return { affectedCount: 0, message: 'No action performed' };
  }

  public pruneAllMemory(): { botsPruned: number; freedEstKb: number } {
    let count = 0;
    for (const bot of this.bots.values()) {
      bot.pruneMemoryUsage();
      count++;
    }
    if (global.gc) {
      try {
        global.gc();
      } catch {}
    }
    return { botsPruned: count, freedEstKb: Math.round(count * 1450) };
  }

  public shutdown(): void {
    console.log('[SHUTDOWN] Saving bot configurations and stopping bots...');
    try {
      this.saveConfigs();
      this.saveSettings();
      for (const bot of this.bots.values()) {
        try {
          bot.stop();
        } catch {}
      }
    } catch (err) {
      console.error('Error shutting down BotManager:', err);
    }
  }
}

export const botManager = new BotManager();
