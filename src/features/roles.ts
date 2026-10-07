import { Composer, GrammyError, InlineKeyboard, type Context } from "grammy";
import {
  findRole,
  newRoleId,
  store,
  type ChatData,
  type Role,
  type RoleMember,
  type UserInfo,
} from "../store.js";
import { adminOnly, groupOnly, isAdmin, isGroup } from "../util/admin.js";
import { escapeHtml, mentionHtml, toUserInfo } from "../util/html.js";
import { log, warn } from "../util/log.js";

export const roles = new Composer();

const MAX_ROLES = 60;
const MAX_NAME_LENGTH = 24;
/** Telegram 成員標籤的上限（setChatMemberTag：0-16 字元，不能有 emoji） */
export const MAX_TAG_LENGTH = 16;
const TAG_SEPARATOR = "/";
/** 每則訊息最多 tag 幾個人；Telegram 對單則訊息的通知數量有限制，分批比較保險 */
const MENTIONS_PER_MESSAGE = 5;
const TAG_COOLDOWN_MS = 30_000;

const tagCooldown = new Map<string, number>();

/** 依新增順序排列（createdAt 相同時再比名稱，確保順序穩定） */
export function sortedRoles(chat: ChatData): Role[] {
  return Object.values(chat.roles).sort(
    (a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name, "zh-Hant"),
  );
}

function memberCount(role: Role): number {
  return Object.keys(role.members).length;
}

function panelText(chat: ChatData): string {
  const list = sortedRoles(chat);
  if (list.length === 0) {
    return "🏷 <b>身分組面板</b>\n目前還沒有任何身分組，管理員可以用 /role_add 名稱 新增。";
  }
  const lines = list.map((r) => {
    const desc = r.description ? ` — ${escapeHtml(r.description)}` : "";
    return `• <b>${escapeHtml(r.name)}</b>（${memberCount(r)} 人）${desc}`;
  });
  return [
    "🏷 <b>身分組面板</b>",
    "點下面的按鈕加入或退出身分組，再按一次就退出。",
    "",
    ...lines,
    "",
    "用 /my_roles 查看自己的身分組，/tag 名稱 可以一次通知整組的人。",
  ].join("\n");
}

