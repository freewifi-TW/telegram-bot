import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../test-setup.js";
import type { Message } from "grammy/types";
import type { MemeEntry } from "../store.js";
import { extractFile, parseStartPayload, pruneMemes, startPayload } from "./memes.js";

function msg(partial: Partial<Message>): Message {
  return { message_id: 1, date: 0, chat: { id: -1, type: "supergroup", title: "t" }, ...partial } as Message;
}

describe("extractFile", () => {
  it("照片取最大尺寸", () => {
    const m = msg({ photo: [{ file_id: "s", file_unique_id: "s", width: 1, height: 1 }, { file_id: "L", file_unique_id: "L", width: 9, height: 9 }] });
    assert.deepEqual(extractFile(m), { kind: "photo", fileId: "L" });
  });
  it("GIF 訊息同時帶 document，要當 animation", () => {
    const m = msg({
      animation: { file_id: "a", file_unique_id: "a", width: 1, height: 1, duration: 1 },
      document: { file_id: "d", file_unique_id: "d" },
    });
    assert.equal(extractFile(m)?.kind, "animation");
  });
  it("document 保留檔名", () => {
    const m = msg({ document: { file_id: "d", file_unique_id: "d", file_name: "meme.png" } });
    assert.deepEqual(extractFile(m), { kind: "document", fileId: "d", fileName: "meme.png" });
  });
  it("純文字沒有附件", () => {
    assert.equal(extractFile(msg({ text: "hi" })), undefined);
  });
});

describe("pruneMemes", () => {
  it("超過上限時丟掉最舊的", () => {
    const memes: Record<string, MemeEntry> = {
      a: { files: [], at: 300 },
      b: { files: [], at: 100 },
      c: { files: [], at: 200 },
    };
    pruneMemes(memes, 2);
    assert.deepEqual(Object.keys(memes).sort(), ["a", "c"]);
  });
  it("沒超過就不動", () => {
    const memes: Record<string, MemeEntry> = { a: { files: [], at: 1 } };
    pruneMemes(memes, 5);
    assert.deepEqual(Object.keys(memes), ["a"]);
  });
});

describe("start payload", () => {
  it("來回轉換，群組 id 是負數也可以", () => {
    const p = startPayload(-1004310827326, 42);
    assert.equal(p, "m_-1004310827326_42");
    assert.deepEqual(parseStartPayload(p), { chatId: -1004310827326, messageId: 42 });
  });
  it("格式不對回 undefined", () => {
    assert.equal(parseStartPayload(""), undefined);
    assert.equal(parseStartPayload("hello"), undefined);
    assert.equal(parseStartPayload("m_abc_1"), undefined);
  });
});
