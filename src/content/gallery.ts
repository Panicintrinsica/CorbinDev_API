/**
 * A project's gallery: an ordered list of images and YouTube videos, each with a
 * caption. Like article bodies, it passes through here before reaching Mongo, so
 * what is stored is already known-shaped and the frontend does no cleanup.
 *
 * Captions are stored as plain text (the renderer escapes them), not HTML.
 */

import { BlockContentError, normalizeImageFile } from "./blocks.ts";

export type GalleryItem =
  | { type: "image"; caption: string; image: ReturnType<typeof normalizeImageFile> }
  | { type: "video"; caption: string; videoId: string };

export const MAX_GALLERY_ITEMS = 40;
const MAX_CAPTION = 300;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export function normalizeGallery(input: unknown): GalleryItem[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new BlockContentError("gallery must be a list");
  if (input.length > MAX_GALLERY_ITEMS) {
    throw new BlockContentError(`a gallery holds at most ${MAX_GALLERY_ITEMS} items`);
  }

  return input.map((entry, index): GalleryItem => {
    const label = `gallery item ${index + 1}`;
    const raw = (entry ?? {}) as Record<string, unknown>;

    // Every item is shown with a caption, so one without is an authoring mistake
    // worth surfacing rather than silently rendering a bare picture.
    const caption = typeof raw.caption === "string" ? raw.caption.replace(/\s+/g, " ").trim() : "";
    if (!caption) throw new BlockContentError(`${label} needs a caption`);
    if (caption.length > MAX_CAPTION) {
      throw new BlockContentError(`${label} has a caption over ${MAX_CAPTION} characters`);
    }

    if (raw.type === "image") {
      return { type: "image", caption, image: normalizeImageFile(raw.image, label) };
    }
    if (raw.type === "video") {
      // Only the 11-character id is kept: the frontend builds every URL from it,
      // so nothing a client sends can become a link or an iframe address.
      if (typeof raw.videoId !== "string" || !YOUTUBE_ID.test(raw.videoId)) {
        throw new BlockContentError(`${label} has an invalid YouTube video`);
      }
      return { type: "video", caption, videoId: raw.videoId };
    }
    throw new BlockContentError(`${label} must be an image or a video`);
  });
}
