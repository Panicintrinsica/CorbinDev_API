import { describe, expect, test } from "bun:test";
import { buildFeed, type FeedArticle } from "../content/feed.ts";

const article: FeedArticle = {
  id: "6783516458610c4a041228e5",
  title: "Cats & <Coffee>",
  date: "25-11-26",
  uri: "cats-coffee",
  excerpt: "Short & sweet",
  category: "blog",
  tags: ["cats", "blog"],
  createdAt: new Date("2026-11-25T12:00:00Z"),
  updatedAt: new Date("2026-11-25T12:00:00Z"),
  content: {
    time: 1,
    version: "2.31.0",
    blocks: [
      { type: "paragraph", data: { text: 'See <a href="/projects">these</a> ]]> here' } },
      { type: "code", data: { code: "<script>" } },
      { type: "image", data: { file: { url: "/media/a.webp" }, caption: "A <i>cat</i>" } },
      {
        type: "list",
        data: { style: "ordered", items: [{ content: "outer", items: [{ content: "inner" }] }] },
      },
    ],
  },
};

describe("rss feed", () => {
  const xml = buildFeed([article], "https://api.corbin.dev");

  test("escapes text and links to the article", () => {
    expect(xml).toContain("<title>Cats &amp; &lt;Coffee&gt;</title>");
    expect(xml).toContain("<link>https://corbin.dev/blog/a/25-11-26/cats-coffee</link>");
    expect(xml).toContain("<pubDate>Wed, 25 Nov 2026 12:00:00 GMT</pubDate>");
    expect(xml.match(/<category>blog<\/category>/g)).toHaveLength(1);
  });

  test("renders the body with absolute URLs", () => {
    expect(xml).toContain('<a href="https://corbin.dev/projects">these</a>');
    expect(xml).toContain('<img src="https://api.corbin.dev/media/a.webp" alt="A cat">');
    expect(xml).toContain("<pre><code>&lt;script&gt;</code></pre>");
    expect(xml).toContain("<ol><li>outer<ol><li>inner</li></ol></li></ol>");
    expect(xml).toContain("]]]]><![CDATA[> here");
  });

  test("is still a channel with no articles", () => {
    const empty = buildFeed([], "https://api.corbin.dev");
    expect(empty).toContain("</channel>");
    expect(empty).not.toContain("<item>");
  });
});
