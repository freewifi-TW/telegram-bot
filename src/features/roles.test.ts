import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../test-setup.js";
import { findRole, type ChatData } from "../store.js";
import { buildMemberTag, chunk, parseArgs, parseRoleCall, rolesOfUser, sortedRoles } from "./roles.js";

describe("sortedRoles", () => {
  it("依新增順序，不受名稱影響", () => {
    const chat: ChatData = {
      welcome: { enabled: true, text: "" },
      fixupMode: "reply", announce: { enabled: true }, meme: { enabled: false }, memes: {},
      roles: {
        c: { id: "c", name: "A最後建", createdAt: 300, members: {} },
        a: { id: "a", name: "Z最先建", createdAt: 100, members: {} },
        b: { id: "b", name: "M中間建", createdAt: 200, members: {} },
      },
    };
    assert.deepEqual(
      sortedRoles(chat).map((r) => r.id),
      ["a", "b", "c"],
    );
  });
});

describe("parseArgs", () => {
  it("第一個字是名稱，其餘是訊息", () => {
    assert.deepEqual(parseArgs("桌遊 今晚八點  有人嗎"), { name: "桌遊", rest: "今晚八點 有人嗎" });
  });
  it("只有名稱時訊息為空字串", () => {
    assert.deepEqual(parseArgs("  桌遊  "), { name: "桌遊", rest: "" });
  });
  it("空輸入", () => {
    assert.deepEqual(parseArgs(undefined), { name: "", rest: "" });
  });
});

describe("parseRoleCall", () => {
  it("開頭 @名稱 加訊息", () => {
    assert.deepEqual(parseRoleCall("@桌遊 今晚八點"), { name: "桌遊", rest: "今晚八點" });
  });
  it("只有 @名稱", () => {
    assert.deepEqual(parseRoleCall("@桌遊"), { name: "桌遊", rest: "" });
  });
  it("多行訊息整段保留", () => {
    assert.deepEqual(parseRoleCall("@桌遊 第一行\n第二行"), { name: "桌遊", rest: "第一行\n第二行" });
  });
  it("@ 不在開頭就不算", () => {
    assert.equal(parseRoleCall("今晚 @桌遊 有人嗎"), undefined);
  });
  it("一般文字不算", () => {
    assert.equal(parseRoleCall("哈囉"), undefined);
    assert.equal(parseRoleCall("@"), undefined);
  });
});

describe("chunk", () => {
  it("每組最多 size 個，最後一組可以不滿", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]]);
  });
  it("空陣列回空", () => {
    assert.deepEqual(chunk([], 5), []);
  });
});

describe("findRole", () => {
  const chat: ChatData = {
    welcome: { enabled: true, text: "" },
    fixupMode: "reply", announce: { enabled: true }, meme: { enabled: false }, memes: {},
    roles: {
      a1: { id: "a1", name: "桌遊", createdAt: 0, members: {} },
      b2: { id: "b2", name: "Movie", createdAt: 0, members: {} },
    },
  };
  it("名稱完全相符", () => {
    assert.equal(findRole(chat, "桌遊")?.id, "a1");
  });
  it("英文不分大小寫、忽略前後空白", () => {
    assert.equal(findRole(chat, "  movie ")?.id, "b2");
  });
  it("找不到回 undefined", () => {
    assert.equal(findRole(chat, "電影"), undefined);
  });
});

describe("rolesOfUser", () => {
  it("依該成員加入的先後排序，與身分組新增順序無關", () => {
    const chat: ChatData = {
      welcome: { enabled: true, text: "" },
      fixupMode: "reply", announce: { enabled: true }, meme: { enabled: false }, memes: {},
      roles: {
        a: { id: "a", name: "最早建", createdAt: 100, members: { "1": { id: 1, firstName: "x", lastSeen: 0, joinedAt: 300 } } },
        b: { id: "b", name: "後來建", createdAt: 200, members: { "1": { id: 1, firstName: "x", lastSeen: 0, joinedAt: 100 } } },
        c: { id: "c", name: "沒加入", createdAt: 300, members: {} },
      },
    };
    assert.deepEqual(rolesOfUser(chat, 1).map((r) => r.id), ["b", "a"]);
  });
  it("舊資料沒有 joinedAt 時用 lastSeen 當加入時間", () => {
    const chat: ChatData = {
      welcome: { enabled: true, text: "" },
      fixupMode: "reply", announce: { enabled: true }, meme: { enabled: false }, memes: {},
      roles: {
        a: { id: "a", name: "A", createdAt: 100, members: { "1": { id: 1, firstName: "x", lastSeen: 500 } } },
        b: { id: "b", name: "B", createdAt: 200, members: { "1": { id: 1, firstName: "x", lastSeen: 400 } } },
      },
    };
    assert.deepEqual(rolesOfUser(chat, 1).map((r) => r.id), ["b", "a"]);
  });
});

describe("buildMemberTag", () => {
  it("依序用 / 串起來", () => {
    assert.equal(buildMemberTag(["桌遊", "電影"]), "桌遊/電影");
  });
  it("塞不下的後面省略", () => {
    assert.equal(buildMemberTag(["桌遊", "2026獸無限", "民宿團", "電影"]), "桌遊/2026獸無限/民宿團");
  });
  it("第一個就超過上限時截斷", () => {
    assert.equal(buildMemberTag(["abcdefghijklmnopqrstuvwxyz"]), "abcdefghijklmnop");
  });
  it("去掉 emoji", () => {
    assert.equal(buildMemberTag(["🎲桌遊", "電影🎬"]), "桌遊/電影");
    assert.equal(buildMemberTag(["👍🏽"]), "");
  });
  it("沒有身分組回空字串", () => {
    assert.equal(buildMemberTag([]), "");
  });
});
