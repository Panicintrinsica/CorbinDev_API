/**
 * Editor.js block documents: the storage format for article bodies.
 *
 * Everything a client sends passes through `normalizeDocument` before it reaches
 * Mongo, so what is stored is already known-shaped and already sanitized. The
 * renderer on the frontend therefore trusts the database and does no cleanup of
 * its own — there is exactly one place where untrusted markup is dealt with, and
 * it is here.
 *
 * Editor.js keeps inline formatting as a small amount of HTML inside otherwise
 * plain block data ("some <b>bold</b> text"). That is the only HTML we accept,
 * and only the tags in ALLOWED_TAGS survive.
 */

export interface EditorBlock {
  id?: string;
  type: string;
  data: Record<string, unknown>;
}

export interface EditorDocument {
  time: number;
  version: string;
  blocks: EditorBlock[];
}

/** Thrown for content a human can fix by editing the article. Routes map it to 400. */
export class BlockContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockContentError";
  }
}

/** Block tools the site can render. A document may not contain anything else. */
const BLOCK_TYPES = [
  "paragraph",
  "header",
  "list",
  "image",
  "code",
  "quote",
  "delimiter",
  "table",
] as const;

type BlockType = (typeof BLOCK_TYPES)[number];

const IS_BLOCK_TYPE = new Set<string>(BLOCK_TYPES);

/** Inline tags Editor.js produces, mapped to the attributes each may keep. */
const ALLOWED_TAGS: Record<string, readonly string[]> = {
  b: [],
  strong: [],
  i: [],
  em: [],
  u: [],
  s: [],
  br: [],
  code: ["class"],
  mark: ["class"],
  span: ["class"],
  a: ["href", "title", "rel", "target"],
};

/** Void elements never get a closing tag written back out. */
const VOID_TAGS = new Set(["br"]);

/** Conservative: class names only, so a class attribute cannot carry a payload. */
const CLASS_PATTERN = /^[A-Za-z0-9 _-]{0,200}$/;

/** Anything with a scheme must use one of these. Scheme-less URLs stay as they are. */
const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

const MAX_EXCERPT = 280;

// --- Public API ---------------------------------------------------------------

/**
 * Validates and sanitizes a document posted by a client.
 *
 * @throws {BlockContentError} when the payload is not a usable Editor.js document.
 */
export function normalizeDocument(input: unknown): EditorDocument {
  const raw = input as Partial<EditorDocument> | null | undefined;

  if (!raw || typeof raw !== "object" || !Array.isArray(raw.blocks)) {
    throw new BlockContentError(
      "content must be an Editor.js document with a blocks array",
    );
  }
  if (raw.blocks.length === 0) {
    throw new BlockContentError("content must contain at least one block");
  }

  const blocks = raw.blocks.map((block, index) => normalizeBlock(block, index));

  return {
    time:
      typeof raw.time === "number" && Number.isFinite(raw.time) ? raw.time : Date.now(),
    version: typeof raw.version === "string" ? raw.version.slice(0, 32) : "2.31.0",
    blocks,
  };
}

/**
 * A short plain-text summary for article cards, search results and the meta
 * description. Taken from the leading prose so an author gets a sensible one for
 * free, but `excerpt` is a real field and an explicit value always wins.
 */
export function deriveExcerpt(doc: EditorDocument, limit: number = MAX_EXCERPT): string {
  const parts: string[] = [];

  for (const block of doc.blocks) {
    if (block.type !== "paragraph" && block.type !== "header" && block.type !== "quote") {
      continue;
    }
    const text = toPlainText(String(block.data.text ?? ""));
    if (text) parts.push(text);
    if (parts.join(" ").length >= limit) break;
  }

  return truncateOnWord(parts.join(" "), limit);
}

/**
 * Every word in the document as one flat string. Exists so Atlas Search can index
 * article bodies with an ordinary text mapping instead of reaching into the block
 * array, which would need a new index definition every time a tool is added.
 */
