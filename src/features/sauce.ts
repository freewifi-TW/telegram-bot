import { Composer, type Context } from "grammy";
import type { Message } from "grammy/types";
import { config } from "../config.js";
import { escapeHtml } from "../util/html.js";

export const sauce = new Composer();

interface Hit {
  /** 0–100 */
  similarity: number;
  source: string;
  label: string;
  url?: string;
}

const SAUCENAO_DB_E621 = 29;
const SAUCENAO_DB_TWITTER = 41;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function pickImage(msg: Message | undefined): { fileId: string; name: string } | undefined {
  if (!msg) return undefined;
  if (msg.photo?.length) {
    return { fileId: msg.photo[msg.photo.length - 1].file_id, name: "image.jpg" };
  }
  if (msg.document?.mime_type?.startsWith("image/")) {
    return { fileId: msg.document.file_id, name: msg.document.file_name ?? "image" };
  }
  if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) {
    return { fileId: msg.sticker.file_id, name: "sticker.webp" };
  }
  // 影片類訊息沒辦法直接搜，改用 Telegram 附的縮圖（約 320px 的 JPEG）
  const thumb =
    msg.video?.thumbnail ??
    msg.animation?.thumbnail ??
    msg.video_note?.thumbnail ??
    (msg.sticker?.is_video ? msg.sticker.thumbnail : undefined) ??
    (msg.document?.mime_type?.startsWith("video/") ? msg.document.thumbnail : undefined);
  if (thumb) {
    return { fileId: thumb.file_id, name: "thumbnail.jpg" };
  }
  return undefined;
}

async function downloadTelegramFile(ctx: Context, fileId: string): Promise<ArrayBuffer> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram 沒有回傳檔案路徑");
  if (file.file_size && file.file_size > MAX_IMAGE_BYTES) throw new Error("圖片超過 20MB");
  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`下載圖片失敗（HTTP ${res.status}）`);
  return await res.arrayBuffer();
}

interface SauceNaoResponse {
  header?: { status?: number; message?: string; long_remaining?: number; short_remaining?: number };
  results?: Array<{
    header: { similarity: string; index_id: number; index_name: string };
    data: Record<string, unknown> & { ext_urls?: string[] };
  }>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

async function searchSauceNao(image: ArrayBuffer, filename: string): Promise<Hit[]> {
  const form = new FormData();
  form.append("output_type", "2");
  form.append("numres", "8");
  if (config.sauceNao.apiKey) form.append("api_key", config.sauceNao.apiKey);
  form.append("dbs[]", String(SAUCENAO_DB_E621));
  form.append("dbs[]", String(SAUCENAO_DB_TWITTER));
  form.append("file", new Blob([image]), filename);

  const res = await fetch("https://saucenao.com/search.php", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) throw new Error("SauceNAO 搜尋額度已用完，請稍後再試");
  if (!res.ok) throw new Error(`SauceNAO 回應 HTTP ${res.status}`);

  const json = (await res.json()) as SauceNaoResponse;
  const status = json.header?.status ?? 0;
  if (status < 0) throw new Error(json.header?.message ?? `SauceNAO 錯誤（${status}）`);

  const hits: Hit[] = [];
  for (const r of json.results ?? []) {
    const similarity = Number.parseFloat(r.header.similarity);
    if (!Number.isFinite(similarity) || similarity < config.sauceNao.minSimilarity) continue;
    const d = r.data;
    const url = d.ext_urls?.[0];
    let label: string;
    if (r.header.index_id === SAUCENAO_DB_TWITTER) {
      label = str(d.twitter_user_handle) ? `@${str(d.twitter_user_handle)}` : "Twitter";
    } else if (r.header.index_id === SAUCENAO_DB_E621) {
      const parts = [str(d.creator) && `作者 ${str(d.creator)}`, str(d.characters)].filter(Boolean);
      label = parts.length ? parts.join("・") : "e621";
    } else {
      label = str(d.title) ?? str(d.source) ?? str(d.creator) ?? str(d.author_name) ?? r.header.index_name;
    }
    hits.push({ similarity, source: r.header.index_name.replace(/\s*-.*$/, ""), label, url });
  }
  return hits.sort((a, b) => b.similarity - a.similarity);
}

async function searchE621(image: ArrayBuffer, filename: string): Promise<Hit[]> {
  const form = new FormData();
  form.append("file", new Blob([image]), filename);
  const headers: Record<string, string> = { "User-Agent": config.e621.userAgent };
  if (config.e621.login && config.e621.apiKey) {
    headers.Authorization = `Basic ${Buffer.from(`${config.e621.login}:${config.e621.apiKey}`).toString("base64")}`;
  }
  const res = await fetch("https://e621.net/iqdb_queries.json", {
    method: "POST",
    body: form,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) throw new Error("e621 要求太頻繁，請稍後再試");
  if (res.status === 401 || res.status === 403) throw new Error("e621 拒絕存取，請檢查 User-Agent 或帳號設定");
  if (!res.ok) throw new Error(`e621 回應 HTTP ${res.status}`);

  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) return [];
  const hits: Hit[] = [];
  for (const m of json as Array<Record<string, any>>) {
    const postId: unknown = m.post_id ?? m.post?.posts?.id ?? m.post?.id;
    const score = Number(m.score);
    if (typeof postId !== "number" || !Number.isFinite(score)) continue;
    if (score < config.sauceNao.minSimilarity) continue;
    hits.push({
      similarity: score,
      source: "e621",
      label: `#${postId}`,
      url: `https://e621.net/posts/${postId}`,
    });
  }
  return hits.sort((a, b) => b.similarity - a.similarity);
}

function formatHits(title: string, hits: Hit[]): string {
  if (hits.length === 0) return `<b>${title}</b>\n　沒有相似結果`;
  const lines = hits.slice(0, 5).map((h) => {
    const head = `　• ${h.similarity.toFixed(1)}%　${escapeHtml(h.source)}　${escapeHtml(h.label)}`;
    return h.url ? `${head}\n　　${escapeHtml(h.url)}` : head;
  });
  return `<b>${title}</b>\n${lines.join("\n")}`;
}

sauce.command(["source", "sauce", "search", "搜圖"], async (ctx) => {
  const msg = ctx.msg;
  const target = pickImage(msg) ?? pickImage(msg.reply_to_message);
  if (!target) {
    await ctx.reply(
      "請回覆一張圖片、貼圖或影片再輸入 /source，或是在傳圖片時把 /source 當成說明文字。",
    );
    return;
  }

  const status = await ctx.reply("🔍 搜尋中，請稍候…", {
    reply_parameters: { message_id: msg.message_id },
  });

  let image: ArrayBuffer;
  try {
    image = await downloadTelegramFile(ctx, target.fileId);
  } catch (err) {
    await ctx.api.editMessageText(status.chat.id, status.message_id, `❌ ${(err as Error).message}`);
    return;
  }

  const [nao, e6] = await Promise.allSettled([
    searchSauceNao(image, target.name),
    searchE621(image, target.name),
  ]);

  const sections = [
    nao.status === "fulfilled"
      ? formatHits("SauceNAO（Twitter / e621）", nao.value)
      : `<b>SauceNAO</b>\n　⚠️ ${escapeHtml((nao.reason as Error).message)}`,
    e6.status === "fulfilled"
      ? formatHits("e621 IQDB", e6.value)
      : `<b>e621 IQDB</b>\n　⚠️ ${escapeHtml((e6.reason as Error).message)}`,
  ];

  await ctx.api.editMessageText(
    status.chat.id,
    status.message_id,
    `🔍 <b>搜圖結果</b>\n\n${sections.join("\n\n")}`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
});
