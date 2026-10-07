import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, GrammyError, HttpError } from "grammy";
import type { BotCommand } from "grammy/types";
import { config } from "./config.js";
import { allowlist } from "./features/allowlist.js";
import { announce, broadcast, OFFLINE_TEXT, ONLINE_TEXT } from "./features/announce.js";
import { fixup } from "./features/fixup.js";
import { handleMemeStart, memes } from "./features/memes.js";
import { roles } from "./features/roles.js";
import { sauce } from "./features/sauce.js";
import { welcome } from "./features/welcome.js";
import { store } from "./store.js";
import { toUserInfo } from "./util/html.js";
import { where } from "./util/log.js";

const bot = new Bot(config.botToken);

// Telegram 回 429 時依它給的秒數等待後重試（例如一次設定很多人的成員標籤），
// 等太久的就放棄丟回錯誤，避免卡住
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 90 }));

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

// 群組白名單要放在最前面，不在名單內的群組與外人連使用者紀錄都不留
bot.use(allowlist);

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
  "加入的身分組會依加入順序顯示在你名字旁的成員標籤上",
  "",
  "🔍 <b>以圖搜圖</b>",
  "回覆圖片輸入 /source，會查 SauceNAO（Pixiv、Danbooru、e621、FurAffinity、Twitter）、e621 IQDB 與 Fluffle（FurAffinity、Twitter、Bluesky 等獸人圈站台）",
  "",
  "🔗 <b>連結修正</b>",
  "看到 x.com、pixiv、Bluesky、Instagram、TikTok、Reddit 連結會自動補上能正常預覽的版本",
  "",
  "📩 <b>梗圖私訊</b>",
  "群組開了禁止儲存時，梗圖區的附件下面會有「私訊給我」按鈕，按了 bot 就把原檔傳到你的私訊",
].join("\n");

bot.command(["start", "help"], async (ctx) => {
  // 從梗圖按鈕導過來的 /start 帶有參數，先補送梗圖
  if (await handleMemeStart(ctx)) return;
  await ctx.reply(HELP, { parse_mode: "HTML" });
});

bot.on("my_chat_member", (ctx) => {
  const { chat, new_chat_member } = ctx.myChatMember;
  const title = "title" in chat ? chat.title : chat.id;
  console.log(`群組「${title}」中的狀態變為 ${new_chat_member.status}`);
  if (chat.type === "group" || chat.type === "supergroup") {
    const data = store.chat(chat.id);
    const left = new_chat_member.status === "left" || new_chat_member.status === "kicked";
    if (data.left !== left) {
      data.left = left;
      store.save();
    }
  }
});

bot.use(welcome);
bot.use(announce);
bot.use(roles);
bot.use(memes);
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
  { command: "role_sync_tags", description: "把所有人的身分組寫進成員標籤" },
  { command: "welcome", description: "歡迎詞設定" },
  { command: "setwelcome", description: "設定歡迎詞內容" },
  { command: "welcome_topic", description: "把歡迎詞發到目前話題" },
  { command: "welcome_test", description: "測試歡迎詞" },
  { command: "fixup", description: "連結修正模式 reply/replace/off" },
  { command: "announce", description: "bot 上下線通知設定" },
  { command: "announce_topic", description: "把上下線通知發到目前話題" },
  { command: "meme_topic", description: "把目前話題設為梗圖區，附件下會有私訊按鈕" },
  { command: "meme_off", description: "關閉梗圖私訊按鈕" },
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
    // Docker 預設只給 10 秒，道別訊息最多等 6 秒，發不完就放棄
    await Promise.race([
      broadcast(bot.api, OFFLINE_TEXT),
      new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
    ]);
    await bot.stop();
    store.flush();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.start({
    allowed_updates: ["message", "callback_query", "chat_member", "my_chat_member"],
    onStart: (me) => {
      console.log(`✅ @${me.username} 已啟動（long polling）`);
      void broadcast(bot.api, ONLINE_TEXT);
    },
  });
}

main().catch((err) => {
  console.error("啟動失敗：", err);
  process.exit(1);
});
