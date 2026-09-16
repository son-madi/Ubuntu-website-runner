import { EventEmitter } from 'events';
import mineflayer from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import pvp from 'mineflayer-pvp';
import { loader as autoEatLoader } from 'mineflayer-auto-eat';
import collectBlock from 'mineflayer-collectblock';
import { mineflayer as mineflayerViewer } from 'prismarine-viewer';
import { BotConfig, BotState, BotStatus, ChatMessage } from '../src/types.js';
import { minecraftFormatToHtml, stripMinecraftCodes } from './minecraftChatUtils.js';

let nextViewerPort = 4000;

export class BotInstance extends EventEmitter {
  public config: BotConfig;
  public status: BotStatus = 'stopped';
  public viewerPort: number | null = null;
  public health: number = 20;
  public maxHealth: number = 20;
  public food: number = 20;
  public saturation: number = 5;
  public experience = { level: 0, points: 0, progress: 0 };
  public position = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  public dimension: string = 'overworld';
  public gamemode: string = 'survival';
  public ping: number = 0;
  public onlineSince: number | null = null;
  public reconnectCount: number = 0;
  public nextReconnectIn: number | null = null;
  public lastError: string | null = null;
  public lastAfkActionTime: number | null = null;
  public playersNearby: string[] = [];
  public chatHistory: ChatMessage[] = [];
  public inventory: any[] = [];
  public quickBarSlot: number = 0;

  private bot: any = null;
  private isManuallyStopped: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectIntervalTimer: NodeJS.Timeout | null = null;
  private afkIntervalTimer: NodeJS.Timeout | null = null;
  private simIntervalTimer: NodeJS.Timeout | null = null;
  private onJoinTimer: NodeJS.Timeout | null = null;
  private positionPollTimer: NodeJS.Timeout | null = null;
  private memoryOptimizerTimer: NodeJS.Timeout | null = null;
  private viewerIdleTimer: NodeJS.Timeout | null = null;
  private connectionTimeoutWatchdog: NodeJS.Timeout | null = null;
  private hasActiveUiClients: boolean = true;

  constructor(config: BotConfig) {
    super();
    this.config = { ...config };
    this.addLog('info', 'System', `Bot profile initialized for ${this.config.username}`);
  }

  public getState(): BotState {
    const uptimeSeconds = this.onlineSince ? Math.floor((Date.now() - this.onlineSince) / 1000) : 0;
    return {
      id: this.config.id,
      config: this.config,
      status: this.status,
      health: this.health,
      maxHealth: this.maxHealth,
      food: this.food,
      saturation: this.saturation,
      experience: this.experience,
      position: this.position,
      dimension: this.dimension,
      gamemode: this.gamemode,
      ping: this.ping,
      onlineSince: this.onlineSince,
      uptimeSeconds,
      reconnectCount: this.reconnectCount,
      nextReconnectIn: this.nextReconnectIn,
      lastError: this.lastError,
      lastAfkActionTime: this.lastAfkActionTime,
      playersNearby: this.playersNearby,
      chatHistory: this.chatHistory.slice(-150),
      inventory: this.inventory,
      quickBarSlot: this.quickBarSlot,
    };
  }

  public updateConfig(newConfig: Partial<BotConfig>) {
    this.config = { ...this.config, ...newConfig };
    this.emitUpdate();

    // If Anti-AFK settings changed while online, reset AFK timer
    if (this.status === 'online') {
      this.stopAfkLoop();
      if (this.config.antiAfk.enabled) {
        this.startAfkLoop();
      }
    }
  }

  public getMineflayerBot(): any {
    return this.bot;
  }

