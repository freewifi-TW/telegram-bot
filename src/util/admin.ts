import type { Context, MiddlewareFn } from "grammy";
import { config } from "../config.js";

const cache = new Map<string, { admin: boolean; expires: number }>();
const TTL = 60_000;

export async function isAdmin(ctx: Context): Promise<boolean> {
  const chat = ctx.chat;
  if (!chat || chat.type === "private") return false;
  // 匿名管理員：以群組身分發言
  if (ctx.senderChat && ctx.senderChat.id === chat.id) return true;
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (config.ownerIds.includes(userId)) return true;

  const key = `${chat.id}:${userId}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.admin;

  let admin = false;
  try {
    const member = await ctx.getChatMember(userId);
    admin = member.status === "creator" || member.status === "administrator";
  } catch (err) {
    console.warn("查詢管理員身分失敗：", err);
  }
  cache.set(key, { admin, expires: Date.now() + TTL });
  return admin;
}

export function isGroup(ctx: Context): boolean {
  const type = ctx.chat?.type;
  return type === "group" || type === "supergroup";
}

/** 限群組使用的指令 */
export function groupOnly(handler: MiddlewareFn<Context>): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (!isGroup(ctx)) {
      await ctx.reply("這個指令只能在群組裡使用。");
      return;
    }
    return handler(ctx, next);
  };
}

/** 限群組管理員使用的指令 */
export function adminOnly(handler: MiddlewareFn<Context>): MiddlewareFn<Context> {
  return groupOnly(async (ctx, next) => {
    if (!(await isAdmin(ctx))) {
      await ctx.reply("只有群組管理員可以使用這個指令。");
      return;
    }
    return handler(ctx, next);
  });
}
