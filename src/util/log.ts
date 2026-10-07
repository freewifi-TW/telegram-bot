import type { Context } from "grammy";
import { displayName } from "./html.js";

function time(): string {
  return new Date().toLocaleString("zh-TW", { hour12: false, timeZone: process.env.TZ || "Asia/Taipei" });
}

/** 「[群組名] @誰」前綴，私訊與找不到時退回 id */
export function where(ctx: Context): string {
  const chat = ctx.chat;
  const from = ctx.from;
  const title = !chat
    ? "?"
    : "title" in chat && chat.title
      ? chat.title
      : chat.type === "private"
        ? "私訊"
        : String(chat.id);
  const who = !from ? "?" : from.username ? `@${from.username}` : displayName(from);
  return `[${title}] ${who}`;
}

/** 一般操作記錄 */
export function log(ctx: Context, message: string): void {
  console.log(`${time()} ${where(ctx)} ${message}`);
}

/** 可預期的失敗，例如外部服務拒絕、權限不足 */
export function warn(ctx: Context, message: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err !== undefined ? String(err) : "";
  console.warn(`${time()} ${where(ctx)} ⚠️ ${message}${detail ? `：${detail}` : ""}`);
}
