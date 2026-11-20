import { Hono } from "hono";
import DB_Media from "../schema/media.schema.ts";
import { identifyImage } from "../media/image.ts";
import { destroyRecord, lifecycle } from "../media/catalog.ts";
import { ORPHAN_GRACE_MS } from "../media/sweeper.ts";
import { svgProblem } from "../media/svg.ts";
import { isValidClaim, type Claim, type OwnerKind } from "../media/lifecycle.ts";
import {
  ImageProcessingError,
  PROFILES,
  pickFallback,
  processImage,
  type ProcessedImage,
} from "../media/process.ts";
import {
  hashBytes,
  MAX_UPLOAD_BYTES,
  pathFor,
  pathFromSegments,
  read,
  REMOTE,
  remove,
  toPublicUrl,
  write,
} from "../media/storage.ts";
import { getAuth, type AuthEnv } from "../auth/index.ts";

/**
 * Image uploads and the media library.
 *
 * The upload response is shaped to Editor.js' image-tool contract
 * (`{ success, file: { url } }`) so the editor needs no adapter, with width and
 * height added on because the article renderer uses them to reserve layout space.
 *
 * `/media/admin/*` is permission-gated in `index.ts`; the bare serving route is
 * public, because that is what an <img> tag in a published article needs.
 */
const media = new Hono<AuthEnv>();

/** Editor.js posts `image`; a hand-rolled form may say `file`. Accept either. */
const FILE_FIELDS = ["image", "file"] as const;

/**
 * Serves a stored file.
 *
 * Cached forever and never revalidated: the filename is a hash of the contents,
 * so a given URL's bytes cannot change. Editing an image produces a new URL.
 */
media.get("/:year/:month/:name", async (c) => {
  const path = pathFromSegments(
    c.req.param("year"),
    c.req.param("month"),
    c.req.param("name"),
  );
  if (!path) return c.json({ error: "Not found" }, 404);

  // In object-store mode the file is served by Cloudflare, not this process, so a
  // URL that points at the API is sent on to the real address. The redirect is
  // permanent because the name is a hash: it will never point anywhere else.
  if (REMOTE) return c.redirect(toPublicUrl(path, new URL(c.req.url).origin), 301);

  const file = await read(path);
  if (!file) return c.json({ error: "Not found" }, 404);

  return new Response(file, {
    headers: {
      "Content-Type": file.type,
      "Content-Length": String(file.size),
      "Cache-Control": "public, max-age=31536000, immutable",
      // The extension is derived from magic bytes on upload, but a browser that
      // sniffs anyway is a browser that can be talked into running something.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      // An SVG opened directly is a document, not an image. Upload already refuses
      // script; this stops anything that slipped through from running.
      ...(file.type.startsWith("image/svg")
        ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" }
        : {}),
    },
  });
});

/**
 * Accepts one image and returns the URL to reference it by.
 *
 * There is deliberately no upload-by-URL counterpart: it would have this server
 * fetch an arbitrary address on a caller's behalf, which is an SSRF primitive
 * pointed at whatever else lives on the host's network. Authors upload files.
 */
