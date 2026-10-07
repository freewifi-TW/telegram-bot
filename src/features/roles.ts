import { Composer, GrammyError, InlineKeyboard, type Context } from "grammy";
import { findRole, newRoleId, store, type ChatData, type Role, type UserInfo } from "../store.js";
import { adminOnly, groupOnly, isAdmin, isGroup } from "../util/admin.js";
import { escapeHtml, mentionHtml, toUserInfo } from "../util/html.js";

export const roles = new Composer();

const MAX_ROLES = 60;
const MAX_NAME_LENGTH = 24;
/** 每則訊息最多 tag 幾個人；Telegram 對單則訊息的通知數量有限制，分批比較保險 */
const MENTIONS_PER_MESSAGE = 5;
const TAG_COOLDOWN_MS = 30_000;

const tagCooldown = new Map<string, number>();

function sortedRoles(chat: ChatData): Role[] {
  return Object.values(chat.roles).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
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
    await ctx.reply(`✅ 已新增身分組「${name}」。用 /roles 叫出面板讓大家加入。`);
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
    await ctx.reply(`🗑 已刪除身分組「${role.name}」（原本 ${memberCount(role)} 人）。`);
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
  } else {
    role.members[key] = { ...toUserInfo(user), lastSeen: Date.now() };
    text = `✅ 已加入「${role.name}」`;
  }
  store.save();
  await ctx.answerCallbackQuery({ text });

  try {
    await ctx.editMessageText(panelText(chat), {
      parse_mode: "HTML",
      reply_markup: panelKeyboard(chat),
    });
  } catch (err) {
    // 內容沒變（例如同時有人按）會丟 "message is not modified"，可以忽略
    if (!(err instanceof GrammyError && err.description.includes("not modified"))) {
      console.warn("更新身分組面板失敗：", err);
    }
  }
});
