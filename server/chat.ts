import fs from 'fs';
import path from 'path';

export interface ReplyPreview {
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
  replyTo?: ReplyPreview;
  createdAt: number;
}

export interface ChatConfig {
  allowImageUploads: boolean;
}

const ROOT_DIR = process.cwd();
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
const CHAT_FILE = path.join(DATA_DIR, 'general_chat.json');
const CHAT_CONFIG_FILE = path.join(DATA_DIR, 'chat_config.json');
const LEGACY_CHAT_FILE = path.join(ROOT_DIR, 'general_chat.json');
const LEGACY_CHAT_CONFIG_FILE = path.join(ROOT_DIR, 'chat_config.json');

export class ChatManager {
  private messages: GeneralChatMessage[] = [];
  private config: ChatConfig = { allowImageUploads: true };
  private maxMessages = 1000;

  constructor() {
    this.ensureDataDir();
    this.loadMessages();
    this.loadConfig();
  }

  private ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      } catch (err) {
        console.error('Failed to create data directory for chat:', err);
      }
    }
  }

  private loadConfig() {
    try {
      const filesToTry = [CHAT_CONFIG_FILE, LEGACY_CHAT_CONFIG_FILE];
      for (const file of filesToTry) {
        if (fs.existsSync(file)) {
          const raw = fs.readFileSync(file, 'utf-8');
          this.config = { ...this.config, ...JSON.parse(raw) };
          break;
        }
      }
    } catch (err) {
      console.warn('Could not load chat config, using defaults:', err);
    }
  }

  private saveConfig() {
    try {
      this.ensureDataDir();
      fs.writeFileSync(CHAT_CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save chat config:', err);
    }
  }

  private loadMessages() {
    try {
      const filesToTry = [CHAT_FILE, LEGACY_CHAT_FILE];
      for (const file of filesToTry) {
        if (fs.existsSync(file)) {
          const raw = fs.readFileSync(file, 'utf-8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            this.messages = parsed;
            break;
          }
        }
      }
    } catch (err) {
      console.warn('Could not load chat messages, starting fresh:', err);
      this.messages = [];
    }
  }

  private saveMessages() {
    try {
      this.ensureDataDir();
      fs.writeFileSync(CHAT_FILE, JSON.stringify(this.messages, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save general chat messages:', err);
    }
  }

  public getConfig(): ChatConfig {
    return { ...this.config };
  }

  public setAllowImageUploads(allow: boolean): ChatConfig {
    this.config.allowImageUploads = !!allow;
    this.saveConfig();
    return this.getConfig();
  }

  public getMessages(limit = 150): GeneralChatMessage[] {
    if (this.messages.length <= limit) {
      return [...this.messages];
    }
    return this.messages.slice(this.messages.length - limit);
  }

  public addMessage(
    user: { id: string; username: string; photoURL?: string; isAdmin?: boolean },
    payload: { text?: string; imageUrl?: string; replyTo?: ReplyPreview }
  ): GeneralChatMessage {
    const text = (payload.text || '').trim();
    const imageUrl = payload.imageUrl ? payload.imageUrl.trim() : undefined;

    if (!text && !imageUrl) {
      throw new Error('Message must have either text content or an image');
    }

    if (imageUrl && !this.config.allowImageUploads && !user.isAdmin) {
      throw new Error('Image sending is currently disabled by administrators');
    }

    // Dev badge: if admin, mark isDev = true
    const isDev = !!user.isAdmin || user.username.toLowerCase() === 'shifin';

    const msg: GeneralChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      userId: user.id,
      username: user.username,
      photoURL: user.photoURL,
      isAdmin: !!user.isAdmin,
      isDev,
      text: text ? text.substring(0, 2000) : undefined,
      imageUrl,
      replyTo: payload.replyTo ? {
        id: payload.replyTo.id,
        senderName: payload.replyTo.senderName,
        text: payload.replyTo.text ? payload.replyTo.text.substring(0, 120) : undefined,
        hasImage: !!payload.replyTo.hasImage,
      } : undefined,
      createdAt: Date.now(),
    };

    this.messages.push(msg);

    // Keep within reasonable bounds
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(this.messages.length - this.maxMessages);
    }

    this.saveMessages();
    return msg;
  }

  public deleteMessage(messageId: string, requestingUser: { id: string; isAdmin?: boolean }): boolean {
    const idx = this.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;

    const msg = this.messages[idx];
    if (!requestingUser.isAdmin && msg.userId !== requestingUser.id) {
      throw new Error('You do not have permission to delete this message');
    }

    this.messages.splice(idx, 1);
    this.saveMessages();
    return true;
  }

  public clearAllMessages(): void {
    this.messages = [];
    this.saveMessages();
  }

  public shutdown(): void {
    try {
      this.saveMessages();
      this.saveConfig();
    } catch (err) {
      console.error('Error saving chat data on shutdown:', err);
    }
  }
}
