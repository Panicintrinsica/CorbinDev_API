/**
 * Local disk storage for uploaded images.
 *
 * Deliberately not an object store. Traffic here is low enough that a directory
 * on the host, served by this process, costs nothing to run and nothing to
 * operate — and it keeps the deployment to one container plus one volume. The
 * seam is narrow on purpose: everything that touches the filesystem lives in this
 * file, so swapping in S3 later means reimplementing four functions rather than
 * unpicking the routes.
 *
 * Files are content-addressed — the name is a hash of the bytes — which buys
 * three things: re-uploading the same image is free and returns the same URL, a
 * URL's contents can never change so it is safe to cache forever, and no
 * user-supplied string ever becomes a path segment.
 */

import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** Where uploads live. Mount a volume here in production; the default suits `bun --watch`. */
export const MEDIA_ROOT = resolve(Bun.env.MEDIA_DIR ?? "./media");

/** Upload ceiling. Generous for article imagery, small enough to bound a request. */
export const MAX_UPLOAD_BYTES = Number(Bun.env.MEDIA_MAX_BYTES ?? 8 * 1024 * 1024);

/**
 * Absolute origin to build stored URLs from, e.g. `https://api.corbin.dev`. Left
 * unset, the upload route falls back to the origin the request arrived on, which
 * is what a local dev setup wants.
 */
export const MEDIA_BASE_URL = (Bun.env.MEDIA_BASE_URL ?? "").replace(/\/+$/, "");

/** The one path shape this module reads, writes or serves. */
const STORED_PATH = /^\/media\/(\d{4})\/(\d{2})\/([0-9a-f]{32}\.[a-z0-9]{2,5})$/;

export interface StoredFile {
  /** Site-relative path, and the primary key callers hold on to: `/media/2026/08/<hash>.webp`. */
  path: string;
  /** Full SHA-256 of the bytes. Used to recognise a re-upload. */
  hash: string;
  bytes: number;
}

/**
 * Writes `bytes` under a name derived from their hash, and reports where.
 *
 * Idempotent: the same bytes in the same month always land on the same path, so
 * an interrupted upload retried is a no-op rather than a duplicate.
 */
export async function store(
  bytes: Uint8Array,
  extension: string,
  now: Date = new Date(),
): Promise<StoredFile> {
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");

  // Sharded by month so no single directory accumulates every file the site has
  // ever held — a plain `ls` stays usable years in.
  const path = `/media/${year}/${month}/${hash.slice(0, 32)}.${extension}`;
  const target = toDiskPath(path);

  if (await exists(target)) {
    return { path, hash, bytes: bytes.byteLength };
  }

  await mkdir(dirname(target), { recursive: true });

  // Write-then-rename, so a reader can never observe a half-written file: a
  // partial write leaves a stray temp file instead of a corrupt image.
  const temporary = `${target}.${crypto.randomUUID()}.part`;
  try {
    await Bun.write(temporary, bytes);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  return { path, hash, bytes: bytes.byteLength };
}

/** Opens a stored file for streaming, or returns null when it is not on disk. */
export async function read(path: string) {
  const target = toDiskPath(path);
  const file = Bun.file(target);
  return (await file.exists()) ? file : null;
}

/** Deletes a stored file. Missing is success — the caller wanted it gone. */
export async function remove(path: string): Promise<void> {
  await rm(toDiskPath(path), { force: true });
}

/** Builds the path a `/media/:year/:month/:name` route was asked for. */
export function pathFromSegments(year: string, month: string, name: string): string | null {
  const path = `/media/${year}/${month}/${name}`;
  return STORED_PATH.test(path) ? path : null;
}

/**
 * Turns a stored path into the absolute URL that goes into block content.
 *
 * `requestOrigin` is only consulted when MEDIA_BASE_URL is unset, so production
 * never depends on a Host header to decide where its own images live.
 */
export function toPublicUrl(path: string, requestOrigin: string): string {
  return `${MEDIA_BASE_URL || requestOrigin.replace(/\/+$/, "")}${path}`;
}

/**
 * Reduces an absolute or relative URL back to a stored path, or null if it does
 * not name one of our files. Lets a delete accept whatever the editor recorded.
 */
export function toStoredPath(url: string): string | null {
  const withoutOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
  const path = withoutOrigin.split("?")[0]!.split("#")[0]!;
  return STORED_PATH.test(path) ? path : null;
}

/**
 * The single place a path becomes a filesystem location.
 *
 * STORED_PATH is an exact-match allow-list of digits and lowercase hex, so `..`,
 * a leading slash, a drive letter or a null byte cannot appear in the first
 * place; the containment check afterwards is belt-and-braces against a future
 * loosening of that pattern.
 */
function toDiskPath(path: string): string {
  const match = STORED_PATH.exec(path);
  if (!match) throw new Error(`refusing to resolve unrecognised media path: ${path}`);

  const target = resolve(join(MEDIA_ROOT, match[1]!, match[2]!, match[3]!));
  if (target !== MEDIA_ROOT && !target.startsWith(MEDIA_ROOT + sep)) {
    throw new Error(`media path escaped the media root: ${path}`);
  }
  return target;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
