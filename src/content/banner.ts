/**
 * An article's optional banner (headline) image: an uploaded image plus alt text.
 *
 * The upload endpoint refuses anything narrower than MIN_BANNER_WIDTH, and this
 * checks the same thing again on save, because what an article stores is whatever
 * the client sends and the rule should hold for the stored document, not only for
 * the happy path through the editor.
 */

import { BlockContentError, normalizeImageFile } from "./blocks.ts";

/** Narrowest source accepted for a banner; also its larger rendition. */
export const MIN_BANNER_WIDTH = 800;

export type Banner = ReturnType<typeof normalizeImageFile> & { alt: string };

/** `null` means no banner: absent, null and an empty object all clear it. */
export function normalizeBanner(input: unknown): Banner | null {
  if (input === undefined || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw !== "object" || typeof raw.url !== "string" || !raw.url.trim()) return null;

  const image = normalizeImageFile(raw, "banner image");
  if (!image.width || image.width < MIN_BANNER_WIDTH) {
    throw new BlockContentError(`The banner image must be at least ${MIN_BANNER_WIDTH}px wide`);
  }

  const alt = typeof raw.alt === "string" ? raw.alt.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return { ...image, alt };
}