media.post("/admin", async (c) => {
  const { principal } = getAuth(c);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ success: 0, error: "Expected a multipart form upload" }, 400);
  }

  const upload = FILE_FIELDS.map((field) => form.get(field)).find(
    (value): value is File => value instanceof File,
  );
  if (!upload) {
    return c.json({ success: 0, error: "No image field in the upload" }, 400);
  }
  if (upload.size === 0) {
    return c.json({ success: 0, error: "The uploaded file is empty" }, 400);
  }
  if (upload.size > MAX_UPLOAD_BYTES) {
    return c.json(
      {
        success: 0,
        error: `Image is larger than the ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`,
      },
      413,
    );
  }

  const claim = parseClaim(form);
  if (claim === "invalid") {
    return c.json({ success: 0, error: "Unrecognised owner or slot for this upload" }, 400);
  }

  const profile = String(form.get("purpose") ?? "default");
  if (!Object.hasOwn(PROFILES, profile)) {
    return c.json({ success: 0, error: "Unrecognised purpose for this upload" }, 400);
  }

  const bytes = new Uint8Array(await upload.arrayBuffer());
  const info = identifyImage(bytes);
  if (!info) {
    return c.json(
      { success: 0, error: "Unsupported image format — use PNG, JPEG, GIF, WebP, AVIF or SVG" },
      415,
    );
  }

  const origin = new URL(c.req.url).origin;
  const hash = hashBytes(bytes);

  /**
   * Every successful upload, new or recognised, ends here: it restarts the orphan
   * sweep's grace period and records what the upload is for.
   */
  const finish = async (record: NonNullable<Awaited<ReturnType<typeof DB_Media.findOne>>>) => {
    await DB_Media.updateOne({ _id: record._id }, { $set: { lastUploadedAt: new Date() } });
    if (claim) {
      await lifecycle.claim(
        {
          id: String(record._id),
          path: record.path,
          claims: (record.claims ?? []).map(({ kind, id, slot }) => ({ kind, id, slot })),
        },
        claim,
      );
    }
    return c.json({ success: 1, file: describe(record, origin) });
  };

  const isSvg = info.extension === "svg";

  // A vector has no pixel width to measure, so where a minimum applies it must
  // declare one; otherwise it could stand in for a too-small image.
  const minWidth = PROFILES[profile]?.minWidth;
  if (isSvg && minWidth && (info.width ?? 0) < minWidth) {
    return c.json(
      { success: 0, error: `The SVG must declare a width of at least ${minWidth}px` },
      422,
    );
  }
  // SVG ignores the purpose: it is never resized, so there is one file either way.
  const kept = isSvg ? "svg" : profile;

  // The same upload again is answered from the library, before any encoding: an
  // AVIF pass over a large photo is seconds of CPU that would only reproduce
  // files that already exist. Records from before profiles have no `profile`.
  const existing = await DB_Media.findOne({
    hash,
    profile: kept === "default" ? { $in: ["default", null] } : kept,
  });
  if (existing) return finish(existing);

  if (isSvg) {
    const problem = svgProblem(bytes);
    if (problem) return c.json({ success: 0, error: problem }, 422);

    // Stored exactly as uploaded: no resizing, no transcoding, no separate original.
    const path = pathFor("media", hash, "svg", new Date());
    await write(path, bytes);
    const record = await DB_Media.findOneAndUpdate(
      { path },
      {
        $setOnInsert: {
          path,
          hash,
          profile: "svg",
          mimeType: info.mimeType,
          bytes: bytes.byteLength,
          ...(info.width ? { width: info.width, height: info.height } : {}),
          originalName: upload.name?.slice(0, 255) ?? "",
          uploadedBy: principal.userId,
        },
      },
      { upsert: true, returnDocument: "after" },
    );
    return finish(record);
  }

  let processed: ProcessedImage;
  try {
    processed = await processImage(bytes, PROFILES[profile]);
  } catch (error) {
    if (error instanceof ImageProcessingError) {
      return c.json({ success: 0, error: error.message }, 422);
    }
    throw error;
  }

  const now = new Date();
  const originalPath = pathFor("originals", hash, info.extension, now);
  const placed = processed.variants.map((variant) => ({
    variant,
    path: pathFor("media", hash, variant.format, now, variant.width),
  }));
  const fallback = pickFallback(
    placed.map((entry) => ({ ...entry, format: entry.variant.format, width: entry.variant.width })),
  );

  try {
    await Promise.all([
      write(originalPath, bytes),
      ...placed.map((entry) => write(entry.path, entry.variant.data)),
    ]);
  } catch (error) {
    // Do not leave a half-published set behind; the next attempt starts clean.
    await Promise.allSettled([originalPath, ...placed.map((entry) => entry.path)].map(remove));
    throw error;
  }

  // Upsert rather than insert: two simultaneous uploads of the same file derive
  // the same paths, and the loser should resolve to the winner's record, not fail
  // on the unique index.
  const record = await DB_Media.findOneAndUpdate(
    { path: fallback.path },
    {
      $setOnInsert: {
        path: fallback.path,
        hash,
        profile,
        // What the default `<img src>` is, not what the author sent.
        mimeType: fallback.variant.mimeType,
        bytes: fallback.variant.bytes,
        width: processed.width,
        height: processed.height,
        animated: processed.animated,
        variants: placed.map(({ variant, path }) => ({
          format: variant.format,
          width: variant.width,
          height: variant.height,
          bytes: variant.bytes,
          path,
        })),
        originalPath,
        originalMimeType: info.mimeType,
        originalName: upload.name?.slice(0, 255) ?? "",
        uploadedBy: principal.userId,
      },
    },
    { upsert: true, returnDocument: "after" },
  );

  return finish(record);
});

