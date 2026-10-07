import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import "./test-setup.js";
import { DEFAULT_WELCOME, Store } from "./store.js";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "mcb-store-")), "bot.json");
}

describe("Store 讀寫", () => {
  it("flush 後重新載入，資料一致", () => {
    const path = tempFile();
    const s1 = new Store(path);
    const chat = s1.chat(-100);
    chat.title = "測試群";
    chat.roles.r1 = { id: "r1", name: "桌遊", createdAt: 1, members: {} };
    s1.flush();
    assert.ok(existsSync(path));
    assert.ok(!existsSync(`${path}.tmp`), "暫存檔應該已改名");

    const s2 = new Store(path);
    const loaded = s2.chat(-100);
    assert.equal(loaded.title, "測試群");
    assert.equal(loaded.roles.r1?.name, "桌遊");
    assert.equal(loaded.welcome.text, DEFAULT_WELCOME);
    assert.equal(loaded.fixupMode, "reply");
  });

  it("舊版資料檔缺欄位時補上預設值", () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ chats: { "-1": { roles: {} } } }), "utf8");
    const s = new Store(path);
    const chat = s.chat(-1);
    assert.equal(chat.welcome.enabled, true);
    assert.equal(chat.fixupMode, "reply");
  });

  it("資料檔壞掉時以空白資料啟動而不是崩潰", () => {
    const path = tempFile();
    writeFileSync(path, "{not json", "utf8");
    const origError = console.error;
    console.error = () => {};
    try {
      const s = new Store(path);
      assert.equal(s.user(1), undefined);
    } finally {
      console.error = origError;
    }
  });

  it("touchUser 更新名稱", () => {
    const s = new Store(tempFile());
    s.touchUser({ id: 7, firstName: "A", username: "a" });
    s.touchUser({ id: 7, firstName: "B", username: "b" });
    assert.equal(s.user(7)?.firstName, "B");
    assert.equal(s.user(7)?.username, "b");
  });
});

describe("Store 每日備份", () => {
  it("backupKeep 為 0 時不備份", () => {
    const path = tempFile();
    const s = new Store(path);
    s.chat(-1);
    s.flush();
    s.save();
    s.flush();
    assert.ok(!existsSync(s.backupDir));
  });

  it("每天只備份一次，備份內容是寫入前的版本", () => {
    const path = tempFile();
    let now = new Date(2026, 0, 1, 10);
    const s = new Store(path, 3, () => now);
    s.chat(-1).title = "v1";
    s.save();
    s.flush(); // 檔案還不存在，沒東西可備份
    assert.deepEqual(s.listBackups(), []);

    s.chat(-1).title = "v2";
    s.save();
    s.flush(); // 第一次有既存檔案：備份 v1
    assert.deepEqual(s.listBackups(), ["bot-2026-01-01.json"]);
    const backup = JSON.parse(readFileSync(join(s.backupDir, "bot-2026-01-01.json"), "utf8"));
    assert.equal(backup.chats["-1"].title, "v1");

    s.chat(-1).title = "v3";
    s.save();
    s.flush(); // 同一天不再備份
    assert.deepEqual(s.listBackups(), ["bot-2026-01-01.json"]);

    now = new Date(2026, 0, 2, 10);
    s.chat(-1).title = "v4";
    s.save();
    s.flush();
    assert.deepEqual(s.listBackups(), ["bot-2026-01-02.json", "bot-2026-01-01.json"]);
  });

  it("超過保留份數時刪掉最舊的", () => {
    const path = tempFile();
    let now = new Date(2026, 0, 1);
    const s = new Store(path, 2, () => now);
    for (let day = 1; day <= 5; day++) {
      now = new Date(2026, 0, day);
      s.chat(-1).title = `day${day}`;
      s.save();
      s.flush();
    }
    assert.deepEqual(s.listBackups(), ["bot-2026-01-05.json", "bot-2026-01-04.json"]);
    assert.equal(readdirSync(s.backupDir).length, 2);
  });

  it("啟動時若當天尚未備份就先備份一份", () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ chats: {}, users: {} }), "utf8");
    const s = new Store(path, 7, () => new Date(2026, 5, 15));
    assert.deepEqual(s.listBackups(), ["bot-2026-06-15.json"]);
  });
});