  public start() {
    this.isManuallyStopped = false;
    this.lastError = null;
    this.clearTimers();

    if ((this.config as any).simulationMode) {
      this.startSimulation();
      return;
    }

    this.isManuallyStopped = false;
    this.clearTimers();
    this.stopViewer();
    this.status = 'starting';
    this.nextReconnectIn = null;
    this.addLog('info', 'System', `Connecting to ${this.config.host}:${this.config.port} as "${this.config.username}" (${this.config.auth})...`);
    this.emitUpdate();

    // 30s connection timeout watchdog prevents bot getting indefinitely stuck in starting
    if (this.connectionTimeoutWatchdog) {
      clearTimeout(this.connectionTimeoutWatchdog);
    }
    this.connectionTimeoutWatchdog = setTimeout(() => {
      if (this.status === 'starting') {
        this.addLog('error', 'Network', 'Connection handshake timed out after 30s. Re-establishing fresh socket...');
        this.handleConnectionFailure('Connection handshake timed out');
      }
    }, 30000);

    try {
      let host = (this.config.host || '').trim();
      let port = Number(this.config.port) || 25565;

      // Automatically handle host:port if user pasted something like 'mc.hypixel.net:25565' or 'falixnodes.net:12345'
      if (host.includes(':') && !host.startsWith('[')) {
        const parts = host.split(':');
        host = parts[0].trim();
        const parsedP = parseInt(parts[1], 10);
        if (!isNaN(parsedP) && parsedP >= 1 && parsedP <= 65535) {
          port = parsedP;
        }
      }

      if (!host) {
        this.handleConnectionFailure('Invalid server address: Server Host / IP cannot be empty.');
        return;
      }

      if (isNaN(port) || port < 1 || port > 65535) {
        this.handleConnectionFailure(`Invalid server port "${this.config.port}". Port must be a number between 1 and 65535.`);
        return;
      }

      const options: any = {
        host,
        port,
        username: this.config.username,
        auth: this.config.auth || 'offline',
        hideErrors: false,
        checkTimeoutInterval: 60000,
        connectTimeout: 30000,
        viewDistance: 'tiny',
        defaultChatLength: 256,
        physicsEnabled: true,
      };

      if (this.config.version && this.config.version.trim() !== '' && this.config.version.trim().toLowerCase() !== 'auto') {
        options.version = this.config.version.trim();
      }

      if (this.config.auth === 'microsoft' && this.config.password) {
        options.password = this.config.password;
      }

      this.bot = mineflayer.createBot(options);
      
      this.bot.loadPlugin(pathfinder);
      this.bot.loadPlugin(pvp.plugin);
      this.bot.loadPlugin(autoEatLoader);
      this.bot.loadPlugin(collectBlock.plugin);

      // On-demand viewer port assignment (viewer only starts when viewed in web UI)
      if (!this.viewerPort) {
        this.viewerPort = nextViewerPort++;
      }

      // Proactive socket lifecycle tracking & OOM Protection
      if ((this.bot as any)._client) {
        const client = (this.bot as any)._client;
        client.on('connect', () => {
          this.addLog('info', 'Network', `TCP socket established to ${host}:${port}. Handshaking protocol...`);
        });
        client.on('session', () => {
          this.addLog('info', 'Network', `Handshake verified. Joining game world...`);
        });
        client.on('error', (err: any) => {
          const msg = err?.message || String(err);
          console.debug(`[Bot ${this.config.id}] Socket notice:`, msg);
        });
        // Discard unneeded heavy sound/particle/map/light/chunk data packets to conserve memory
        try {
          client.on('named_sound_effect', () => {});
          client.on('sound_effect', () => {});
          client.on('particle', () => {});
          client.on('world_particles', () => {});
          client.on('map', () => {});
          client.on('explosion', () => {});
          client.on('effect', () => {});
          client.on('update_light', () => {});
          client.on('world_event', () => {});
          client.on('stop_sound', () => {});
        } catch {}
      }

      this.attachBotListeners();
    } catch (err: any) {
      this.handleConnectionFailure(`Failed to initialize Mineflayer: ${err.message || err}`);
    }
  }

  public startViewer(): number | null {
    if (!this.bot || this.status !== 'online') return null;
    if (!this.viewerPort) {
      this.viewerPort = nextViewerPort++;
    }
    if (this.bot.viewer) {
      this.resetViewerIdleTimeout();
      return this.viewerPort;
    }
    try {
      // Lazy start prismarine viewer fallback (primary init is now on spawn)
      mineflayerViewer(this.bot, { 
        port: this.viewerPort, 
        version: this.bot.version,
        firstPerson: true, 
        viewDistance: 6,
        prefix: `/viewer/${this.config.id}` 
      } as any);
      this.resetViewerIdleTimeout();
      return this.viewerPort;
    } catch (err) {
      console.error("Failed to start on-demand viewer for bot", this.config.id, err);
      return null;
    }
  }

