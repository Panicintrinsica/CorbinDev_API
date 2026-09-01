import { describe, expect, test } from "bun:test";
import {
  BlockContentError,
  collectImageUrls,
  deriveExcerpt,
  derivePlainText,
  normalizeDocument,
  sanitizeInline,
} from "../content/blocks.ts";

const doc = (...blocks: { type: string; data: Record<string, unknown> }[]) => ({
  time: 1,
  version: "2.31.0",
  blocks,
});

describe("sanitizeInline", () => {
  test("keeps the inline tags Editor.js produces", () => {
    expect(sanitizeInline("a <b>b</b> <i>c</i> <code>d</code>")).toBe(
      "a <b>b</b> <i>c</i> <code>d</code>",
    );
  });

  test("drops a disallowed tag but keeps its text", () => {
    expect(sanitizeInline("<script>alert(1)</script>hi")).toBe("alert(1)hi");
    expect(sanitizeInline("<div onclick='x'>text</div>")).toBe("text");
  });

  test("strips event handlers from an allowed tag", () => {
    expect(sanitizeInline('<b onclick="steal()">x</b>')).toBe("<b>x</b>");
  });

  test("keeps a safe href and stamps rel", () => {
    expect(sanitizeInline('<a href="https://x.dev">x</a>')).toBe(
      '<a href="https://x.dev" rel="noopener noreferrer">x</a>',
    );
  });

  test("drops a javascript: href, including obfuscated ones", () => {
    expect(sanitizeInline('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeInline('<a href="java\nscript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeInline('<a href="JaVaScRiPt:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  test("keeps relative and fragment hrefs", () => {
    expect(sanitizeInline('<a href="/blog">x</a>')).toBe(
      '<a href="/blog" rel="noopener noreferrer">x</a>',
    );
  });

  test("normalizes void tags and leaves escaped text alone", () => {
    expect(sanitizeInline("a<br/>b")).toBe("a<br>b");
    expect(sanitizeInline("Tom &amp; Jerry &lt;3")).toBe("Tom &amp; Jerry &lt;3");
  });

  test("rejects a class attribute that is not a class list", () => {
    expect(sanitizeInline('<mark class="cdx-marker">x</mark>')).toBe(
      '<mark class="cdx-marker">x</mark>',
    );
    expect(sanitizeInline('<mark class="a&quot;onload=x">y</mark>')).toBe("<mark>y</mark>");
  });
});

describe("normalizeDocument", () => {
  test("rejects a payload that is not a block document", () => {
    expect(() => normalizeDocument(null)).toThrow(BlockContentError);
    expect(() => normalizeDocument({ blocks: [] })).toThrow(BlockContentError);
  });

  test("rejects an unknown block type", () => {
    expect(() => normalizeDocument(doc({ type: "raw", data: { html: "<script>" } }))).toThrow(
      /unsupported type/,
    );
  });

  test("clamps a header level into the h2-h6 range", () => {
    const result = normalizeDocument(doc({ type: "header", data: { text: "T", level: 1 } }));
    expect(result.blocks[0]!.data.level).toBe(2);
  });

  test("normalizes v1 string list items to the v2 shape", () => {
    const result = normalizeDocument(
      doc({ type: "list", data: { style: "ordered", items: ["one", "two"] } }),
    );
    expect(result.blocks[0]!.data.items).toEqual([
      { content: "one", items: [] },
      { content: "two", items: [] },
    ]);
  });

  test("rejects an inline data URL in an image block", () => {
    expect(() =>
      normalizeDocument(
        doc({ type: "image", data: { file: { url: "data:image/png;base64,AAAA" } } }),
      ),
    ).toThrow(/upload the file/);
  });

  test("keeps intrinsic image dimensions", () => {
    const result = normalizeDocument(
      doc({
        type: "image",
        data: { file: { url: "/media/2026/08/a.webp", width: 800, height: 600 } },
      }),
    );
    expect(result.blocks[0]!.data.file).toEqual({
      url: "/media/2026/08/a.webp",
      width: 800,
      height: 600,
    });
  });
});

describe("derived fields", () => {
  const article = doc(
    { type: "header", data: { text: "The <b>Title</b>", level: 2 } },
    { type: "paragraph", data: { text: "Some prose with a &amp; in it." } },
    { type: "code", data: { code: "const x = 1;" } },
    { type: "image", data: { file: { url: "/media/2026/08/a.webp" }, caption: "A cat" } },
  );

  test("excerpt is plain text drawn from prose blocks only", () => {
    expect(deriveExcerpt(normalizeDocument(article))).toBe(
      "The Title Some prose with a & in it.",
    );
  });

  test("excerpt truncates on a word boundary", () => {
    const long = doc({ type: "paragraph", data: { text: "word ".repeat(200) } });
    const excerpt = deriveExcerpt(normalizeDocument(long), 40);
    expect(excerpt.length).toBeLessThanOrEqual(41);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  test("plain text covers code and captions too", () => {
    const text = derivePlainText(normalizeDocument(article));
    expect(text).toContain("const x = 1;");
    expect(text).toContain("A cat");
  });

  test("image urls are collected for reference counting", () => {
    expect(collectImageUrls(normalizeDocument(article))).toEqual(["/media/2026/08/a.webp"]);
  });
});
