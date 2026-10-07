import { Composer, type Context } from "grammy";
import type { ChatMember, User } from "grammy/types";
import { DEFAULT_WELCOME, store } from "../store.js";
import { adminOnly, groupOnly } from "../util/admin.js";
import { displayName, escapeHtml, mentionHtml } from "../util/html.js";

export const welcome = new Composer();

/** 避免 chat_member 與 new_chat_members 兩種更新對同一人重複發歡迎詞 */
const recentlyWelcomed = new Map<string, number>();
const DEDUP_WINDOW = 2 * 60_000;

function renderWelcome(template: string, user: User, groupTitle: string, html: boolean): string {
  const name = displayName(user);
  const values: Record<string, string> = html
    ? {
        mention: mentionHtml(user),
        name: escapeHtml(name),
        username: user.username ? `@${user.username}` : escapeHtml(name),
        group: escapeHtml(groupTitle),
      }
    : {
        mention: user.username ? `@${user.username}` : name,
        name,
        username: user.username ? `@${user.username}` : name,
        group: groupTitle,
      };
  return template.replace(/\{(mention|name|username|group)\}/g, (_, key: string) => values[key] ?? "");
}

function isInChat(member: ChatMember): boolean {
  switch (member.status) {
    case "member":
    case "administrator":
    case "creator":
      return true;
    case "restricted":
      return member.is_member;
    default:
      return false;
  }
}

async function sendWelcome(ctx: Context, user: User): Promise<void> {
  const chat = ctx.chat;
  if (!chat || user.is_bot) return;
  const data = store.chat(chat.id);
  if (!data.welcome.enabled) return;

  const key = `${chat.id}:${user.id}`;
  const now = Date.now();
  if ((recentlyWelcomed.get(key) ?? 0) > now - DEDUP_WINDOW) return;
  recentlyWelcomed.set(key, now);
  for (const [k, t] of recentlyWelcomed) if (t < now - DEDUP_WINDOW) recentlyWelcomed.delete(k);

  const title = ("title" in chat && chat.title) || data.title || "本群";
  const base = { message_thread_id: data.welcome.threadId };
  try {
    await ctx.api.sendMessage(chat.id, renderWelcome(data.welcome.text, user, title, true), {
      ...base,
      parse_mode: "HTML",
    });
  } catch (err) {
    // 多半是管理員設定的歡迎詞含有不合法的 HTML，退回純文字
    console.warn("HTML 歡迎詞發送失敗，改用純文字：", err);
    await ctx.api.sendMessage(chat.id, renderWelcome(data.welcome.text, user, title, false), base);
  }
}

// 方式一：bot 為管理員時會收到 chat_member 更新（最可靠，連隱藏加入訊息時也有效）
welcome.on("chat_member", async (ctx) => {
  const { old_chat_member: before, new_chat_member: after } = ctx.chatMember;
  if (!isInChat(before) && isInChat(after)) {
    await sendWelcome(ctx, after.user);
  }
});

// 方式二：一般的「XXX 加入群組」服務訊息
welcome.on("message:new_chat_members", async (ctx) => {
  for (const user of ctx.msg.new_chat_members) {
    await sendWelcome(ctx, user);
  }
});

welcome.command(
  "welcome",
  groupOnly(async (ctx) => {
    const data = store.chat(ctx.chat!.id);
    const w = data.welcome;
    await ctx.reply(
      [
        `<b>歡迎詞設定</b>`,
        `狀態：${w.enabled ? "✅ 開啟" : "⛔ 關閉"}`,
        `發送位置：${w.threadId ? `話題 #${w.threadId}` : "General（預設）"}`,
        `目前內容：`,
        `<code>${escapeHtml(w.text)}</code>`,
        ``,
        `管理員指令：`,
        `/setwelcome 文字 — 設定歡迎詞（也可回覆一則訊息來套用它的內容）`,
        `/welcome_topic — 在想要發歡迎詞的話題裡執行，之後就發到那裡`,
        `/welcome_on、/welcome_off — 開關歡迎詞`,
        `/welcome_test — 用自己測試一次`,
        ``,
        `可用變數：{mention} 會通知新成員、{name} 名字、{username}、{group} 群組名稱。`,
        `文字支援 HTML 標籤，例如 &lt;b&gt;粗體&lt;/b&gt;。`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  }),
);

welcome.command(
  "setwelcome",
  adminOnly(async (ctx) => {
    const data = store.chat(ctx.chat!.id);
    const arg = String(ctx.match ?? "").trim();
    const replied = ctx.msg?.reply_to_message;
    const text = arg || replied?.text || replied?.caption || "";
    if (!text) {
      await ctx.reply(
        `請在指令後面接上歡迎詞內容，或回覆一則訊息。\n例如：/setwelcome ${DEFAULT_WELCOME.split("\n")[0]}`,
      );
      return;
    }
    data.welcome.text = text;
    data.welcome.enabled = true;
    store.save();
    await ctx.reply("✅ 歡迎詞已更新，用 /welcome_test 看效果。");
  }),
);

welcome.command(
  "welcome_topic",
  adminOnly(async (ctx) => {
    const data = store.chat(ctx.chat!.id);
    const msg = ctx.msg!;
    data.welcome.threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
    store.save();
    await ctx.reply(
      data.welcome.threadId
        ? `✅ 之後歡迎詞會發在這個話題（#${data.welcome.threadId}）。`
        : "✅ 之後歡迎詞會發在 General。",
    );
  }),
);

welcome.command(
  "welcome_on",
  adminOnly(async (ctx) => {
    store.chat(ctx.chat!.id).welcome.enabled = true;
    store.save();
    await ctx.reply("✅ 歡迎詞已開啟。");
  }),
);

welcome.command(
  "welcome_off",
  adminOnly(async (ctx) => {
    store.chat(ctx.chat!.id).welcome.enabled = false;
    store.save();
    await ctx.reply("⛔ 歡迎詞已關閉。");
  }),
);

welcome.command(
  "welcome_test",
  adminOnly(async (ctx) => {
    if (!ctx.from) return;
    recentlyWelcomed.delete(`${ctx.chat!.id}:${ctx.from.id}`);
    const data = store.chat(ctx.chat!.id);
    const wasEnabled = data.welcome.enabled;
    data.welcome.enabled = true;
    try {
      await sendWelcome(ctx, ctx.from);
    } finally {
      data.welcome.enabled = wasEnabled;
    }
  }),
);
