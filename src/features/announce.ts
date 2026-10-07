import { Composer, type Api } from "grammy";
import { store } from "../store.js";
import { adminOnly, groupOnly } from "../util/admin.js";
import { log } from "../util/log.js";

export const announce = new Composer();

export const ONLINE_TEXT = "我回來囉汪汪";
export const OFFLINE_TEXT = "暫時下線維修囉汪汪";

/** 對所有開啟通知的群組發同一句話；失敗的群組只記 log，不中斷其他群組 */
export async function broadcast(api: Api, text: string): Promise<void> {
  const targets = store.chatIds().filter((id) => {
    const c = store.chat(id);
    return c.announce.enabled && !c.left;
  });
  const results = await Promise.allSettled(
    targets.map((chatId) =>
      api.sendMessage(chatId, text, { message_thread_id: store.chat(chatId).announce.threadId }),
    ),
  );
  let ok = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      ok++;
      return;
    }
    const chat = store.chat(targets[i]);
    const reason = (r.reason as Error)?.message ?? String(r.reason);
    console.warn(`[${chat.title ?? targets[i]}] 上下線通知發送失敗：`, reason);
    // 被踢出或群組不存在：記下來，之後不再嘗試
    if (/kicked|chat not found|bot is not a member|CHAT_WRITE_FORBIDDEN/i.test(reason)) {
      chat.left = true;
      store.save();
    }
  });
  console.log(`上下線通知「${text}」→ ${ok}/${targets.length} 個群組`);
}

announce.command(
  "announce",
  groupOnly(async (ctx) => {
    const a = store.chat(ctx.chat!.id).announce;
    await ctx.reply(
      [
        "<b>上下線通知設定</b>",
        `狀態：${a.enabled ? "✅ 開啟" : "⛔ 關閉"}`,
        `發送位置：${a.threadId ? `話題 #${a.threadId}` : "General（預設）"}`,
        `下線時：${OFFLINE_TEXT}`,
        `上線時：${ONLINE_TEXT}`,
        "",
        "管理員指令：",
        "/announce_topic — 在想要發通知的話題裡執行，之後就發到那裡",
        "/announce_on、/announce_off — 開關通知",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  }),
);

announce.command(
  "announce_topic",
  adminOnly(async (ctx) => {
    const a = store.chat(ctx.chat!.id).announce;
    const msg = ctx.msg!;
    a.threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
    store.save();
    log(ctx, `/announce_topic → ${a.threadId ? `話題 #${a.threadId}` : "General"}`);
    await ctx.reply(
      a.threadId ? `✅ 之後上下線通知會發在這個話題（#${a.threadId}）。` : "✅ 之後上下線通知會發在 General。",
    );
  }),
);

announce.command(
  "announce_on",
  adminOnly(async (ctx) => {
    store.chat(ctx.chat!.id).announce.enabled = true;
    store.save();
    log(ctx, "/announce_on");
    await ctx.reply("✅ 上下線通知已開啟。");
  }),
);

announce.command(
  "announce_off",
  adminOnly(async (ctx) => {
    store.chat(ctx.chat!.id).announce.enabled = false;
    store.save();
    log(ctx, "/announce_off");
    await ctx.reply("⛔ 上下線通知已關閉。");
  }),
);
