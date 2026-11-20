/**
 * SVG handling. SVGs are stored exactly as uploaded: never resized (they are
 * vector) and never transcoded.
 *
 * What makes them different from the raster formats is that they are documents,
 * and can carry script. In an `<img>` a browser never runs it, but the file is
 * also a URL someone can open directly, so anything that could execute, load
 * another resource or expand entities is refused rather than cleaned. The author
 * uploads their own files; a refusal is a clear signal to re-export.
 */

/** Largest SVG accepted. Nothing sensible is this big; it bounds parsing and storage. */
export const MAX_SVG_BYTES = 10 * 1024 * 1024;

const PROLOG =
  /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;

/** True when the bytes begin like an SVG document. Looks at the head only. */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  return PROLOG.test(new TextDecoder().decode(bytes.subarray(0, 4096)));
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/<script[\s>/]/i, "scripts"],
  [/<foreignObject[\s>/]/i, "foreignObject"],
  [/<(?:iframe|embed|object)[\s>/]/i, "embedded content"],
  [/<!ENTITY/i, "entity declarations"],
  [/\son[a-z]+\s*=/i, "event handlers"],
  [/javascript\s*:/i, "javascript: URLs"],
  [/data\s*:\s*text\/html/i, "embedded HTML"],
  // External resources: only same-document references (`#id`) and inline data are allowed.
  [/(?:href|src)\s*=\s*["']?\s*(?:https?:)?\/\//i, "external references"],
  [/url\(\s*["']?\s*(?:https?:)?\/\//i, "external references"],
  [/@import/i, "stylesheet imports"],
];

/** Why this SVG cannot be stored, or null if it can. */
export function svgProblem(bytes: Uint8Array): string | null {
  if (bytes.byteLength > MAX_SVG_BYTES) {
    return `SVG is larger than the ${MAX_SVG_BYTES / 1024 / 1024}MB limit`;
  }
  const text = new TextDecoder().decode(bytes);
  for (const [pattern, what] of FORBIDDEN) {
    if (pattern.test(text)) return `SVG contains ${what}, which is not allowed`;
  }
  return null;
}

/**
 * The size to reserve layout space with: `width`/`height` on the root element when
 * they are plain pixel values, otherwise the `viewBox`. Null when neither says.
 */
export function svgDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(new TextDecoder().decode(bytes.subarray(0, 8192)))?.[0];
  if (!tag) return null;

  const attr = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
  const px = (value: string | undefined) => {
    const match = value ? /^\s*([\d.]+)\s*(?:px)?\s*$/i.exec(value) : null;
    return match ? Math.round(Number(match[1])) : 0;
  };

  let width = px(attr("width"));
  let height = px(attr("height"));
  if (!width || !height) {
    const box = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
    if (box?.length === 4 && box[2]! > 0 && box[3]! > 0) {
      width = Math.round(box[2]!);
      height = Math.round(box[3]!);
    }
  }
  return width > 0 && height > 0 ? { width, height } : null;
}