  public stopViewer() {
    if (this.viewerIdleTimer) {
      clearTimeout(this.viewerIdleTimer);
      this.viewerIdleTimer = null;
    }
    if (this.bot && this.bot.viewer) {
      try {
        this.bot.viewer.close();
        this.bot.viewer = null;
      } catch {}
    }
  }

  public resetViewerIdleTimeout() {
    if (this.viewerIdleTimer) {
      clearTimeout(this.viewerIdleTimer);
    }
    // Automatically close 3D viewer server after 60s of inactivity to free ~50MB RAM
    this.viewerIdleTimer = setTimeout(() => {
      this.stopViewer();
    }, 60000);
  }

  public stop() {
    this.isManuallyStopped = true;
    this.clearTimers();
    this.stopViewer();
    this.status = 'stopped';
    this.nextReconnectIn = null;
    this.onlineSince = null;

    if (this.bot) {
      try {
        const client = (this.bot as any)._client;
        if (client) {
          if (client.socket) client.socket.destroy();
          client.removeAllListeners?.();
          client.end?.('Bot stopped');
        }
        this.bot.quit('Bot stopped by user');
      } catch {}
      try {
        this.bot.removeAllListeners();
      } catch {}
      this.bot = null;
    }

    this.addLog('info', 'System', `Bot stopped manually.`);
    this.emitUpdate();
  }

  public restart() {
    this.stop();
    setTimeout(() => {
      this.start();
    }, 1000);
  }

  public sendChat(message: string): boolean {
    if (!message || message.trim() === '') return false;
    const trimmed = message.trim();

    // Log sent message once as bot_sent
    this.addLog('bot_sent', this.config.username, trimmed);

    if ((this.config as any).simulationMode) {
      setTimeout(() => {
        if (trimmed.startsWith('/')) {
          this.addLog('system', 'Server', `Command executed: ${trimmed}`);
        }
      }, 300);
      return true;
    }

    if (!this.bot || (this.status !== 'online' && this.status !== 'starting')) {
      this.addLog('error', 'Error', 'Cannot send message: Bot is offline');
      return false;
    }

    try {
      this.bot.chat(trimmed);
      return true;
    } catch (err: any) {
      this.addLog('error', 'Error', `Failed to send chat: ${err.message || err}`);
      return false;
    }
  }

