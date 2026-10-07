import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../test-setup.js";
import { findRole, type ChatData } from "../store.js";
import { chunk, parseArgs, parseRoleCall, sortedRoles } from "./roles.js";

describe("sortedRoles", () => {
  it("依新增順序，不受名稱影響", () => {
    const chat: ChatData = {
      welcome: { enabled: true, text: "" },
      fixupMode: "reply",
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
    fixupMode: "reply",
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
