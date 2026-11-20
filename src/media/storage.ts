/**
 * Storage for uploaded images: an S3-compatible object store (Cloudflare R2) when
 * configured, a local directory otherwise.
 *
 * Setting STORAGE_PUBLIC_BUCKET switches every operation to the object store. Left
 * unset, files go to MEDIA_DIR and are served by this process — which is what local
 * development wants, with no credentials needed. The seam is narrow on purpose:
 * everything that touches storage lives in this file, so the routes do not know
 * which backend they are talking to.
 *
 * Two buckets, because R2 has no per-object ACLs — public access is a property of
 * the whole bucket (attached to a custom domain):
 *
 *   public bucket   the served variants, `media/...`, reachable at MEDIA_BASE_URL
 *   private bucket  the as-uploaded originals, `originals/...`, never exposed
 *
 * The API only ever writes and deletes; visitors are served by Cloudflare. The
 * object key is the stored path minus its leading slash, and which bucket a path
 * lives in follows from its first segment.
 *
 * Files are content-addressed — the name is a hash of the bytes — which buys
 * three things: re-uploading the same image is free and returns the same URL, a
 * URL's contents can never change so it is safe to cache forever, and no
 * user-supplied string ever becomes a path segment.
 */

import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** Where uploads live locally. Mount a volume here in production without R2; the default suits `bun --watch`. */
export const MEDIA_ROOT = resolve(Bun.env.MEDIA_DIR ?? "./media");

/** Upload ceiling. Generous for article imagery, small enough to bound a request. */
export const MAX_UPLOAD_BYTES = Number(Bun.env.MEDIA_MAX_BYTES ?? 10 * 1024 * 1024);

/**
 * Absolute origin to build stored URLs from. With local storage that is the API
 * itself, e.g. `https://api.corbin.dev`; with R2 it is the public bucket's custom
 * domain, e.g. `https://img.corbin.dev`. Left unset with local storage, the upload
 * route falls back to the origin the request arrived on, which is what a local dev
 * setup wants.
 */
export const MEDIA_BASE_URL = (Bun.env.MEDIA_BASE_URL ?? "").replace(/\/+$/, "");

/** True when objects live in an object store rather than on local disk. */
export const REMOTE = Boolean(Bun.env.STORAGE_PUBLIC_BUCKET);

/**
 * Built only in object-store mode. Credentials are read explicitly rather than
 * left to Bun's S3_ and AWS_ prefixed fallbacks, so a stray AWS variable on the
 * host can never redirect uploads somewhere unintended.
 */
const buckets = REMOTE
  ? {
      public: connect(required("STORAGE_PUBLIC_BUCKET")),
      private: connect(required("STORAGE_PRIVATE_BUCKET")),
    }
  : null;

function connect(bucket: string): Bun.S3Client {
  return new Bun.S3Client({
    // https://<ACCOUNT_ID>.r2.cloudflarestorage.com
    endpoint: required("STORAGE_ENDPOINT"),
    // R2 ignores the region, but SigV4 signing needs one and R2 documents "auto".
    region: Bun.env.STORAGE_REGION ?? "auto",
    bucket,
    accessKeyId: required("STORAGE_ACCESS_KEY_ID"),
    secretAccessKey: required("STORAGE_SECRET_ACCESS_KEY"),
  });
}

