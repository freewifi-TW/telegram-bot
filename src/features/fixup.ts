import { Composer, type Context } from "grammy";
import type { Message, MessageEntity } from "grammy/types";
import { store, type FixupMode } from "../store.js";
import { adminOnly } from "../util/admin.js";
import { displayName, escapeHtml } from "../util/html.js";
import { log, warn } from "../util/log.js";

export const fixup = new Composer();

/**
 * 每條規則：比對原始連結，回傳可正常預覽的版本。
 * 正則都要帶 g 旗標（matchAll / replace 需要），尾端的 [^\s<>()]* 用來吃掉查詢字串。
 */
interface Rule {
  /** 顯示用 */
  site: string;
  re: RegExp;
  fix: (m: RegExpMatchArray) => string;
}

const TAIL = String.raw`[^\s<>()]*`;

export const RULES: Rule[] = [
  {
    site: "x.com / twitter.com",
    re: new RegExp(
      String.raw`https?://(?:www\.|mobile\.)?(?:x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com)/(i/web|[A-Za-z0-9_]{1,15})/status(?:es)?/(\d+)${TAIL}`,
      "gi",
    ),
    fix: (m) => `https://fixupx.com/${m[1].toLowerCase() === "i/web" ? "i" : m[1]}/status/${m[2]}`,
  },
  {
    site: "pixiv",
    re: new RegExp(
      String.raw`https?://(?:www\.)?pixiv\.net/(?:(?:[a-z]{2}/)?artworks/(\d+)|member_illust\.php\?[^\s<>()]*?illust_id=(\d+))${TAIL}`,
      "gi",
    ),
    fix: (m) => `https://phixiv.net/artworks/${m[1] ?? m[2]}`,
  },
  {
    site: "Bluesky",
    re: new RegExp(
      String.raw`https?://(?:www\.)?bsky\.app/profile/([^\s/<>()]+)/post/([A-Za-z0-9]+)${TAIL}`,
      "gi",
    ),
    fix: (m) => `https://fxbsky.app/profile/${m[1]}/post/${m[2]}`,
  },
  {
    site: "Instagram",
    re: new RegExp(
      String.raw`https?://(?:www\.)?instagram\.com/(?:[A-Za-z0-9_.]+/)?(p|reels?|tv)/([A-Za-z0-9_-]+)${TAIL}`,
      "gi",
    ),
    fix: (m) => `https://ddinstagram.com/${m[1].toLowerCase() === "reels" ? "reel" : m[1].toLowerCase()}/${m[2]}`,
  },
  {
    site: "TikTok",
    // 含 vm. / vt. 短網址，直接換域名、保留路徑
    re: new RegExp(String.raw`https?://((?:www\.|m\.|vm\.|vt\.)?)tiktok\.com/([^\s<>()?#]+)${TAIL}`, "gi"),
    fix: (m) => `https://${m[1]}vxtiktok.com/${m[2]}`,
  },
  {
    site: "Reddit",
    re: new RegExp(
      String.raw`https?://(?:www\.|old\.|new\.)?reddit\.com/(r/[^\s/<>()]+/comments/[A-Za-z0-9]+[^\s<>()?#]*)${TAIL}`,
      "gi",
    ),
    fix: (m) => `https://rxddit.com/${m[1]}`,
  },
];

/** 把文字裡所有能修正的連結換掉 */
export function fixText(text: string): string {
  let out = text;
  for (const rule of RULES) out = out.replace(rule.re, (...args) => rule.fix(args as unknown as RegExpMatchArray));
  return out;
}

/** 從訊息文字與 text_link entity 收集所有修正後的連結，去重並保持出現順序 */
export function collectLinks(text: string, entities: MessageEntity[] | undefined): string[] {
  const found = new Set<string>();
  const scan = (s: string) => {
    for (const rule of RULES) for (const m of s.matchAll(rule.re)) found.add(rule.fix(m));
  };
  scan(text);
  for (const e of entities ?? []) if (e.type === "text_link") scan(e.url);
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
    const author = `<b>${escapeHtml(displayName(ctx.from!))}</b>`;
    try {
      await ctx.api.deleteMessage(chat.id, msg.message_id);
      await ctx.reply(`${author}：\n${escapeHtml(fixText(msg.text!))}`, {
        parse_mode: "HTML",
        reply_parameters: replyTarget(msg),
      });
      log(ctx, `fixup（replace）${links.join(" ")}`);
      return;
    } catch (err) {
      warn(ctx, "刪除重發失敗，改用回覆模式", err);
    }
  }

  await ctx.reply(links.join("\n"), {
    reply_parameters: { message_id: msg.message_id },
    link_preview_options: { url: links[0] },
  });
  log(ctx, `fixup（reply）${links.join(" ")}`);
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
      reply: "回覆模式：看到可修正的連結時，回覆一則能正常預覽的版本",
      replace: "取代模式：刪除原訊息，由 bot 以原作者名義重發（bot 需要刪除訊息權限）",
      off: "關閉",
    };
    const sites = RULES.map((r) => r.site).join("、");
    await ctx.reply(
      `🔗 連結修正目前為 <b>${data.fixupMode}</b>\n${desc[data.fixupMode]}\n支援：${escapeHtml(sites)}`,
      { parse_mode: "HTML" },
    );
  }),
);

// 放在所有指令之後，只處理一般訊息
fixup.on("message", async (ctx, next) => {
  await handleMessage(ctx);
  await next();
});
