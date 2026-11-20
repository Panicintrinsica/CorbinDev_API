import { describe, expect, test } from "bun:test";
import { BlockContentError } from "../content/blocks.ts";
import { LIMITS, normalizeProfileContent } from "../content/profile.ts";

describe("normalizeProfileContent", () => {
  test("returns only the fields that were sent", () => {
    expect(normalizeProfileContent({ pronouns: " He/They " })).toEqual({ pronouns: "He/They" });
    expect(normalizeProfileContent({})).toEqual({});
  });

  test("tidies names, facts and sections", () => {
    const out = normalizeProfileContent({
      displayName: "  Emrys   Corbin ",
      birthDate: "1990-10-18T12:00:00Z",
      intro: "  # Hello\n\nmarkdown  ",
      facts: [{ title: " Height ", value: "182cm" }, { title: "Age", value: "{age}" }],
      sections: [{ id: "books", title: "Books", body: "*Fiction*" }],
    });
    expect(out.displayName).toBe("Emrys Corbin");
    expect(out.intro).toBe("# Hello\n\nmarkdown");
    expect(out.facts).toEqual([
      { title: "Height", value: "182cm" },
      { title: "Age", value: "{age}" },
    ]);
    expect(out.sections).toEqual([{ id: "books", title: "Books", body: "*Fiction*" }]);
  });

  test("an empty birth date is allowed (it hides the counter)", () => {
    expect(normalizeProfileContent({ birthDate: "" })).toEqual({ birthDate: "" });
  });

  test.each([
    ["bad date", { birthDate: "tomorrow-ish" }],
    ["name too long", { displayName: "x".repeat(LIMITS.name + 1) }],
    ["control characters", { pronouns: "he\u0000they" }],
    ["fact without a title", { facts: [{ title: " ", value: "x" }] }],
    ["too many facts", { facts: Array.from({ length: LIMITS.facts + 1 }, () => ({ title: "a", value: "b" })) }],
    ["facts not a list", { facts: "nope" }],
    ["section id with spaces", { sections: [{ id: "My Books", title: "t", body: "" }] }],
    ["duplicate section ids", { sections: [{ id: "a", title: "A", body: "" }, { id: "a", title: "B", body: "" }] }],
    ["section without a title", { sections: [{ id: "a", title: "", body: "" }] }],
    ["body too long", { sections: [{ id: "a", title: "A", body: "x".repeat(LIMITS.sectionBody + 1) }] }],
    ["intro not text", { intro: 5 }],
  ])("rejects %s", (_name, input) => {
    expect(() => normalizeProfileContent(input as Record<string, unknown>)).toThrow(BlockContentError);
  });
});
