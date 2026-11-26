/**
 * The home page's feature cards. Like profile content, a save passes through here
 * so what is stored is already known-shaped and every field is bounded.
 * Text is plain text; the frontend escapes it.
 */

import { BlockContentError, normalizeImageFile } from "./blocks.ts";

export const COLORS = ["red", "blue", "pink", "custom"] as const;
export const SIDES = ["auto", "left", "right"] as const;

export const LIMITS = {
  cards: 12,
  title: 80,
  body: 2000,
  route: 200,
  images: 8,
  alt: 300,
  skills: 20,
} as const;

export interface HomeTheme {
  /** Foil edge: dark, mid, light. */
  foil: [string, string, string];
  tint: string;
  shine: string;
}

export interface HomeCard {
  title: string;
  body: string;
  color: (typeof COLORS)[number];
  /** Only kept when `color` is `custom`. */
  theme?: HomeTheme;
  side: (typeof SIDES)[number];
  /** A path on this site for the "More" button; empty hides it. */
  route: string;
  images: Array<ReturnType<typeof normalizeImageFile> & { alt: string }>;
  /** Skill ids, in display order. */
  skills: string[];
}

const HEX = /^#[0-9a-f]{6}$/i;
const OBJECT_ID = /^[0-9a-f]{24}$/;
// A single leading slash only: "//host" would leave the site.
const ROUTE = /^\/(?!\/)[A-Za-z0-9/_-]*$/;

const text = (input: unknown, max: number, what: string): string => {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") throw new BlockContentError(`${what} must be text`);
  const value = input.trim();
  if (value.length > max) throw new BlockContentError(`${what} is longer than ${max} characters`);
  return value;
};

const list = (input: unknown, max: number, what: string): unknown[] => {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new BlockContentError(`${what} must be a list`);
  if (input.length > max) throw new BlockContentError(`${what}: at most ${max}`);
  return input;
};

const oneOf = <T extends string>(input: unknown, allowed: readonly T[], fallback: T, what: string): T => {
  if (input === undefined || input === null) return fallback;
  if (!allowed.includes(input as T)) {
    throw new BlockContentError(`${what} must be one of ${allowed.join(", ")}`);
  }
  return input as T;
};

function normalizeTheme(input: unknown, label: string): HomeTheme {
  const raw = (input ?? {}) as Record<string, unknown>;
  const color = (value: unknown): string => {
    if (typeof value !== "string" || !HEX.test(value)) {
      throw new BlockContentError(`${label} needs colors written as #rrggbb`);
    }
    return value.toLowerCase();
  };
  const foil = Array.isArray(raw.foil) ? raw.foil : [];
  return {
    foil: [color(foil[0]), color(foil[1]), color(foil[2])],
    tint: color(raw.tint),
    shine: color(raw.shine),
  };
}

export function normalizeHomeCards(input: unknown): HomeCard[] {
  if (!Array.isArray(input)) throw new BlockContentError("cards must be a list");

  return list(input, LIMITS.cards, "cards").map((entry, index): HomeCard => {
    const label = `card ${index + 1}`;
    const raw = (entry ?? {}) as Record<string, unknown>;

    const title = text(raw.title, LIMITS.title, `${label} title`);
    if (!title) throw new BlockContentError(`${label} needs a title`);

    const route = text(raw.route, LIMITS.route, `${label} link`);
    if (route && !ROUTE.test(route)) {
      throw new BlockContentError(`${label} link must be a path on this site, such as /projects`);
    }

    const color = oneOf(raw.color, COLORS, "blue", `${label} color`);

    const images = list(raw.images, LIMITS.images, `${label} images`).map((item, i) => {
      const what = `${label} image ${i + 1}`;
      const alt = text((item as Record<string, unknown>)?.alt, LIMITS.alt, `${what} description`);
      if (!alt) throw new BlockContentError(`${what} needs a description`);
      return { ...normalizeImageFile(item, what), alt };
    });

    const skills = list(raw.skills, LIMITS.skills, `${label} skills`).map((id) => {
      if (typeof id !== "string" || !OBJECT_ID.test(id)) {
        throw new BlockContentError(`${label} has an invalid skill`);
      }
      return id;
    });

    return {
      title,
      body: text(raw.body, LIMITS.body, `${label} text`),
      color,
      ...(color === "custom" ? { theme: normalizeTheme(raw.theme, label) } : {}),
      side: oneOf(raw.side, SIDES, "auto", `${label} side`),
      route,
      images,
      skills: [...new Set(skills)],
    };
  });
}