  public handleControl(command: string, state: any) {
    if (!this.bot || this.status !== 'online') return;
    try {
      if (['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].includes(command)) {
        this.bot.setControlState(command as any, !!state);
      } else if (command === 'look' && typeof state === 'object') {
        const { yaw, pitch } = state;
        if (typeof yaw === 'number' && typeof pitch === 'number') {
          this.bot.look(yaw, pitch, true);
        }
      } else if (command === 'setHotbar') {
        this.bot.setQuickBarSlot(Number(state));
        this.quickBarSlot = this.bot.quickBarSlot;
        this.emitUpdate();
      } else if (command === 'attack') {
        const entity = this.bot.entityAtCursor(5);
        if (entity) this.bot.attack(entity);
      } else if (command === 'use') {
        const block = this.bot.blockAtCursor(5);
        if (block) this.bot.activateBlock(block);
      } else if (command === 'swing') {
        this.bot.swingArm('right');
      }
    } catch (e) {
      console.error("Control error", e);
    }
  }

  private attachBotListeners() {
    if (!this.bot) return;

    let hasExecutedOnJoin = false;
    const triggerOnJoin = () => {
      if (hasExecutedOnJoin) return;
      if (!this.config.onJoinCommand || !this.config.onJoinCommand.trim()) return;
      hasExecutedOnJoin = true;

      const cmd = this.config.onJoinCommand.trim();
      const delay = Math.max(300, this.config.onJoinDelayMs || 1500);
      const masked = cmd.startsWith('/login') || cmd.startsWith('/register') ? cmd.replace(/\s+.+$/, ' ********') : cmd;
      this.addLog('info', 'System', `Sending on-join command in ${delay}ms: ${masked}`);

      this.onJoinTimer = setTimeout(() => {
        if (this.bot && (this.status === 'online' || this.status === 'starting')) {
          try {
            this.bot.chat(cmd);
            this.addLog('system', 'System', `[On-Join Command Executed] ${masked}`);
          } catch (err: any) {
            this.addLog('error', 'Error', `Failed to execute on-join command: ${err.message}`);
          }
        }
      }, delay);
    };

    // When the bot packet handshake succeeds, it is connected to the Minecraft server!
    this.bot.once('login', () => {
      if (this.connectionTimeoutWatchdog) {
        clearTimeout(this.connectionTimeoutWatchdog);
        this.connectionTimeoutWatchdog = null;
      }
      this.status = 'online';
      if (!this.onlineSince) this.onlineSince = Date.now();
      this.lastError = null;
      this.nextReconnectIn = null;
      this.reconnectCount = 0;
      this.addLog('info', 'System', `Connected to server! (Status: Connected)`);
      this.emitUpdate();

      // Trigger on-join command immediately (essential for auth lobbies like AuthMe)
      triggerOnJoin();
    });

    this.bot.once('spawn', () => {
      if (this.connectionTimeoutWatchdog) {
        clearTimeout(this.connectionTimeoutWatchdog);
        this.connectionTimeoutWatchdog = null;
      }
      this.status = 'online';
      if (!this.onlineSince) this.onlineSince = Date.now();
      this.lastError = null;
      this.nextReconnectIn = null;
      this.reconnectCount = 0;
      this.addLog('info', 'System', `Spawned in world successfully! Running 24/7.`);

      // Read initial state
      this.syncBotData();

      // Start adaptive position polling (only syncs high frequency when UI is active)
      if (!this.positionPollTimer) {
        let pollCycle = 0;
        this.positionPollTimer = setInterval(() => {
          pollCycle++;
          // When no user is active on the website, poll every 10s (5 cycles) to save CPU/RAM
          if (!this.hasActiveUiClients && pollCycle % 5 !== 0) {
            return;
          }
          if (this.bot && this.bot.entity) {
            this.syncBotData();
            if (this.hasActiveUiClients) {
              this.emitUpdate();
            }
          }
        }, 2000);
      }

      // Start proactive RAM memory optimizer loop (every 30s) to prevent container OOM
      if (!this.memoryOptimizerTimer) {
        this.memoryOptimizerTimer = setInterval(() => {
          this.pruneMemoryUsage();
        }, 30000);
      }

      // Ensure on-join command has triggered
      triggerOnJoin();

      // Handle Anti-AFK
      if (this.config.antiAfk.enabled) {
        this.startAfkLoop();
      }

      this.emitUpdate();
    });

    this.bot.on('health', () => {
      if (!this.bot) return;
      this.health = Math.round(this.bot.health || 0);
      this.food = Math.round(this.bot.food || 0);
      this.saturation = Math.round(this.bot.foodSaturation || 0);
      this.emitUpdate();
    });

    this.bot.on('experience', () => {
      if (!this.bot) return;
      this.experience = {
        level: this.bot.experience?.level || 0,
        points: this.bot.experience?.points || 0,
        progress: this.bot.experience?.progress || 0,
      };
      this.emitUpdate();
    });

    // Chat message listener
    this.bot.on('message', (jsonMsg: any) => {
      try {
        const rawString = jsonMsg.toString();
        const ansiHtml = minecraftFormatToHtml(rawString);
        const cleanText = stripMinecraftCodes(rawString);

        if (!cleanText.trim()) return;

        // Parse possible sender: <PlayerName>, [PlayerName], or PlayerName:
        let sender: string | undefined = undefined;
        let contentText = cleanText;
        const playerMatch = cleanText.match(/^[<\[]([A-Za-z0-9_]{3,16})[>\]]\s*(.*)$/) ||
                            cleanText.match(/^([A-Za-z0-9_]{3,16}):\s*(.*)$/);
        if (playerMatch) {
          sender = playerMatch[1];
          contentText = playerMatch[2] || cleanText;
        }

        const myUsername = (this.config.username || '').trim().toLowerCase();
        const isFromBot = (sender && sender.toLowerCase() === myUsername) ||
                          (myUsername && cleanText.toLowerCase().includes(myUsername));

        // If the server is broadcasting back what this bot just sent, avoid duplicate entry
        if (isFromBot) {
          const recentSelf = this.chatHistory.slice(-10).reverse().find(
            (m) => m.type === 'bot_sent' && (cleanText.includes(m.text) || m.text.includes(contentText))
          );
          if (recentSelf) {
            return; // Dropping duplicate server echo of own sent chat
          }
        }

        let type: ChatMessage['type'] = 'chat';
        if (isFromBot) {
          type = 'bot_sent';
        } else if (sender) {
          type = 'chat';
        } else if (cleanText.toLowerCase().includes('whispers') || cleanText.includes('->') || cleanText.toLowerCase().includes('msg')) {
          type = 'whisper';
        } else {
          type = 'system';
        }

        this.addLog(type, sender, cleanText, ansiHtml);
      } catch (err) {
        // fallback
      }
    });

    this.bot.on('kicked', (reason: any, loggedIn: boolean) => {
      const reasonStr = typeof reason === 'string' ? reason : (reason?.text || JSON.stringify(reason));
      const cleanReason = stripMinecraftCodes(reasonStr);
      this.addLog('error', 'Kicked', `Disconnected by server: ${cleanReason}`);
      if (cleanReason.toLowerCase().includes('outdated')) {
        this.addLog('system', 'System', `Tip: Set the Minecraft version in Connection Settings to match the server (e.g. 1.20.4 or 1.16.5).`);
      }
      this.handleDisconnect(`Kicked: ${cleanReason}`);
    });

    this.bot.on('error', (err: any) => {
      const msg = err?.message || String(err);
      let friendlyMsg = msg;
      if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
        friendlyMsg = `Server "${this.config.host}" address could not be resolved. Please check the server host IP.`;
      } else if (msg.includes('ECONNREFUSED')) {
        friendlyMsg = `Connection refused at ${this.config.host}:${this.config.port}. The Minecraft server is currently offline or unreachable.`;
      } else if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
        friendlyMsg = `Connection timed out connecting to ${this.config.host}:${this.config.port}.`;
      } else if (msg.toLowerCase().includes('handshake') || msg.toLowerCase().includes('protocol')) {
        friendlyMsg = `Handshake failed with server protocol. Try explicitly selecting your Minecraft version (e.g., 1.20.4, 1.20.1, 1.16.5) in Connection Settings.`;
      }
      this.addLog('error', 'Error', `Connection error: ${friendlyMsg}`);
      this.lastError = friendlyMsg;
      this.handleDisconnect(friendlyMsg);
    });