function required(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} must be set when STORAGE_PUBLIC_BUCKET is`);
  return value;
}

/** The bucket a stored path belongs in: originals are private, everything else is served. */
function bucketFor(path: string): Bun.S3Client {
  return path.startsWith("/originals/") ? buckets!.private : buckets!.public;
}

/** `/media/2026/08/x.webp` -> `media/2026/08/x.webp`. */
const toKey = (path: string) => path.replace(/^\//, "");

/**
 * The one path shape this module reads, writes or serves.
 *
 *   /media/2026/08/<hash32>.webp          a served image (legacy: the file as uploaded)
 *   /media/2026/08/<hash32>-800.avif      a served variant, 800px wide
 *   /originals/2026/08/<hash32>.png       the upload as received; private, never served
 *
 * `<hash32>` is the first 32 hex characters of the SHA-256 of the *original*
 * upload, shared by the original and every variant derived from it.
 */
const STORED_PATH =
  /^\/(media|originals)\/(\d{4})\/(\d{2})\/([0-9a-f]{32}(?:-\d{2,5})?\.[a-z0-9]{2,5})$/;

export interface StoredFile {
  /** Site-relative path, and the primary key callers hold on to: `/media/2026/08/<hash>.webp`. */
  path: string;
  /** Full SHA-256 of the bytes. Used to recognise a re-upload. */
  hash: string;
  bytes: number;
}

/** SHA-256 of the bytes, hex. The identity of an upload. */
export function hashBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * Builds the path for a file derived from the upload with hash `hash`.
 *
 * Sharded by month so no single directory accumulates every file the site has
 * ever held — a plain `ls` stays usable years in.
 */
export function pathFor(
  kind: "media" | "originals",
  hash: string,
  extension: string,
  now: Date = new Date(),
  width?: number,
): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const suffix = width ? `-${width}` : "";
  return `/${kind}/${year}/${month}/${hash.slice(0, 32)}${suffix}.${extension}`;
}

/**
 * Writes `bytes` at exactly `path`. Overwrites: paths are derived from content,
 * so an overwrite writes the same bytes again and is harmless.
 *
 * Whether the file is reachable is decided by where it goes, not by a flag:
 * `originals/` lands in the private bucket (or on disk, with no route to it), so
 * un-stripped uploads can never be served.
 */
export async function write(path: string, bytes: Uint8Array): Promise<void> {
  if (buckets) {
    if (!STORED_PATH.test(path)) throw new Error(`refusing to write unrecognised media path: ${path}`);
    const extension = path.slice(path.lastIndexOf(".") + 1);
    // No ACL: R2 does not implement them, and the bucket is what is public.
    await bucketFor(path).write(toKey(path), bytes, {
      type: MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
      contentDisposition: "inline",
    });
    return;
  }

  const target = toDiskPath(path);
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
  const hash = hashBytes(bytes);
  const path = pathFor("media", hash, extension, now);

  const present = buckets ? await bucketFor(path).exists(toKey(path)) : await exists(toDiskPath(path));
  if (!present) await write(path, bytes);

  return { path, hash, bytes: bytes.byteLength };
}

/**
 * Opens a stored file for streaming, or returns null when it is not on disk.
 * Always null in object-store mode: Cloudflare serves the files, and the route
 * redirects there instead.
 */
export async function read(path: string) {
  if (buckets) return null;
  const target = toDiskPath(path);
  const file = Bun.file(target);
  return (await file.exists()) ? file : null;
}

/** Deletes a stored file. Missing is success — the caller wanted it gone. */
export async function remove(path: string): Promise<void> {
  if (buckets) {
    // Validates the shape the same way the disk path does before it reaches the bucket.
    if (!STORED_PATH.test(path)) throw new Error(`refusing to delete unrecognised media path: ${path}`);
    await bucketFor(path).delete(toKey(path)); // S3 delete is already idempotent.
    return;
  }
  await rm(toDiskPath(path), { force: true });
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

/** Builds the path a `/media/:year/:month/:name` route was asked for. */
export function pathFromSegments(year: string, month: string, name: string): string | null {
  const path = `/media/${year}/${month}/${name}`;
  return STORED_PATH.test(path) ? path : null;
}

/**
 * Turns a stored path into the absolute URL that goes into block content.
 *
 * `requestOrigin` is only consulted when MEDIA_BASE_URL is unset, so production
 * never depends on a Host header to decide where its own images live. In
 * object-store mode the request origin is never right (it is the API, not the
 * bucket's domain), so MEDIA_BASE_URL is mandatory there.
 */
export function toPublicUrl(path: string, requestOrigin: string): string {
  if (REMOTE && !MEDIA_BASE_URL) {
    throw new Error("MEDIA_BASE_URL must be set (the public bucket's domain) when STORAGE_PUBLIC_BUCKET is");
  }
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

  // Served files sit at <root>/<year>/<month>/ (the layout that predates
  // originals); originals get their own subtree so the two can never collide.
  const [, kind, year, month, name] = match as unknown as [string, string, string, string, string];
  const target = resolve(
    kind === "originals"
      ? join(MEDIA_ROOT, "originals", year, month, name)
      : join(MEDIA_ROOT, year, month, name),
  );
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
