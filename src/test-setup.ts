/**
 * 測試共用的環境設定。要在任何會載入 config / store 的模組之前 import，
 * 讓 store 讀寫暫存目錄而不是真正的 data/bot.json。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BOT_TOKEN ||= "0:test";
process.env.DATA_FILE ||= join(mkdtempSync(join(tmpdir(), "machinechubbybot-test-")), "bot.json");
process.env.DATA_BACKUP_KEEP ||= "0";
