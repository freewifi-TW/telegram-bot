import { Composer, type Context } from "grammy";
import type { Message, MessageEntity } from "grammy/types";
import { store, type FixupMode } from "../store.js";
import { adminOnly } from "../util/admin.js";
import { displayName, escapeHtml } from "../util/html.js";

export const fixup = new Composer();

const TARGET_HOST = "fixupx.com";

/**
 * 比對 x.com / twitter.com 的推文連結，連同後面的查詢字串一起吃掉，
 * 例如 https://x.com/user/status/123?s=20&t=abc
 */
const LINK_RE =
  /https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com)\/(i\/web|[A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)[^\s<>()]*/gi;

function toFixed(handle: string, id: string): string {
  const user = handle.toLowerCase() === "i/web" ? "i" : handle;
  return `https://${TARGET_HOST}/${user}/status/${id}`;
}

function collectLinks(text: string, entities: MessageEntity[] | undefined): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(LINK_RE)) found.add(toFixed(m[1], m[2]));
  for (const e of entities ?? []) {
    if (e.type !== "text_link") continue;
    for (const m of e.url.matchAll(LINK_RE)) found.add(toFixed(m[1], m[2]));
  }
  return [...found];
}

function replyTarget(msg: Message): { message_id: number } | undefined {
  const replied = msg.reply_to_message;
  // 在話題裡，每則訊息的 reply_to_message 都會指向話題的根訊息，那不算真正的回覆
  if (!replied || replied.message_id === msg.message_thread_id) return undefined;
  return { message_id: replied.message_id };
}

async function handleMessage(ctx: Context): Promise<void> {
  const msg = ctx.msg;
  const chat = ctx.chat;
  if (!msg || !chat || chat.type === "private") return;
  if (ctx.from?.is_bot) return;

  const text = msg.text ?? msg.caption;
  if (!text) return;
  const mode = store.chat(chat.id).fixupMode;
  if (mode === "off") return;

  const links = collectLinks(text, msg.entities ?? msg.caption_entities);
  if (links.length === 0) return;

  // 只有純文字訊息、且連結都是明文時才能安全地「刪除重發」
  const canReplace = mode === "replace" && msg.text !== undefined && ctx.from;
  if (canReplace) {
    const replaced = msg.text!.replace(LINK_RE, (_, handle: string, id: string) => toFixed(handle, id));
    const author = `<b>${escapeHtml(displayName(ctx.from!))}</b>`;
    try {
      await ctx.api.deleteMessage(chat.id, msg.message_id);
      await ctx.reply(`${author}：\n${escapeHtml(replaced)}`, {
        parse_mode: "HTML",
        reply_parameters: replyTarget(msg),
      });
      return;
    } catch (err) {
      console.warn("刪除重發失敗，改用回覆模式：", err);
    }
  }

  await ctx.reply(links.join("\n"), {
    reply_parameters: { message_id: msg.message_id },
    link_preview_options: { url: links[0] },
  });
}

fixup.command(
  "fixup",
  adminOnly(async (ctx) => {
    const data = store.chat(ctx.chat!.id);
    const arg = String(ctx.match ?? "")
      .trim()
      .toLowerCase();
    const modes: FixupMode[] = ["reply", "replace", "off"];
    if (modes.includes(arg as FixupMode)) {
      data.fixupMode = arg as FixupMode;
      store.save();
    } else if (arg) {
      await ctx.reply("用法：/fixup reply | replace | off");
      return;
    }
    const desc: Record<FixupMode, string> = {
      reply: "回覆模式：看到 x.com / twitter.com 連結時，回覆一則 fixupx.com 連結",
      replace: "取代模式：刪除原訊息，由 bot 以原作者名義重發（bot 需要刪除訊息權限）",
      off: "關閉",
    };
    await ctx.reply(`🔗 連結修正目前為 <b>${data.fixupMode}</b>\n${desc[data.fixupMode]}`, {
      parse_mode: "HTML",
    });
  }),
);

// 放在所有指令之後，只處理一般訊息
fixup.on("message", async (ctx, next) => {
  await handleMessage(ctx);
  await next();
});
