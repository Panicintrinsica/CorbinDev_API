/**
 * The profile page's authored content: name, pronouns, birth date, an intro, a table
 * of facts and a set of topic sections. Everything is plain text or markdown; the
 * frontend renders markdown through ngx-markdown, which sanitizes it, so nothing here
 * is HTML. Every field is bounded so a save cannot grow a document without limit.
 */

import { BlockContentError } from "./blocks.ts";

export interface ProfileFact {
  title: string;
  value: string;
}

export interface ProfileSection {
  /** URL-safe key; unique on the page. */
  id: string;
  title: string;
  /** Markdown. */
  body: string;
}

export interface ProfileContent {
  displayName: string;
  pronouns: string;
  /** ISO date or date-time; drives the live age counter. Empty hides it. */
  birthDate: string;
  intro: string;
  facts: ProfileFact[];
  sections: ProfileSection[];
}

export const LIMITS = {
  name: 80,
  pronouns: 40,
  intro: 40_000,
  facts: 40,
  factTitle: 40,
  factValue: 160,
  sections: 16,
  sectionTitle: 40,
  sectionBody: 40_000,
} as const;

const SECTION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const text = (input: unknown, max: number, what: string): string => {
  if (typeof input !== "string") throw new BlockContentError(`${what} must be text`);
  const value = input.trim();
  if (value.length > max) throw new BlockContentError(`${what} is longer than ${max} characters`);
  return value;
};

/** Single-line fields: whitespace runs collapse, control characters are refused. */
const line = (input: unknown, max: number, what: string): string => {
  const value = text(input, max, what).replace(/\s+/g, " ");
  if (/\p{Cc}/u.test(value)) throw new BlockContentError(`${what} contains control characters`);
  return value;
};

/**
 * Validates the content fields present in `input` and returns only those, so a save
 * that sends one field leaves the others alone. Absent keys are not touched.
 */
export function normalizeProfileContent(input: Record<string, unknown>): Partial<ProfileContent> {
  const out: Partial<ProfileContent> = {};

  if ("displayName" in input) out.displayName = line(input.displayName, LIMITS.name, "name");
  if ("pronouns" in input) out.pronouns = line(input.pronouns, LIMITS.pronouns, "pronouns");
  if ("intro" in input) out.intro = text(input.intro, LIMITS.intro, "intro");

  if ("birthDate" in input) {
    const value = line(input.birthDate, 40, "birth date");
    if (value && Number.isNaN(Date.parse(value))) {
      throw new BlockContentError("birth date is not a valid date");
    }
    out.birthDate = value;
  }

  if ("facts" in input) {
    if (!Array.isArray(input.facts)) throw new BlockContentError("facts must be a list");
    if (input.facts.length > LIMITS.facts) {
      throw new BlockContentError(`at most ${LIMITS.facts} facts`);
    }
    out.facts = input.facts.map((entry, index) => {
      const raw = (entry ?? {}) as Record<string, unknown>;
      const title = line(raw.title, LIMITS.factTitle, `fact ${index + 1} title`);
      if (!title) throw new BlockContentError(`fact ${index + 1} needs a title`);
      return { title, value: line(raw.value ?? "", LIMITS.factValue, `fact ${index + 1} value`) };
    });
  }

  if ("sections" in input) {
    if (!Array.isArray(input.sections)) throw new BlockContentError("sections must be a list");
    if (input.sections.length > LIMITS.sections) {
      throw new BlockContentError(`at most ${LIMITS.sections} sections`);
    }
    const seen = new Set<string>();
    out.sections = input.sections.map((entry, index) => {
      const raw = (entry ?? {}) as Record<string, unknown>;
      const label = `section ${index + 1}`;
      const title = line(raw.title, LIMITS.sectionTitle, `${label} title`);
      if (!title) throw new BlockContentError(`${label} needs a title`);
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (!SECTION_ID.test(id) || id.length > 32) {
        throw new BlockContentError(`${label} has an invalid id`);
      }
      if (seen.has(id)) throw new BlockContentError(`${label} repeats the id "${id}"`);
      seen.add(id);
      return { id, title, body: text(raw.body ?? "", LIMITS.sectionBody, `${label} body`) };
    });
  }

  return out;
}
