import { Composer, GrammyError, InlineKeyboard, InputFile, type Api, type Context } from "grammy";
import type { Message } from "grammy/types";
import { config } from "../config.js";
import { store, type ChatData, type MemeEntry, type MemeFile } from "../store.js";
import { adminOnly, isGroup } from "../util/admin.js";
import { log, warn } from "../util/log.js";

/**
 * 梗圖區「私訊給我」：群組開了禁止儲存內容時，成員沒辦法下載圖片，
 * bot 就在指定話題的每則附件下面掛一個按鈕，按了把原檔私訊給他。
 */
export const memes = new Composer();

/** 每個群組最多記住幾則，超過就丟掉最舊的 */
export const MAX_ENTRIES = 500;
/** 相簿的每張圖是獨立訊息，等這麼久把同一組收齊後只回一則 */
const ALBUM_WAIT_MS = 1_500;
const BUTTON_TEXT = "📩 私訊給我";
const START_PREFIX = "m_";

/** 從訊息取出可以重送的附件；animation 訊息同時帶 document，要先判斷 */
export function extractFile(msg: Message): MemeFile | undefined {
  if (msg.photo?.length) return { kind: "photo", fileId: msg.photo[msg.photo.length - 1].file_id };
  if (msg.video) return { kind: "video", fileId: msg.video.file_id };
  if (msg.animation) return { kind: "animation", fileId: msg.animation.file_id };
  if (msg.document) {
    return { kind: "document", fileId: msg.document.file_id, fileName: msg.document.file_name };
  }
  return undefined;
}

/** 只保留最新的 MAX_ENTRIES 則 */
export function pruneMemes(memes: Record<string, MemeEntry>, max = MAX_ENTRIES): void {
  const keys = Object.keys(memes);
  if (keys.length <= max) return;
  keys
    .sort((a, b) => memes[a].at - memes[b].at)
    .slice(0, keys.length - max)
    .forEach((k) => delete memes[k]);
}

/** /start 的參數：m_<群組 id>_<訊息 id> */
export function startPayload(chatId: number, messageId: number): string {
  return `${START_PREFIX}${chatId}_${messageId}`;
}

export function parseStartPayload(payload: string): { chatId: number; messageId: number } | undefined {
  const m = /^m_(-?\d+)_(\d+)$/.exec(payload.trim());
  if (!m) return undefined;
  return { chatId: Number(m[1]), messageId: Number(m[2]) };
}

/** 這則訊息是否在設定的梗圖區裡 */
function inMemeTopic(chat: ChatData, msg: Message): boolean {
  if (!chat.meme.enabled) return false;
  const threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
  return threadId === chat.meme.threadId;
}

async function sendButton(ctx: Context, chatId: number, messageId: number, count: number): Promise<void> {
  const text = count > 1 ? `想收藏這 ${count} 個檔案的話按一下 👇` : "想收藏的話按一下 👇";
  await ctx.api.sendMessage(chatId, text, {
    reply_parameters: { message_id: messageId },
    reply_markup: new InlineKeyboard().text(BUTTON_TEXT, `m:${messageId}`),
  });
}

function remember(chat: ChatData, messageId: number, entry: MemeEntry): void {
  chat.memes[String(messageId)] = entry;
  pruneMemes(chat.memes);
  store.save();
}

interface PendingAlbum {
  firstMessageId: number;
  entry: MemeEntry;
  timer: NodeJS.Timeout;
}
const pendingAlbums = new Map<string, PendingAlbum>();

memes.on("message", async (ctx, next) => {
  const msg = ctx.msg;
  if (!isGroup(ctx) || !ctx.from || ctx.from.id === ctx.me.id) return next();
  const chatId = ctx.chat.id;
  const chat = store.chat(chatId);
  if (!inMemeTopic(chat, msg)) return next();
  const file = extractFile(msg);
  if (!file) return next();

  if (msg.media_group_id) {
    const key = `${chatId}:${msg.media_group_id}`;
    const pending = pendingAlbums.get(key);
    if (pending) {
      pending.entry.files.push(file);
      pending.entry.caption ??= msg.caption;
    } else {
      const entry: MemeEntry = { files: [file], caption: msg.caption, at: Date.now() };
      const timer = setTimeout(() => {
        pendingAlbums.delete(key);
        remember(chat, msg.message_id, entry);
        sendButton(ctx, chatId, msg.message_id, entry.files.length).catch((err) =>
          warn(ctx, "梗圖按鈕發送失敗", err),
        );
      }, ALBUM_WAIT_MS);
      pendingAlbums.set(key, { firstMessageId: msg.message_id, entry, timer });
    }
  } else {
    remember(chat, msg.message_id, { files: [file], caption: msg.caption, at: Date.now() });
    try {
      await sendButton(ctx, chatId, msg.message_id, 1);
    } catch (err) {
      warn(ctx, "梗圖按鈕發送失敗", err);
    }
  }
  return next();
});