function panelKeyboard(chat: ChatData): InlineKeyboard {
  const kb = new InlineKeyboard();
  sortedRoles(chat).forEach((r, i) => {
    kb.text(`${r.name} (${memberCount(r)})`, `r:${r.id}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

export function parseArgs(match: unknown): { name: string; rest: string } {
  const text = String(match ?? "").trim();
  const [name = "", ...rest] = text.split(/\s+/);
  return { name, rest: rest.join(" ") };
}

/**
 * 訊息開頭是「@身分組名稱」時視為呼叫，等同 /tag 名稱 訊息。
 * 只認開頭，避免句子中間提到 @某人 時誤觸。
 */
export function parseRoleCall(text: string): { name: string; rest: string } | undefined {
  const m = /^@(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  return { name: m[1], rest: (m[2] ?? "").trim() };
}

/** 把成員切成每則訊息最多 size 人 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function joinedAt(member: RoleMember): number {
  return member.joinedAt ?? member.lastSeen;
}

/** 某人所在的身分組，依他點擊加入的先後排序（同時加入時再比身分組新增順序） */
export function rolesOfUser(chat: ChatData, userId: number): Role[] {
  const key = String(userId);
  return Object.values(chat.roles)
    .filter((r) => r.members[key])
    .sort(
      (a, b) =>
        joinedAt(a.members[key]) - joinedAt(b.members[key]) || a.createdAt - b.createdAt,
    );
}

/** Telegram 標籤不接受 emoji，連同膚色修飾、變體選擇符、零寬連接符一起拿掉 */
export function stripEmoji(text: string): string {
  return text.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\u20E3]/gu, "").trim();
}

/** 以字元為單位截斷到 max 個 UTF-16 code unit，不會切在代理對中間 */
function truncate(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/**
 * 把身分組名稱串成 Telegram 成員標籤：依序用「/」接起來，塞不下的就省略；
 * 連第一個都塞不下時截斷第一個。沒有身分組回空字串（＝清除標籤）。
 */
export function buildMemberTag(names: string[]): string {
  let tag = "";
  for (const raw of names) {
    const name = stripEmoji(raw);
    if (!name) continue;
    const next = tag ? `${tag}${TAG_SEPARATOR}${name}` : name;
    if (next.length > MAX_TAG_LENGTH) {
      if (!tag) tag = truncate(name, MAX_TAG_LENGTH);
      break;
    }
    tag = next;
  }
  return tag;
}

type TagSyncResult = "ok" | "skipped" | "failed";

/**
 * 把某人目前的身分組寫到 Telegram 成員標籤。
 * 標籤只能設給一般成員：管理員、已離開的人會跳過；bot 沒有「管理標籤」權限時會失敗，記錄後不影響身分組功能。
 */
async function syncMemberTag(ctx: Context, chat: ChatData, userId: number): Promise<TagSyncResult> {
  const chatId = ctx.chat?.id;
  if (!chatId) return "skipped";
  const tag = buildMemberTag(rolesOfUser(chat, userId).map((r) => r.name));
  try {
    const member = await ctx.api.getChatMember(chatId, userId);
    if (member.status !== "member" && member.status !== "restricted") return "skipped";
    if ((member.tag ?? "") === tag) return "ok";
    await ctx.api.setChatMemberTag(chatId, userId, tag);
    log(ctx, `成員標籤 user ${userId} → ${tag ? `「${tag}」` : "（清除）"}`);
    return "ok";
  } catch (err) {
    warn(ctx, `更新成員標籤失敗（user ${userId}）`, err);
    return "failed";
  }
}

/** 批次同步時每人之間的間隔；Telegram 對 setChatMemberTag 限速頗嚴（約 25 次就會被擋），放慢可減少撞牆 */
const SYNC_PACE_MS = 1_500;

/** 依序更新多個人的標籤，回傳各結果的數量；paceMs 為每人之間的等待毫秒數 */
async function syncMemberTags(
  ctx: Context,
  chat: ChatData,
  userIds: Iterable<number>,
  paceMs = 0,
): Promise<Record<TagSyncResult, number>> {
  const count: Record<TagSyncResult, number> = { ok: 0, skipped: 0, failed: 0 };
  for (const id of userIds) {
    count[await syncMemberTag(ctx, chat, id)]++;
    if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
  }
  return count;
}

roles.command(
  "role_add",
  adminOnly(async (ctx) => {
    const chat = store.chat(ctx.chat!.id);
    const { name, rest: description } = parseArgs(ctx.match);
    if (!name) {
      await ctx.reply("用法：/role_add 名稱 [說明]\n例如：/role_add 桌遊 想揪桌遊的人");
      return;
    }
    if (name.length > MAX_NAME_LENGTH) {
      await ctx.reply(`名稱請在 ${MAX_NAME_LENGTH} 個字以內。`);
      return;
    }
    if (findRole(chat, name)) {
      await ctx.reply(`已經有「${name}」這個身分組了。`);
      return;
    }
    if (Object.keys(chat.roles).length >= MAX_ROLES) {
      await ctx.reply(`身分組數量已達上限（${MAX_ROLES}）。`);
      return;
    }
    const id = newRoleId(chat);
    chat.roles[id] = {
      id,
      name,
      description: description || undefined,
      createdAt: Date.now(),
      members: {},
    };
    store.save();
    log(ctx, `/role_add 新增「${name}」`);
    const tagHint =
      stripEmoji(name).length > MAX_TAG_LENGTH
        ? `\n⚠️ 名稱超過 ${MAX_TAG_LENGTH} 個字，顯示在成員標籤時會被截斷。`
        : "";
    await ctx.reply(`✅ 已新增身分組「${name}」。用 /roles 叫出面板讓大家加入。${tagHint}`);
  }),
);

roles.command(
  "role_del",
  adminOnly(async (ctx) => {
    const chat = store.chat(ctx.chat!.id);
    const { name } = parseArgs(ctx.match);
    const role = name ? findRole(chat, name) : undefined;
    if (!role) {
      await ctx.reply("用法：/role_del 名稱\n找不到這個身分組，用 /role_list 看看有哪些。");
      return;
    }
    delete chat.roles[role.id];
    store.save();
    const members = Object.values(role.members).map((m) => m.id);
    log(ctx, `/role_del 刪除「${role.name}」（原本 ${members.length} 人）`);
    await ctx.reply(
      `🗑 已刪除身分組「${role.name}」（原本 ${members.length} 人）。` +
        (members.length ? "\n正在把它從成員標籤上拿掉，完成後會再通知。" : ""),
    );
    if (members.length === 0) return;
    // 被刪掉的身分組要從成員標籤上拿掉；人多會被限速，放到背景慢慢跑
    void (async () => {
      try {
        const count = await syncMemberTags(ctx, chat, members, SYNC_PACE_MS);
        log(ctx, `/role_del「${role.name}」標籤更新 成功 ${count.ok}、跳過 ${count.skipped}、失敗 ${count.failed}`);
        const lines = [`🏷 已從 ${count.ok} 人的成員標籤移除「${role.name}」。`];
        if (count.failed) lines.push(`失敗 ${count.failed} 人，可以用 /role_sync_tags 補上。`);
        await ctx.reply(lines.join("\n"));
      } catch (err) {
        warn(ctx, `/role_del「${role.name}」標籤更新中斷`, err);
      }
    })();
  }),
);

roles.command(
  "role_sync_tags",
  adminOnly(async (ctx) => {
    const chat = store.chat(ctx.chat!.id);
    const userIds = new Set<number>();
    for (const role of Object.values(chat.roles)) {
      for (const m of Object.values(role.members)) userIds.add(m.id);
    }
    if (userIds.size === 0) {
      await ctx.reply("目前沒有任何人加入身分組，不用同步。");
      return;
    }
    await ctx.reply(`🏷 開始同步 ${userIds.size} 人的成員標籤，人多時 Telegram 會限速，請稍等，完成後會再通知。`);
    // 放到背景跑，碰到限速要等幾十秒時才不會卡住其他訊息
    void (async () => {
      try {
        const count = await syncMemberTags(ctx, chat, userIds, SYNC_PACE_MS);
        log(ctx, `/role_sync_tags 成功 ${count.ok}、跳過 ${count.skipped}、失敗 ${count.failed}`);
        const lines = [`🏷 成員標籤同步完成：${count.ok} 人已更新。`];
        if (count.skipped) {
          lines.push(`跳過 ${count.skipped} 人（管理員或已不在群組裡，標籤只能設給一般成員）。`);
        }
        if (count.failed) {
          lines.push(`失敗 ${count.failed} 人，請確認 bot 是管理員且有「管理標籤」權限，再執行一次即可補上。`);
        }
        await ctx.reply(lines.join("\n"));
      } catch (err) {
        warn(ctx, "/role_sync_tags 中斷", err);
      }
    })();
  }),
);

roles.command(
  "role_list",
  groupOnly(async (ctx) => {
    const chat = store.chat(ctx.chat!.id);
    const list = sortedRoles(chat);
    if (list.length === 0) {
      await ctx.reply("目前沒有任何身分組。");
      return;
    }
    const lines = list.map((r) => {
      const desc = r.description ? ` — ${escapeHtml(r.description)}` : "";
      return `• <b>${escapeHtml(r.name)}</b>（${memberCount(r)} 人）${desc}`;
    });
    await ctx.reply(`<b>身分組列表</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
  }),
);

roles.command(
  "roles",
  groupOnly(async (ctx) => {
    const chat = store.chat(ctx.chat!.id);
    await ctx.reply(panelText(chat), { parse_mode: "HTML", reply_markup: panelKeyboard(chat) });
  }),
);

roles.command(
  "my_roles",
  groupOnly(async (ctx) => {
    if (!ctx.from) return;
    const chat = store.chat(ctx.chat!.id);
    const mine = sortedRoles(chat).filter((r) => r.members[String(ctx.from!.id)]);
    const who = escapeHtml(ctx.from.first_name);
    if (mine.length === 0) {
      await ctx.reply(`${who} 目前沒有任何身分組，用 /roles 叫出面板來加入。`, {
        parse_mode: "HTML",
      });
      return;
    }
    await ctx.reply(
      `<b>${who}</b> 的身分組：\n${mine.map((r) => `• ${escapeHtml(r.name)}`).join("\n")}`,
      { parse_mode: "HTML" },
    );
  }),
);

roles.command(
  "role_members",
  groupOnly(async (ctx) => {
    const chat = store.chat(ctx.chat!.id);
    const { name } = parseArgs(ctx.match);
    const role = name ? findRole(chat, name) : undefined;
    if (!role) {
      await ctx.reply("用法：/role_members 名稱");
      return;
    }
    const members = Object.values(role.members);
    if (members.length === 0) {
      await ctx.reply(`「${role.name}」目前還沒有人。`);
      return;
    }
    const names = members
      .map((m) => store.user(m.id) ?? m)
      .map((m) => escapeHtml(m.firstName) + (m.username ? ` (@${m.username})` : ""));
    await ctx.reply(
      `<b>${escapeHtml(role.name)}</b>（${members.length} 人）\n${names.map((n) => `• ${n}`).join("\n")}`,
      { parse_mode: "HTML" },
    );
  }),
);

/** /tag 與「@身分組」共用的通知流程 */
async function tagRole(ctx: Context, role: Role, message: string): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  const chatId = ctx.chat.id;

  const cooldownKey = `${chatId}:${role.id}`;
  const last = tagCooldown.get(cooldownKey) ?? 0;
  if (Date.now() - last < TAG_COOLDOWN_MS && !(await isAdmin(ctx))) {
    const wait = Math.ceil((TAG_COOLDOWN_MS - (Date.now() - last)) / 1000);
    await ctx.reply(`「${role.name}」剛剛才被 tag 過，請 ${wait} 秒後再試。`);
    return;
  }

  const members: UserInfo[] = Object.values(role.members).map((m) => store.user(m.id) ?? m);
  if (members.length === 0) {
    await ctx.reply(`「${role.name}」目前還沒有人。`);
    return;
  }
  tagCooldown.set(cooldownKey, Date.now());

  const header =
    `📣 ${mentionHtml(ctx.from)} 呼叫 <b>#${escapeHtml(role.name)}</b>` +
    (message ? `：${escapeHtml(message)}` : "");

  const chunks = chunk(members.map(mentionHtml), MENTIONS_PER_MESSAGE);
  for (let i = 0; i < chunks.length; i++) {
    const body = chunks[i].join(" ");
    await ctx.reply(i === 0 ? `${header}\n${body}` : body, { parse_mode: "HTML" });
  }
  log(ctx, `tag「${role.name}」→ 通知 ${members.length} 人，分 ${chunks.length} 則${message ? `：${message}` : ""}`);
}

