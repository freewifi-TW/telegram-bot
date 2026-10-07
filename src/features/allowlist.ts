import { Composer, type Context } from "grammy";
import { config } from "../config.js";
import { store } from "../store.js";
import { log, warn } from "../util/log.js";

/**
 * 群組白名單：設定 ALLOWED_CHAT_IDS 後，bot 只在這些群組運作，
 * 被拉進其他群組會留言後自動退出；私訊只回應白名單群組的成員與 OWNER_IDS。
 * 沒設定時不做任何限制。
 */
export const allowlist = new Composer();

const DECLINE_TEXT = "這個 bot 只服務特定群組，不開放其他群組使用，先告辭了 🐾";
const PRIVATE_DECLINE_TEXT = "這個 bot 只服務特定群組的成員喔。";

/** 私訊使用者的會員資格快取，避免每則訊息都問 Telegram */
const memberCache = new Map<number, { allowed: boolean; expires: number }>();
const MEMBER_TTL = 10 * 60_000;
/** 拒絕訊息每人最多多久回一次，免得被洗 */
const declineCooldown = new Map<number, number>();
const DECLINE_TTL = 10 * 60_000;

export function isAllowedChat(chatId: number, allowed: number[] = config.allowedChatIds): boolean {
  return allowed.length === 0 || allowed.includes(chatId);
}

async function isMemberOfAllowedGroup(ctx: Context, userId: number): Promise<boolean> {
  if (config.ownerIds.includes(userId)) return true;
  const hit = memberCache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.allowed;

  let allowed = false;
  for (const chatId of config.allowedChatIds) {
    try {
      const m = await ctx.api.getChatMember(chatId, userId);
      if (
        m.status === "creator" ||
        m.status === "administrator" ||
        m.status === "member" ||
        (m.status === "restricted" && m.is_member)
      ) {
        allowed = true;
        break;
      }
    } catch (err) {
      warn(ctx, `查詢 ${chatId} 的成員資格失敗`, err);
    }
  }
  memberCache.set(userId, { allowed, expires: Date.now() + MEMBER_TTL });
  return allowed;
}

async function leaveUnlistedGroup(ctx: Context, chatId: number): Promise<void> {
  const data = store.chat(chatId);
  if (data.left) return; // 已經退出過，剩下的更新直接忽略
  data.left = true;
  store.save();
  log(ctx, `不在白名單內，退出群組 ${chatId}`);
  try {
    await ctx.api.sendMessage(chatId, DECLINE_TEXT);
  } catch {
    // 可能沒有發言權限，不影響退出
  }
  try {
    await ctx.api.leaveChat(chatId);
  } catch (err) {
    warn(ctx, "退出群組失敗", err);
  }
}

allowlist.use(async (ctx, next) => {
  if (config.allowedChatIds.length === 0) return next();
  const chat = ctx.chat;
  if (!chat) return next();

  if (chat.type === "group" || chat.type === "supergroup") {
    if (isAllowedChat(chat.id)) return next();
    // bot 自己被踢或離開的通知不用再處理
    const mine = ctx.myChatMember?.new_chat_member.status;
    if (mine === "left" || mine === "kicked") return;
    await leaveUnlistedGroup(ctx, chat.id);
    return;
  }

  if (chat.type === "private" && ctx.from) {
    if (await isMemberOfAllowedGroup(ctx, ctx.from.id)) return next();
    const last = declineCooldown.get(ctx.from.id) ?? 0;
    if (Date.now() - last > DECLINE_TTL) {
      declineCooldown.set(ctx.from.id, Date.now());
      log(ctx, "私訊者不是白名單群組成員，已拒絕");
      await ctx.reply(PRIVATE_DECLINE_TEXT);
    }
    return;
  }

  // 頻道等其他類型一律不理
});
