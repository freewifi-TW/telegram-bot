import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../test-setup.js";
import { parseFluffle } from "./sauce.js";

describe("parseFluffle", () => {
  it("把 0–1 的分數轉成百分比、依分數排序、unlikely 丟掉", () => {
    const hits = parseFluffle({
      results: [
        { score: 0.5, match: "alternative", platform: "Twitter", location: "https://x.com/a/status/1", credits: [] },
        { score: 0.966796875, match: "exact", platform: "e621", location: "https://e621.net/posts/546281", credits: [{ id: 1, name: "lycanruff" }] },
        { score: 0.3, match: "unlikely", platform: "Fur Affinity", location: "https://furaffinity.net/view/1" },
      ],
    });
    assert.equal(hits.length, 2);
    assert.deepEqual(hits[0], {
      similarity: 96.7,
      source: "e621",
      label: "作者 lycanruff",
      url: "https://e621.net/posts/546281",
    });
    assert.equal(hits[1].source, "Twitter");
    assert.equal(hits[1].label, "可能相符");
  });

  it("多位作者用頓號接起來，數字型的名字也能顯示", () => {
    const [hit] = parseFluffle({
      results: [{ score: 0.9, match: "tossUp", platform: "Bluesky", location: "https://bsky.app/x", credits: [{ id: 1, name: "a" }, { id: 2, name: 42 }] }],
    });
    assert.equal(hit.label, "作者 a、42");
  });

  it("格式不對時回空陣列", () => {
    assert.deepEqual(parseFluffle(null), []);
    assert.deepEqual(parseFluffle({}), []);
    assert.deepEqual(parseFluffle({ results: "nope" }), []);
  });
});
