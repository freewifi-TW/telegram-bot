import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

export interface UserInfo {
  id: number;
  username?: string;
  firstName: string;
  lastSeen: number;
}

export interface Role {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  /** key 為 user id 字串 */
  members: Record<string, UserInfo>;
}

export interface WelcomeSettings {
  enabled: boolean;
  text: string;
  /** 要發送歡迎詞的話題 ID；undefined 表示 General */
  threadId?: number;
}

export type FixupMode = "reply" | "replace" | "off";

export interface ChatData {
  title?: string;
  welcome: WelcomeSettings;
  roles: Record<string, Role>;
  fixupMode: FixupMode;
}

interface Data {
  chats: Record<string, ChatData>;
  users: Record<string, UserInfo>;
}

export const DEFAULT_WELCOME =
  "歡迎 {mention} 加入 {group}！\n請先看一下置頂的群規，再到對應的話題聊天喔 🎉";

function defaultChat(): ChatData {
  return {
    welcome: { enabled: true, text: DEFAULT_WELCOME },
    roles: {},
    fixupMode: "reply",
  };
}

class Store {
  private data: Data = { chats: {}, users: {} };
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly path: string) {
    this.load();
  }

  private load() {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Data>;
      this.data = { chats: raw.chats ?? {}, users: raw.users ?? {} };
      for (const chat of Object.values(this.data.chats)) {
        const base = defaultChat();
        chat.welcome = { ...base.welcome, ...(chat.welcome ?? {}) };
        chat.roles ??= {};
        chat.fixupMode ??= base.fixupMode;
      }
    } catch (err) {
      console.error(`讀取資料檔 ${this.path} 失敗，將以空白資料啟動：`, err);
    }
  }

  chat(chatId: number): ChatData {
    const key = String(chatId);
    let chat = this.data.chats[key];
    if (!chat) {
      chat = defaultChat();
      this.data.chats[key] = chat;
      this.save();
    }
    return chat;
  }

  user(userId: number): UserInfo | undefined {
    return this.data.users[String(userId)];
  }

  touchUser(info: Omit<UserInfo, "lastSeen">) {
    const key = String(info.id);
    const prev = this.data.users[key];
    if (
      prev &&
      prev.username === info.username &&
      prev.firstName === info.firstName &&
      Date.now() - prev.lastSeen < 60_000
    ) {
      return;
    }
    this.data.users[key] = { ...info, lastSeen: Date.now() };
    this.save();
  }

  /** 延遲 500ms 批次寫入，避免連續操作一直寫檔 */
  save() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 500);
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tmp, this.path);
    } catch (err) {
      console.error("寫入資料檔失敗：", err);
      this.dirty = true;
    }
  }
}

export const store = new Store(config.dataFile);

export function findRole(chat: ChatData, name: string): Role | undefined {
  const needle = name.trim().toLowerCase();
  return Object.values(chat.roles).find((r) => r.name.toLowerCase() === needle);
}

export function newRoleId(chat: ChatData): string {
  let id: string;
  do {
    id = Math.random().toString(36).slice(2, 8);
  } while (chat.roles[id]);
  return id;
}
