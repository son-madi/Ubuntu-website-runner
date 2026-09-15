export type AuthType = 'offline' | 'microsoft';

export interface AntiAfkConfig {
  enabled: boolean;
  intervalSeconds: number;
  movementType: 'strafe_lr' | 'rotate_look' | 'jump_strafe' | 'full_routine';
  strafeDurationMs: number;
  swingArm: boolean;
  sneakWiggle: boolean;
}

export interface BotConfig {
  id: string;
  userId?: string;
  deviceId?: string;
  clientIp?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthType;
  password?: string;
  version?: string; // empty string or false = auto
  autoReconnect: boolean;
  reconnectDelaySeconds: number;
  onJoinCommand: string; // e.g. /login password or /register
  onJoinDelayMs: number; // e.g. 2000
  antiAfk: AntiAfkConfig;
  shouldRun?: boolean; // Persisted 24/7 run state across server/container restarts
  lastStartedAt?: number;
  plugins?: BotPluginsConfig;
}

export interface PvpSettings {
  detectionRange: number;
  weapon: 'sword' | 'axe' | 'bow' | 'auto';
  targetPriority: 'closest' | 'lowestHealth' | 'highestHealth';
  attackIntervalMs: number;
  dodgeProjectiles: boolean;
  useShield: boolean;
}

export interface AutoEatSettings {
  threshold: number;
  priority: 'saturation' | 'foodPoints';
  bannedFoods: string[];
}

export interface LocateSettings {
  targetBlock: string;
  searchRadius: number;
  autoMine: boolean;
}

export interface FarmerSettings {
  harvestCrops: boolean;
  replant: boolean;
  depositInChest: boolean;
}

export interface AutoMiningSettings {
  targetOres: string[];
  tunnelType: 'strip' | 'branch' | 'staircase';
  placeTorches: boolean;
}

export interface ChatAiSettings {
  personality: 'friendly' | 'helpful' | 'sarcastic' | 'professional';
  respondToMentionsOnly: boolean;
  memoryLimit: number;
}

export interface PathfindingSettings {
  allowDiagonal: boolean;
  avoidWater: boolean;
  sprint: boolean;
}

export interface BotPluginsConfig {
  inventorySync: boolean;
  inventoryControl: boolean;
  compassNavigation: boolean;
  collectDrops: boolean;
  locate: boolean;
  locateSettings?: LocateSettings;
  farmer: boolean;
  farmerSettings?: FarmerSettings;
  autoSleep: boolean;
  chatAi: boolean;
  chatAiSettings?: ChatAiSettings;
  pathfinding: boolean;
  pathfindingSettings?: PathfindingSettings;
  autoEat: boolean;
  autoEatSettings?: AutoEatSettings;
  guarding: boolean;
  autoMining: boolean;
  autoMiningSettings?: AutoMiningSettings;
  pvpMode: boolean;
  pvpSettings?: PvpSettings;
  keyboardCapture: boolean;
  followPlayer: boolean;
}

export type BotStatus = 'stopped' | 'starting' | 'online' | 'reconnecting' | 'error' | 'kicked';

export interface ChatMessage {
  id: string;
  timestamp: number;
  type: 'chat' | 'system' | 'whisper' | 'bot_sent' | 'action' | 'info' | 'error';
  sender?: string;
  text: string;
  rawJson?: string;
  formattedHtml?: string;
}

export interface BotState {
  id: string;
  config: BotConfig;
  status: BotStatus;
  health: number; // 0-20
  maxHealth: number;
  food: number; // 0-20
  saturation: number;
  experience: {
    level: number;
    points: number;
    progress: number;
  };
  position: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
  };
  dimension: string;
  gamemode: string;
  ping: number;
  onlineSince: number | null;
  uptimeSeconds: number;
  reconnectCount: number;
  nextReconnectIn: number | null;
  lastError: string | null;
  lastAfkActionTime: number | null;
  playersNearby: string[];
  chatHistory: ChatMessage[];
  inventory?: any[];
  quickBarSlot?: number;
}

export interface User {
  id: string;
  username: string;
  email: string;
  photoURL?: string;
  isAdmin?: boolean;
  isTester?: boolean;
  registrationIp?: string;
  deviceFingerprint?: string;
  createdAt: number;
}

export interface QuickLoginProfile {
  id: string;
  username: string;
  email: string;
  photoURL?: string;
  quickToken?: string;
  lastLoginTime: number;
  isAdmin?: boolean;
  isTester?: boolean;
}

export interface AdminAccountInfo {
  id: string;
  username: string;
  email: string;
  photoURL?: string;
  password?: string | null;
  isAdmin?: boolean;
  isTester?: boolean;
  registrationIp?: string;
  deviceFingerprint?: string;
  createdAt: number;
  botCount: number;
  bots: {
    id: string;
    name: string;
    username: string;
    host: string;
    port: number;
    status: BotStatus;
    uptimeSeconds: number;
  }[];
}

export interface SystemSettings {
  globalBotLimit: number;
}

export interface GlobalStats {
  totalBots: number;
  activeBots: number;
  reconnectingBots: number;
  stoppedBots: number;
  totalUptimeSeconds: number;
}

export interface PublicPlatformStats {
  activeBotsOnline: number;
}

export interface QuickCommandItem {
  id: string;
  label: string;
  cmd: string;
}

export interface BotDefaults {
  host: string;
  port: number;
  onJoinCommand: string;
  onJoinDelayMs: number;
  auth: AuthType;
  version: string;
  autoReconnect: boolean;
  reconnectDelaySeconds: number;
  antiAfk: AntiAfkConfig;
  quickCommands?: QuickCommandItem[];
}

export interface ChatReplyPreview {
  id: string;
  senderName: string;
  text?: string;
  hasImage?: boolean;
}

export interface GeneralChatMessage {
  id: string;
  userId: string;
  username: string;
  photoURL?: string;
  isAdmin?: boolean;
  isDev?: boolean;
  text?: string;
  imageUrl?: string;
  replyTo?: ChatReplyPreview;
  createdAt: number;
}

export interface ChatConfig {
  allowImageUploads: boolean;
}