    this.bot.on('end', (reason: any) => {
      this.addLog('info', 'System', `Connection ended (${reason || 'closed'}).`);
      this.handleDisconnect('Connection ended');
    });
  }

  private syncBotData() {
    if (!this.bot) return;
    if (this.bot.entity) {
      this.position = {
        x: Math.round(this.bot.entity.position.x * 10) / 10,
        y: Math.round(this.bot.entity.position.y * 10) / 10,
        z: Math.round(this.bot.entity.position.z * 10) / 10,
        yaw: Math.round(this.bot.entity.yaw * 10) / 10,
        pitch: Math.round(this.bot.entity.pitch * 10) / 10,
      };
    }

    if (this.bot.game) {
      this.dimension = this.bot.game.dimension || 'overworld';
      this.gamemode = this.bot.game.gameMode || 'survival';
    }

    if (this.bot.player) {
      this.ping = this.bot.player.ping || 0;
    }

    if (this.bot.players) {
      this.playersNearby = Object.keys(this.bot.players).slice(0, 100);
    }

    if (this.bot.inventory) {
      const hotbar = [];
      for (let i = 0; i < 9; i++) {
        const item = this.bot.inventory.slots[36 + i];
        hotbar.push(item ? { name: item.name, count: item.count, slot: i, displayName: item.displayName } : null);
      }
      this.inventory = hotbar;
      this.quickBarSlot = this.bot.quickBarSlot;
    }
  }

  private startAfkLoop() {
    this.stopAfkLoop();
    const intervalMs = Math.max(5, this.config.antiAfk.intervalSeconds || 30) * 1000;
    this.addLog('info', 'Anti-AFK', `Anti-AFK active: routine scheduled every ${this.config.antiAfk.intervalSeconds}s.`);

    this.afkIntervalTimer = setInterval(() => {
      this.performAntiAfkAction();
    }, intervalMs);
  }

  private stopAfkLoop() {
    if (this.afkIntervalTimer) {
      clearInterval(this.afkIntervalTimer);
      this.afkIntervalTimer = null;
    }
  }

  private performAntiAfkAction() {
    if (this.status !== 'online') return;
    this.lastAfkActionTime = Date.now();

    if ((this.config as any).simulationMode) {
      // Simulate left-right strafe silently without flooding chat
      const origX = this.position.x;
      this.position.x = Math.round((origX - 0.2) * 10) / 10;
      this.emitUpdate();
      setTimeout(() => {
        this.position.x = origX;
        this.emitUpdate();
      }, 500);
      return;
    }

    if (!this.bot || !this.bot.entity) return;

    const { movementType, strafeDurationMs, swingArm, sneakWiggle } = this.config.antiAfk;
    const duration = Math.min(1000, Math.max(200, strafeDurationMs || 350));

    try {
      // Pattern: Move left for X ms, then move right for exact X ms -> returns to original spot
      if (movementType === 'strafe_lr' || movementType === 'full_routine' || movementType === 'jump_strafe') {
        this.bot.setControlState('left', true);
        setTimeout(() => {
          if (!this.bot) return;
          this.bot.setControlState('left', false);

          // Counter-move right for same duration
          this.bot.setControlState('right', true);
          setTimeout(() => {
            if (!this.bot) return;
            this.bot.setControlState('right', false);

            if (movementType === 'jump_strafe') {
              this.bot.setControlState('jump', true);
              setTimeout(() => {
                if (this.bot) this.bot.setControlState('jump', false);
              }, 250);
            }
          }, duration);
        }, duration);
      }

      // Swing arm
      if (swingArm) {
        setTimeout(() => {
          if (this.bot) {
            try {
              this.bot.swingArm('right');
            } catch {}
          }
        }, 300);
      }

      // Sneak wiggle
      if (sneakWiggle) {
        setTimeout(() => {
          if (this.bot) {
            this.bot.setControlState('sneak', true);
            setTimeout(() => {
              if (this.bot) this.bot.setControlState('sneak', false);
            }, 250);
          }
        }, 600);
      }

      // Look wobble and return
      if (movementType === 'rotate_look' || movementType === 'full_routine') {
        const currentYaw = this.bot.entity.yaw;
        const currentPitch = this.bot.entity.pitch;
        this.bot.look(currentYaw + 0.2, currentPitch, true).then(() => {
          setTimeout(() => {
            if (this.bot && this.bot.entity) {
              this.bot.look(currentYaw, currentPitch, true);
            }
          }, 400);
        }).catch(() => {});
      }

      // Keep telemetry updated without spamming chat console
      this.emitUpdate();
    } catch (err: any) {
      // Only log if an unexpected fatal error occurs
    }
  }

  private handleDisconnect(reason: string) {
    this.clearTimers();
    this.stopViewer();
    this.onlineSince = null;
    this.status = 'kicked';
    this.lastError = reason;

    if (this.bot) {
      try {
        const client = (this.bot as any)._client;
        if (client) {
          if (client.socket) client.socket.destroy();
          client.removeAllListeners?.();
          client.end?.('disconnect');
        }
        this.bot.quit?.('disconnect');
      } catch {}
      try {
        this.bot.removeAllListeners();
        // Prevent late socket errors from crashing process
        this.bot.on('error', () => {});
      } catch {}
      this.bot = null;
    }

    if (this.isManuallyStopped) {
      this.status = 'stopped';
      this.addLog('info', 'System', `Bot stopped manually.`);
      this.emitUpdate();
      return;
    }

    // Auto-reconnect is guaranteed: immediate and resilient retry (3-5s default)
    const baseDelay = Math.max(2, this.config.reconnectDelaySeconds || 3);
    const delay = Math.min(8, baseDelay);
    this.reconnectCount++;
    this.status = 'reconnecting';
    this.nextReconnectIn = delay;
    this.addLog('info', 'Auto-Reconnect', `Disconnected (${reason || 'server closed'}). Reconnecting immediately in ${delay}s...`);
    this.emitUpdate();

    this.reconnectIntervalTimer = setInterval(() => {
      if (this.nextReconnectIn !== null && this.nextReconnectIn > 1) {
        this.nextReconnectIn--;
        this.emitUpdate();
      } else {
        if (this.reconnectIntervalTimer) clearInterval(this.reconnectIntervalTimer);
      }
    }, 1000);

    this.reconnectTimer = setTimeout(() => {
      this.nextReconnectIn = null;
      if (!this.isManuallyStopped) {
        this.addLog('info', 'Auto-Reconnect', `Immediate reconnection in progress...`);
        this.start();
      }
    }, delay * 1000);
  }

  private handleConnectionFailure(msg: string) {
    this.clearTimers();
    this.stopViewer();
    if (this.bot) {
      try {
        const client = (this.bot as any)._client;
        if (client) {
          if (client.socket) client.socket.destroy();
          client.removeAllListeners?.();
          client.end?.('failure');
        }
      } catch {}
      try {
        this.bot.removeAllListeners();
      } catch {}
      this.bot = null;
    }

    this.lastError = msg;
    this.status = 'error';
    this.addLog('error', 'Error', msg);
    this.emitUpdate();

    if (!this.isManuallyStopped) {
      const delay = 3;
      this.status = 'reconnecting';
      this.nextReconnectIn = delay;
      this.reconnectCount++;
      this.addLog('info', 'Auto-Reconnect', `Retrying connection immediately in ${delay}s...`);
      this.emitUpdate();

      this.reconnectIntervalTimer = setInterval(() => {
        if (this.nextReconnectIn !== null && this.nextReconnectIn > 1) {
          this.nextReconnectIn--;
          this.emitUpdate();
        } else {
          if (this.reconnectIntervalTimer) clearInterval(this.reconnectIntervalTimer);
        }
      }, 1000);

      this.reconnectTimer = setTimeout(() => {
        this.nextReconnectIn = null;
        if (!this.isManuallyStopped) {
          this.start();
        }
      }, delay * 1000);
    }
  }

  // Built-in Simulator for testing UI, Anti-AFK, and chat
  private startSimulation() {
    this.status = 'starting';
    this.addLog('info', 'Simulator', `Starting simulated Minecraft sandbox connection...`);
    this.emitUpdate();

    setTimeout(() => {
      if (this.isManuallyStopped) return;
      this.status = 'online';
      this.onlineSince = Date.now();
      this.health = 20;
      this.food = 20;
      this.saturation = 5;
      this.ping = 24;
      this.dimension = 'overworld';
      this.gamemode = 'survival';
      this.position = { x: 124.5, y: 64, z: -38.2, yaw: 1.2, pitch: 0.1 };
      this.playersNearby = [this.config.username, 'Steve_99', 'Alex_Miner', 'CreeperHunter'];

      this.addLog('info', 'System', `Simulated bot joined server: ${this.config.host}:${this.config.port}`);
      this.addLog('system', 'Server', `§6[Server] Welcome §a${this.config.username}§6 to the realm! 24/7 uptime active.`);

      if (this.config.onJoinCommand) {
        const cmd = this.config.onJoinCommand;
        const delay = this.config.onJoinDelayMs || 2000;
        this.addLog('info', 'System', `Scheduled on-join command in ${delay}ms...`);
        setTimeout(() => {
          if (this.status === 'online') {
            this.addLog('system', 'System', `[On-Join Executed] ${cmd}`);
          }
        }, delay);
      }

      if (this.config.antiAfk.enabled) {
        this.startAfkLoop();
      }

      // Periodic simulated chat events
      const simulatedChats = [
        '<Steve_99> anyone selling diamond picks?',
        '<Alex_Miner> base coordinates are secure',
        '§e[Announcement] Server restart in 4 hours for scheduled backup',
        '<CreeperHunter> afk bot is doing great, keeping the mob farm loaded!',
      ];
      let chatIdx = 0;

      this.simIntervalTimer = setInterval(() => {
        if (this.status === 'online') {
          const msg = simulatedChats[chatIdx % simulatedChats.length];
          chatIdx++;
          this.addLog('chat', undefined, stripMinecraftCodes(msg), minecraftFormatToHtml(msg));
          this.emitUpdate();
        }
      }, 18000);

      this.emitUpdate();
    }, 1200);
  }

  public setUiActive(isActive: boolean) {
    this.hasActiveUiClients = isActive;
    // When a user opens the dashboard, immediately sync bot data and emit state
    if (isActive && this.bot && this.status === 'online') {
      this.syncBotData();
      this.emitUpdate();
    }
  }

  private clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectIntervalTimer) {
      clearInterval(this.reconnectIntervalTimer);
      this.reconnectIntervalTimer = null;
    }
    if (this.afkIntervalTimer) {
      clearInterval(this.afkIntervalTimer);
      this.afkIntervalTimer = null;
    }
    if (this.simIntervalTimer) {
      clearInterval(this.simIntervalTimer);
      this.simIntervalTimer = null;
    }
    if (this.onJoinTimer) {
      clearTimeout(this.onJoinTimer);
      this.onJoinTimer = null;
    }
    if (this.positionPollTimer) {
      clearInterval(this.positionPollTimer);
      this.positionPollTimer = null;
    }
    if (this.memoryOptimizerTimer) {
      clearInterval(this.memoryOptimizerTimer);
      this.memoryOptimizerTimer = null;
    }
    if (this.viewerIdleTimer) {
      clearTimeout(this.viewerIdleTimer);
      this.viewerIdleTimer = null;
    }
    if (this.connectionTimeoutWatchdog) {
      clearTimeout(this.connectionTimeoutWatchdog);
      this.connectionTimeoutWatchdog = null;
    }
  }

  public pruneMemoryUsage() {
    try {
      if (this.bot) {
        // 1. Prune entity cache: keep self and other player entities within 48-block range
        if (this.bot.entities) {
          const selfId = this.bot.entity?.id;
          const botPos = this.bot.entity?.position;
          const keys = Object.keys(this.bot.entities);
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const ent = this.bot.entities[key];
            if (Number(key) !== selfId) {
              if (!ent || ent.type !== 'player') {
                delete this.bot.entities[key];
              } else if (botPos && ent.position) {
                const dx = ent.position.x - botPos.x;
                const dz = ent.position.z - botPos.z;
                if (dx * dx + dz * dz > 2304) {
                  delete this.bot.entities[key];
                }
              }
            }
          }
        }

        // 2. Prune distant world chunk columns (Prevents 100MB+ chunk cache memory leak over 12h)
        if (this.bot.world && (this.bot.world as any).columns) {
          const cols = (this.bot.world as any).columns;
          const botChunkX = Math.floor(this.position.x / 16);
          const botChunkZ = Math.floor(this.position.z / 16);
          const colKeys = Object.keys(cols);
          for (let i = 0; i < colKeys.length; i++) {
            const k = colKeys[i];
            const parts = k.split(',');
            if (parts.length === 2) {
              const cx = parseInt(parts[0], 10);
              const cz = parseInt(parts[1], 10);
              // Only retain immediate 2-chunk radius around bot
              if (Math.abs(cx - botChunkX) > 2 || Math.abs(cz - botChunkZ) > 2) {
                delete cols[k];
              }
            }
          }
        }

        // 3. Clear Mineflayer block and pathfinder cache
        if ((this.bot as any)._blocks) {
          (this.bot as any)._blocks = {};
        }

        if (this.bot.pathfinder && typeof this.bot.pathfinder.isMoving === 'function' && !this.bot.pathfinder.isMoving()) {
          try {
            if ((this.bot.pathfinder as any).astar) {
              (this.bot.pathfinder as any).astar = null;
            }
          } catch {}
        }
      }

      // 4. Cap chat history in RAM to preserve performance (100 recent messages)
      if (this.chatHistory.length > 120) {
        this.chatHistory = this.chatHistory.slice(-100);
      }
    } catch {
      // safe no-op
    }
  }

  public clearChatHistory(): void {
    this.chatHistory = [];
    this.emitUpdate();
  }

  private addLog(type: ChatMessage['type'], sender: string | undefined, text: string, formattedHtml?: string) {
    const log: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      timestamp: Date.now(),
      type,
      sender,
      text,
      formattedHtml: formattedHtml || minecraftFormatToHtml(text),
    };

    this.chatHistory.push(log);
    if (this.chatHistory.length > 200) {
      this.chatHistory.shift();
    }
    this.emit('chat', log);
    this.emitUpdate();
  }

  private emitUpdate() {
    this.emit('update', this.getState());
  }
}
