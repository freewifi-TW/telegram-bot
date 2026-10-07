import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../test-setup.js";
import { isAllowedChat } from "./allowlist.js";

describe("isAllowedChat", () => {
  it("名單為空時全部允許", () => {
    assert.equal(isAllowedChat(-100123, []), true);
  });
  it("只允許名單內的群組", () => {
    assert.equal(isAllowedChat(-100123, [-100123, -100456]), true);
    assert.equal(isAllowedChat(-100789, [-100123, -100456]), false);
  });
});
