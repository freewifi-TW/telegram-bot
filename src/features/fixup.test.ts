import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../test-setup.js";
import { collectLinks, fixText } from "./fixup.js";

describe("fixText", () => {
  const cases: Array<[string, string]> = [
    ["https://x.com/foo/status/123?s=20&t=abc", "https://fixupx.com/foo/status/123"],
    ["https://twitter.com/foo/statuses/123", "https://fixupx.com/foo/status/123"],
    ["https://mobile.twitter.com/i/web/status/456", "https://fixupx.com/i/status/456"],
    ["https://vxtwitter.com/foo/status/789", "https://fixupx.com/foo/status/789"],
    ["https://www.pixiv.net/artworks/98765432", "https://phixiv.net/artworks/98765432"],
    ["https://www.pixiv.net/en/artworks/111", "https://phixiv.net/artworks/111"],
    ["https://www.pixiv.net/member_illust.php?mode=medium&illust_id=222", "https://phixiv.net/artworks/222"],
    ["https://www.instagram.com/p/Cxyz_12-A/?igsh=abc", "https://instagramfix.com/p/Cxyz_12-A"],
    ["https://www.instagram.com/reels/Cabc123/", "https://instagramfix.com/reel/Cabc123"],
    ["https://www.instagram.com/someuser/reel/Cdef456/", "https://instagramfix.com/reel/Cdef456"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      assert.equal(fixText(input), expected);
    });
  }

  it("已經修正過的連結不動", () => {
    const text = "https://fixupx.com/foo/status/1 https://phixiv.net/artworks/1 https://instagramfix.com/p/abc";
    assert.equal(fixText(text), text);
  });

  it("不是貼文的連結不動", () => {
    for (const text of ["https://x.com/foo", "https://www.pixiv.net/users/123", "https://www.instagram.com/someuser/"]) {
      assert.equal(fixText(text), text);
    }
  });

  it("一段文字裡多個連結全部替換，其餘文字保留", () => {
    const text = "看這個 https://x.com/a/status/1 還有 https://www.pixiv.net/artworks/2 讚";
    assert.equal(fixText(text), "看這個 https://fixupx.com/a/status/1 還有 https://phixiv.net/artworks/2 讚");
  });
});

describe("collectLinks", () => {
  it("去重並保持順序", () => {
    const text = "https://x.com/a/status/1 https://x.com/a/status/1?s=20 https://x.com/b/status/2";
    assert.deepEqual(collectLinks(text, undefined), [
      "https://fixupx.com/a/status/1",
      "https://fixupx.com/b/status/2",
    ]);
  });

  it("也會看 text_link entity 裡藏的網址", () => {
    const links = collectLinks("點我", [
      { type: "text_link", offset: 0, length: 2, url: "https://x.com/a/status/99" },
    ]);
    assert.deepEqual(links, ["https://fixupx.com/a/status/99"]);
  });

  it("沒有可修正的連結時回傳空陣列", () => {
    assert.deepEqual(collectLinks("https://example.com 哈囉", undefined), []);
  });
});
