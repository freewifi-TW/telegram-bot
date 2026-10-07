import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { config } from "./config.js";

export interface UserInfo {
  id: number;
  username?: string;
  firstName: string;
  lastSeen: number;
}

export interface RoleMember extends UserInfo {
  /** 加入這個身分組的時間；舊資料沒有這個欄位，以 lastSeen 代替（舊版加入時只寫 lastSeen） */
  joinedAt?: number;
}

export interface Role {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  /** key 為 user id 字串 */
  members: Record<string, RoleMember>;
}

export interface WelcomeSettings {
  enabled: boolean;
  text: string;
  /** 要發送歡迎詞的話題 ID；undefined 表示 General */
  threadId?: number;
}

export type FixupMode = "reply" | "replace" | "off";

export interface AnnounceSettings {
  /** bot 上下線時是否在這個群組發通知 */
  enabled: boolean;
  /** 要發到的話題 ID；undefined 表示 General */
  threadId?: number;
}

export interface ChatData {
  title?: string;
  /** bot 已離開或被踢出這個群組；設定保留，重新加入時自動清除 */
  left?: boolean;
  welcome: WelcomeSettings;
  roles: Record<string, Role>;
  fixupMode: FixupMode;
  announce: AnnounceSettings;
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
    announce: { enabled: true },
  };
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class Store {
  private data: Data = { chats: {}, users: {} };
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  /**
   * @param path 資料檔路徑
   * @param backupKeep 每日備份保留份數，0 表示不備份
   * @param clock 取得現在時間，測試用
   */
  constructor(
    private readonly path: string,
    private readonly backupKeep = 0,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.load();
    this.backupIfNeeded();
  }

  /** 備份目錄：資料檔旁邊的 backups/ */
  get backupDir(): string {
    return join(dirname(this.path), "backups");
  }

  private get backupBase(): string {
    return basename(this.path, extname(this.path));
  }

  /** 列出現有備份檔名，新的在前 */
  listBackups(): string[] {
    if (!existsSync(this.backupDir)) return [];
    const re = new RegExp(`^${this.backupBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}-\\d{2}-\\d{2}\\.json$`);
    return readdirSync(this.backupDir)
      .filter((f) => re.test(f))
      .sort()
      .reverse();
  }

  /**
   * 每天第一次寫檔前，把目前磁碟上的資料檔複製一份到 backups/，
   * 檔名帶日期，超過保留份數的舊備份會刪掉。
   */
  backupIfNeeded() {
    if (this.backupKeep <= 0 || !existsSync(this.path)) return;
    const name = `${this.backupBase}-${localDate(this.clock())}.json`;
    const target = join(this.backupDir, name);
    if (existsSync(target)) return;
    try {
      mkdirSync(this.backupDir, { recursive: true });
      copyFileSync(this.path, target);
      for (const old of this.listBackups().slice(this.backupKeep)) {
        unlinkSync(join(this.backupDir, old));
      }
    } catch (err) {
      console.error("備份資料檔失敗：", err);
    }
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
        chat.announce = { ...base.announce, ...(chat.announce ?? {}) };
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

  /** 所有看過的群組 id */
  chatIds(): number[] {
    return Object.keys(this.data.chats).map(Number);
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
    this.backupIfNeeded();
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

export const store = new Store(config.dataFile, config.dataBackupKeep);

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
