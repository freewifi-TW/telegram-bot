import { Bot, GrammyError, HttpError } from "grammy";
import type { BotCommand } from "grammy/types";
import { config } from "./config.js";
import { fixup } from "./features/fixup.js";
import { roles } from "./features/roles.js";
import { sauce } from "./features/sauce.js";
import { welcome } from "./features/welcome.js";
import { store } from "./store.js";
import { toUserInfo } from "./util/html.js";
import { where } from "./util/log.js";

const bot = new Bot(config.botToken);

bot.catch(({ error, ctx }) => {
  const prefix = `${where(ctx)} update ${ctx.update.update_id}`;
  if (error instanceof GrammyError) {
    console.error(`${prefix} Telegram API 錯誤：`, error.description);
  } else if (error instanceof HttpError) {
    console.error(`${prefix} 無法連線到 Telegram：`, error);
  } else {
    console.error(`${prefix} 未預期的錯誤：`, error);
  }
});

// 記錄使用者最新的名稱與 username（tag 時才會是最新的），以及群組名稱
bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) store.touchUser(toUserInfo(ctx.from));
  const chat = ctx.chat;
  if (chat && (chat.type === "group" || chat.type === "supergroup")) {
    const data = store.chat(chat.id);
    if (data.title !== chat.title) {
      data.title = chat.title;
      store.save();
    }
  }
  await next();
});

const HELP = [
  "<b>這個 bot 可以做的事</b>",
  "",
  "🏷 <b>身分組</b>",
  "/roles — 叫出身分組面板，按按鈕加入或退出",
  "/my_roles — 看自己有哪些身分組",
  "/role_list — 所有身分組與人數",
  "/role_members 名稱 — 某身分組有誰",
  "/tag 名稱 [訊息] — 一次通知整個身分組，訊息開頭打 @名稱 也可以",
  "",
  "🔍 <b>以圖搜圖</b>",
  "回覆圖片輸入 /source，會查 SauceNAO（Twitter、e621）與 e621 IQDB",
  "",
  "🔗 <b>連結修正</b>",
  "看到 x.com、pixiv、Bluesky、Instagram、TikTok、Reddit 連結會自動補上能正常預覽的版本",
].join("\n");

bot.command(["start", "help"], (ctx) => ctx.reply(HELP, { parse_mode: "HTML" }));

bot.on("my_chat_member", (ctx) => {
  const { chat, new_chat_member } = ctx.myChatMember;
  const title = "title" in chat ? chat.title : chat.id;
  console.log(`群組「${title}」中的狀態變為 ${new_chat_member.status}`);
});

bot.use(welcome);
bot.use(roles);
bot.use(sauce);
// fixup 會監聽所有訊息，放最後確保指令先被處理
bot.use(fixup);

const groupCommands: BotCommand[] = [
  { command: "roles", description: "身分組面板" },
  { command: "my_roles", description: "我的身分組" },
  { command: "role_list", description: "所有身分組" },
  { command: "role_members", description: "某身分組有誰" },
  { command: "tag", description: "通知整個身分組：/tag 名稱 訊息" },
  { command: "source", description: "回覆圖片以圖搜圖" },
  { command: "help", description: "使用說明" },
];

const adminCommands: BotCommand[] = [
  ...groupCommands,
  { command: "role_add", description: "新增身分組：/role_add 名稱 說明" },
  { command: "role_del", description: "刪除身分組" },
  { command: "welcome", description: "歡迎詞設定" },
  { command: "setwelcome", description: "設定歡迎詞內容" },
  { command: "welcome_topic", description: "把歡迎詞發到目前話題" },
  { command: "welcome_test", description: "測試歡迎詞" },
  { command: "fixup", description: "連結修正模式 reply/replace/off" },
];

async function main() {
  await bot.api.setMyCommands(groupCommands, { scope: { type: "all_group_chats" } });
  await bot.api.setMyCommands(adminCommands, { scope: { type: "all_chat_administrators" } });
  await bot.api.setMyCommands(
    [
      { command: "help", description: "使用說明" },
      { command: "source", description: "回覆圖片以圖搜圖" },
    ],
    { scope: { type: "all_private_chats" } },
  );

  const shutdown = async (signal: string) => {
    console.log(`收到 ${signal}，正在關閉…`);
    await bot.stop();
    store.flush();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.start({
    allowed_updates: ["message", "callback_query", "chat_member", "my_chat_member"],
    onStart: (me) => console.log(`✅ @${me.username} 已啟動（long polling）`),
  });
}

main().catch((err) => {
  console.error("啟動失敗：", err);
  process.exit(1);
});