export function derivePlainText(doc: EditorDocument): string {
  const parts: string[] = [];

  const pushHtml = (value: unknown) => {
    const text = toPlainText(String(value ?? ""));
    if (text) parts.push(text);
  };

  for (const block of doc.blocks) {
    switch (block.type) {
      case "paragraph":
      case "header":
        pushHtml(block.data.text);
        break;
      case "quote":
        pushHtml(block.data.text);
        pushHtml(block.data.caption);
        break;
      case "list":
        collectListText(block.data.items, parts);
        break;
      case "image":
        pushHtml(block.data.caption);
        break;
      case "code":
        // Code is stored as plain text, so it needs no tag stripping.
        if (block.data.code) parts.push(String(block.data.code));
        break;
      case "table":
        for (const row of (block.data.content as string[][]) ?? []) {
          for (const cell of row) pushHtml(cell);
        }
        break;
    }
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Every image URL the document references, in order, de-duplicated. */
export function collectImageUrls(doc: EditorDocument): string[] {
  const urls = new Set<string>();

  for (const block of doc.blocks) {
    if (block.type !== "image") continue;
    const file = (block.data.file ?? {}) as Record<string, unknown>;
    if (typeof file.url === "string" && file.url) urls.add(file.url);
  }

  return [...urls];
}

// --- Block normalization ------------------------------------------------------

function normalizeBlock(input: unknown, index: number): EditorBlock {
  const raw = input as Partial<EditorBlock> | null;

  if (!raw || typeof raw !== "object" || typeof raw.type !== "string") {
    throw new BlockContentError(`block ${index} is missing a type`);
  }
  if (!IS_BLOCK_TYPE.has(raw.type)) {
    throw new BlockContentError(`block ${index} uses unsupported type "${raw.type}"`);
  }

  const data = (raw.data ?? {}) as Record<string, unknown>;
  const block: EditorBlock = {
    type: raw.type,
    data: normalizeData(raw.type as BlockType, data, index),
  };

  // Editor.js round-trips ids so re-rendering a saved document keeps block
  // identity. Keep the author's if it looks like one, drop anything else.
  if (typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(raw.id)) {
    block.id = raw.id;
  }

  return block;
}

function normalizeData(
  type: BlockType,
  data: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  switch (type) {
    case "paragraph":
      return { text: sanitizeInline(data.text) };

    case "header": {
      const level = Number(data.level);
      return {
        text: sanitizeInline(data.text),
        // h1 belongs to the article title, so a heading tool starts at h2.
        level: Number.isInteger(level) && level >= 2 && level <= 6 ? level : 2,
      };
    }

    case "list": {
      const style = data.style === "ordered" ? "ordered" : "unordered";
      return { style, items: normalizeListItems(data.items, 0) };
    }

    case "image":
      return normalizeImage(data, index);

    case "code":
      return {
        code: typeof data.code === "string" ? data.code : "",
        // Optional hint for the frontend highlighter; the renderer falls back to
        // plaintext when it is absent or unknown.
        language:
          typeof data.language === "string" && /^[a-z0-9+#-]{1,24}$/i.test(data.language)
            ? data.language.toLowerCase()
            : "",
      };

    case "quote":
      return {
        text: sanitizeInline(data.text),
        caption: sanitizeInline(data.caption),
        alignment: data.alignment === "center" ? "center" : "left",
      };

    case "delimiter":
      return {};

    case "table": {
      const rows = Array.isArray(data.content) ? data.content : [];
      return {
        withHeadings: data.withHeadings === true,
        content: rows
          .filter((row): row is unknown[] => Array.isArray(row))
          .map((row) => row.map((cell) => sanitizeInline(cell))),
      };
    }
  }
}

function normalizeListItems(input: unknown, depth: number): unknown[] {
  if (!Array.isArray(input) || depth > 4) return [];

  return input.map((item) => {
    // @editorjs/list v1 stores plain strings; v2 stores nested objects. Both are
    // accepted on the way in and normalized to the v2 shape on the way out.
    if (typeof item === "string") {
      return { content: sanitizeInline(item), items: [] };
    }
    const raw = (item ?? {}) as Record<string, unknown>;
    return {
      content: sanitizeInline(raw.content),
      items: normalizeListItems(raw.items, depth + 1),
    };
  });
}

function normalizeImage(data: Record<string, unknown>, index: number) {
  const file = (data.file ?? {}) as Record<string, unknown>;
  const url = typeof file.url === "string" ? file.url.trim() : "";

  if (!url) {
    throw new BlockContentError(`image block ${index} has no file url`);
  }
  // The old dashboard editor inlined images as base64. Rejecting them outright is
  // the point of having an upload endpoint: a data URL would bloat the document,
  // defeat caching, and eventually hit Mongo's 16MB ceiling.
  if (/^data:/i.test(url)) {
    throw new BlockContentError(
      `image block ${index} contains an inline data URL - upload the file to /media/admin and store the returned url instead`,
    );
  }
  if (!isSafeUrl(url)) {
    throw new BlockContentError(`image block ${index} has an unsupported file url`);
  }

  const width = Number(file.width);
  const height = Number(file.height);

  return {
    file: {
      url,
      // Intrinsic size travels with the block so the frontend can reserve space
      // and avoid layout shift while the image loads.
      ...(Number.isInteger(width) && width > 0 ? { width } : {}),
      ...(Number.isInteger(height) && height > 0 ? { height } : {}),
    },
    caption: sanitizeInline(data.caption),
    withBorder: data.withBorder === true,
    withBackground: data.withBackground === true,
    stretched: data.stretched === true,
  };
}

// --- Inline HTML sanitizing ---------------------------------------------------

const TAG_PATTERN = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;
const ATTR_PATTERN =
  /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/**
 * Strips every tag that is not an inline formatting tag Editor.js produces.
 *
 * Text between tags is passed through untouched: it arrives already HTML-escaped
 * from contenteditable, and re-escaping would double up every `&amp;`. A stray
 * unescaped `<` is consumed as a tag token and dropped, so it cannot open an
 * element either way.
 */
export function sanitizeInline(input: unknown): string {
  if (typeof input !== "string" || input === "") return "";

  let output = "";
  let cursor = 0;

  TAG_PATTERN.lastIndex = 0;
  for (let match = TAG_PATTERN.exec(input); match; match = TAG_PATTERN.exec(input)) {
    output += input.slice(cursor, match.index);
    cursor = match.index + match[0].length;

    const isClosing = match[1] === "/";
    const name = match[2]!.toLowerCase();
    const allowedAttrs = ALLOWED_TAGS[name];

    if (!allowedAttrs) continue; // Tag dropped; its text content is kept.

    if (isClosing) {
      if (!VOID_TAGS.has(name)) output += `</${name}>`;
      continue;
    }
    output += VOID_TAGS.has(name)
      ? `<${name}>`
      : `<${name}${sanitizeAttributes(match[3] ?? "", name, allowedAttrs)}>`;
  }

  return output + input.slice(cursor);
}

function sanitizeAttributes(
  source: string,
  tag: string,
  allowed: readonly string[],
): string {
  if (allowed.length === 0) return "";

  const kept: string[] = [];
  let hasHref = false;

  ATTR_PATTERN.lastIndex = 0;
  for (let match = ATTR_PATTERN.exec(source); match; match = ATTR_PATTERN.exec(source)) {
    const name = match[1]!.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";

    if (!allowed.includes(name)) continue;

    if (name === "class") {
      if (CLASS_PATTERN.test(value)) kept.push(`class="${escapeAttr(value)}"`);
      continue;
    }
    if (name === "href") {
      if (!isSafeUrl(value)) continue;
      hasHref = true;
      kept.push(`href="${escapeAttr(value.trim())}"`);
      continue;
    }
    if (name === "target") {
      if (value === "_blank") kept.push('target="_blank"');
      continue;
    }
    if (name === "rel") continue; // Set below, not taken from input.

    kept.push(`${name}="${escapeAttr(value)}"`);
  }

  // An anchor whose href was dropped keeps its text but stops being a link, which
  // is the safe outcome; rel only makes sense once a real href survived.
  if (tag === "a" && hasHref) kept.push('rel="noopener noreferrer"');

  return kept.length > 0 ? ` ${kept.join(" ")}` : "";
}

/** True for scheme-less URLs and for the three schemes an article may link to. */
function isSafeUrl(value: string): boolean {
  // Control characters and whitespace are how `java\nscript:` gets past a naive
  // check, so they come out before the scheme is read.
  const url = Array.from(value)
    .filter((ch) => ch.charCodeAt(0) > 0x20)
    .join("");
  if (url === "") return false;

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  if (!scheme) return true; // Relative, absolute-path, or fragment.

  return SAFE_SCHEMES.has(scheme[1]!.toLowerCase());
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// --- Plain-text helpers -------------------------------------------------------

function collectListText(items: unknown, parts: string[]): void {
  if (!Array.isArray(items)) return;

  for (const item of items) {
    if (typeof item === "string") {
      const text = toPlainText(item);
      if (text) parts.push(text);
      continue;
    }
    const raw = (item ?? {}) as Record<string, unknown>;
    const text = toPlainText(String(raw.content ?? ""));
    if (text) parts.push(text);
    collectListText(raw.items, parts);
  }
}

function toPlainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // Last, so "&amp;lt;" does not become "<".
}

function truncateOnWord(value: string, limit: number): string {
  if (value.length <= limit) return value;

  const clipped = value.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