roles.command(
  "tag",
  groupOnly(async (ctx) => {
    const chat = store.chat(ctx.chat!.id);
    const { name, rest: message } = parseArgs(ctx.match);
    const role = name ? findRole(chat, name) : undefined;
    if (!role) {
      await ctx.reply("用法：/tag 身分組名稱 [要說的話]\n用 /role_list 看看有哪些身分組。");
      return;
    }
    await tagRole(ctx, role, message);
  }),
);

// 訊息開頭打「@身分組名稱」也能呼叫；名稱對不上就當一般訊息放行
roles.on("message:text", async (ctx, next) => {
  if (isGroup(ctx) && !ctx.from?.is_bot) {
    const call = parseRoleCall(ctx.msg.text);
    const role = call ? findRole(store.chat(ctx.chat.id), call.name) : undefined;
    if (role) {
      await tagRole(ctx, role, call!.rest);
      return;
    }
  }
  await next();
});

roles.callbackQuery(/^r:([a-z0-9]+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  const user = ctx.from;
  if (!chatId) {
    await ctx.answerCallbackQuery({ text: "這個面板已失效，請重新用 /roles 叫出。" });
    return;
  }
  const chat = store.chat(chatId);
  const role = chat.roles[ctx.match[1]];
  if (!role) {
    await ctx.answerCallbackQuery({ text: "這個身分組已經被刪除了。", show_alert: true });
    return;
  }

  const key = String(user.id);
  let text: string;
  if (role.members[key]) {
    delete role.members[key];
    text = `👋 已退出「${role.name}」`;
    log(ctx, `退出「${role.name}」（現 ${memberCount(role)} 人）`);
  } else {
    const now = Date.now();
    role.members[key] = { ...toUserInfo(user), lastSeen: now, joinedAt: now };
    text = `✅ 已加入「${role.name}」`;
    log(ctx, `加入「${role.name}」（現 ${memberCount(role)} 人）`);
  }
  store.save();
  await ctx.answerCallbackQuery({ text });
  await syncMemberTag(ctx, chat, user.id);

  try {
    await ctx.editMessageText(panelText(chat), {
      parse_mode: "HTML",
      reply_markup: panelKeyboard(chat),
    });
  } catch (err) {
    // 內容沒變（例如同時有人按）會丟 "message is not modified"，可以忽略
    if (!(err instanceof GrammyError && err.description.includes("not modified"))) {
      warn(ctx, "更新身分組面板失敗", err);
    }
  }
});