function sendFile(
  api: Api,
  to: number,
  kind: MemeFile["kind"],
  file: string | InputFile,
  caption?: string,
): Promise<unknown> {
  const opts = caption ? { caption } : {};
  switch (kind) {
    case "photo":
      return api.sendPhoto(to, file, opts);
    case "video":
      return api.sendVideo(to, file, opts);
    case "animation":
      return api.sendAnimation(to, file, opts);
    case "document":
      return api.sendDocument(to, file, opts);
  }
}

async function download(api: Api, fileId: string): Promise<Uint8Array> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram 沒有回傳檔案路徑");
  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`下載失敗（HTTP ${res.status}）`);
  return new Uint8Array(await res.arrayBuffer());
}

/** 把一則紀錄的所有檔案私訊給 userId；對方沒跟 bot 說過話會丟 403 */
async function deliver(api: Api, userId: number, entry: MemeEntry): Promise<void> {
  for (let i = 0; i < entry.files.length; i++) {
    const f = entry.files[i];
    const caption = i === 0 ? entry.caption : undefined;
    try {
      await sendFile(api, userId, f.kind, f.fileId, caption);
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 403) throw err;
      // 用 file_id 重送失敗（例如受保護內容不給重用），下載後重新上傳
      const bytes = await download(api, f.fileId);
      await sendFile(api, userId, f.kind, new InputFile(bytes, f.fileName), caption);
    }
  }
}

function notStarted(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 403;
}

memes.callbackQuery(/^m:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.answerCallbackQuery({ text: "這個按鈕已失效。" });
    return;
  }
  const messageId = Number(ctx.match[1]);
  const entry = store.chat(chatId).memes[String(messageId)];
  if (!entry) {
    await ctx.answerCallbackQuery({ text: "這則太久了，bot 已經沒有它的檔案紀錄。", show_alert: true });
    return;
  }
  try {
    await deliver(ctx.api, ctx.from.id, entry);
    await ctx.answerCallbackQuery({ text: "📩 已私訊給你！" });
    log(ctx, `梗圖 #${messageId} 私訊成功（${entry.files.length} 個檔案）`);
  } catch (err) {
    if (notStarted(err)) {
      // 還沒跟 bot 私訊過，開啟 bot 讓他按 Start，帶參數回來自動補送
      await ctx.answerCallbackQuery({
        url: `https://t.me/${ctx.me.username}?start=${startPayload(chatId, messageId)}`,
      });
      log(ctx, `梗圖 #${messageId} 對方尚未私訊過 bot，導向 Start`);
      return;
    }
    warn(ctx, `梗圖 #${messageId} 私訊失敗`, err);
    await ctx.answerCallbackQuery({ text: "傳送失敗，請稍後再試。", show_alert: true });
  }
});

/**
 * 私訊 /start m_<群組>_<訊息> 時補送梗圖。回傳 true 表示已處理。
 * 會先確認對方真的在那個群組裡，避免拿到連結的外人也能領。
 */
export async function handleMemeStart(ctx: Context): Promise<boolean> {
  if (ctx.chat?.type !== "private" || !ctx.from) return false;
  const target = parseStartPayload(String(ctx.match ?? ""));
  if (!target) return false;
  const entry = store.chat(target.chatId).memes[String(target.messageId)];
  if (!entry) {
    await ctx.reply("找不到這則梗圖的紀錄，可能太久了。請回群組重新按一次按鈕。");
    return true;
  }
  try {
    const member = await ctx.api.getChatMember(target.chatId, ctx.from.id);
    const inChat =
      member.status === "creator" ||
      member.status === "administrator" ||
      member.status === "member" ||
      (member.status === "restricted" && member.is_member);
    if (!inChat) {
      await ctx.reply("你不在那個群組裡，沒辦法領取。");
      return true;
    }
    await deliver(ctx.api, ctx.from.id, entry);
    log(ctx, `梗圖 #${target.messageId} 經 /start 補送成功（${entry.files.length} 個檔案）`);
  } catch (err) {
    warn(ctx, `梗圖 #${target.messageId} 經 /start 補送失敗`, err);
    await ctx.reply("傳送失敗，請回群組再按一次按鈕試試。");
  }
  return true;
}

memes.command(
  "meme_topic",
  adminOnly(async (ctx) => {
    const chat = store.chat(ctx.chat!.id);
    const msg = ctx.msg!;
    chat.meme.threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
    chat.meme.enabled = true;
    store.save();
    const where = chat.meme.threadId ? `這個話題（#${chat.meme.threadId}）` : "General";
    log(ctx, `/meme_topic → ${where}`);
    await ctx.reply(
      `✅ 之後${where}裡的圖片、影片、GIF 和檔案下面都會出現「${BUTTON_TEXT}」按鈕。\n用 /meme_off 可以關閉。`,
    );
  }),
);

memes.command(
  "meme_off",
  adminOnly(async (ctx) => {
    const chat = store.chat(ctx.chat!.id);
    chat.meme.enabled = false;
    store.save();
    log(ctx, "/meme_off");
    await ctx.reply("⛔ 已關閉梗圖「私訊給我」按鈕。");
  }),
);