/**
 * The upload response, and the shape the editor stores in the block.
 *
 * `url` is the plain-`<img>` fallback (an AVIF, or WebP for an animation). `variants` is the full responsive
 * set for `srcset`; records from before image processing have none, and the
 * renderer then falls back to `url` alone.
 */
function describe(
  record: {
    _id: unknown;
    path: string;
    mimeType: string;
    bytes: number;
    width?: number | null;
    height?: number | null;
    variants?: Array<{ format: string; width: number; path: string }>;
  },
  origin: string,
) {
  return {
    url: toPublicUrl(record.path, origin),
    path: record.path,
    ...(record.width ? { width: record.width } : {}),
    ...(record.height ? { height: record.height } : {}),
    variants: (record.variants ?? []).map((variant) => ({
      format: variant.format,
      width: variant.width,
      url: toPublicUrl(variant.path, origin),
    })),
    size: record.bytes,
    mimeType: record.mimeType,
    id: record._id,
  };
}

/** The media library, newest first, for an image picker or a housekeeping screen. */
media.get("/admin", async (c) => {
  const size = Math.min(Number(c.req.query("size")) || 40, 100);
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const origin = new URL(c.req.url).origin;

  const [records, totalCount] = await Promise.all([
    DB_Media.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * size)
      .limit(size),
    DB_Media.countDocuments(),
  ]);

  return c.json({
    data: records.map((record) => {
      // `originalPath` is deliberately left out: it names a private object.
      const { originalPath: _private, ...rest } = record.toObject();
      return { ...rest, ...describe(record, origin), _id: record._id };
    }),
    meta: {
      size,
      page,
      totalPages: Math.ceil(totalCount / size),
      totalCount,
    },
  });
});

/**
 * Removes a file from the library and from disk.
 *
 * Refuses by default when an article still references the image, because the
 * failure mode otherwise is a broken image in published content discovered by a
 * reader. `?force=true` is the escape hatch for when that is the intent.
 */
media.delete("/admin/:id", async (c) => {
  const record = await DB_Media.findById(c.req.param("id"));
  if (!record) return c.json({ error: "Not found" }, 404);

  const references = await lifecycle.countReferences(record.path);
  if (references > 0 && c.req.query("force") !== "true") {
    return c.json(
      {
        error: `Still used by ${references} ${references === 1 ? "document" : "documents"}`,
        references,
      },
      409,
    );
  }

  await destroyRecord(String(record._id));

  return c.json({ deleted: record.path, references });
});

/**
 * Deletes uploads nothing references that have sat past the grace period.
 *
 * The same job runs on a timer (see `media/sweeper.ts`); this is for running it on
 * demand. `?dryRun=true` lists what would go without deleting anything, which is
 * the way to look before the first real run.
 */
media.post("/admin/sweep", async (c) => {
  const result = await lifecycle.sweep({
    graceMs: ORPHAN_GRACE_MS,
    dryRun: c.req.query("dryRun") === "true",
  });
  return c.json(result);
});

/** Reads the optional owner/slot an upload declares. Absent is fine; malformed is not. */
function parseClaim(form: FormData): Claim | null | "invalid" {
  const kind = form.get("ownerKind");
  const id = form.get("ownerId");
  const slot = form.get("slot");
  if (kind === null && id === null && slot === null) return null;

  const claim = { kind: kind as OwnerKind, id: String(id ?? ""), slot: String(slot ?? "") };
  return isValidClaim(claim) ? claim : "invalid";
}

export default media;
