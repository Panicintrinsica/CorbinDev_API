import { describe, expect, test } from "bun:test";
import { normalizeHomeCards } from "../content/home.ts";
import { referencedPaths } from "../media/lifecycle.ts";

const id = "6783516458610c4a041228e5";
const image = { url: `/media/2026/11/${"ab".repeat(16)}.avif`, alt: "A screenshot" };

describe("home cards", () => {
  test("fills defaults and keeps skill order without repeats", () => {
    const other = "a".repeat(24);
    const [card] = normalizeHomeCards([{ title: " Front ", skills: [id, other, id] }]);
    expect(card).toMatchObject({ title: "Front", color: "blue", side: "auto", route: "", images: [] });
    expect(card!.skills).toEqual([id, other]);
  });

  test("keeps a theme only for custom color", () => {
    const theme = { foil: ["#000000", "#111111", "#FFFFFF"], tint: "#123456", shine: "#ffffff" };
    expect(normalizeHomeCards([{ title: "a", color: "red", theme }])[0]!.theme).toBeUndefined();
    expect(normalizeHomeCards([{ title: "a", color: "custom", theme }])[0]!.theme!.foil[2]).toBe("#ffffff");
    expect(() => normalizeHomeCards([{ title: "a", color: "custom" }])).toThrow("#rrggbb");
  });

  test.each([
    [{}, "needs a title"],
    [{ title: "a", route: "https://example.com" }, "path on this site"],
    [{ title: "a", route: "//example.com" }, "path on this site"],
    [{ title: "a", skills: ["nope"] }, "invalid skill"],
    [{ title: "a", color: "green" }, "must be one of"],
    [{ title: "a", images: [{ url: image.url }] }, "needs a description"],
  ])("rejects %j", (card, message) => {
    expect(() => normalizeHomeCards([card])).toThrow(message);
  });

  test("rejects a missing list", () => {
    expect(() => normalizeHomeCards(undefined)).toThrow("must be a list");
  });

  // Without this the orphan sweep would delete card pictures a day after upload.
  test("card images count as media references", () => {
    const cards = normalizeHomeCards([{ title: "a", images: [image] }]);
    expect([...referencedPaths({ cards })]).toEqual([image.url]);
  });
});
