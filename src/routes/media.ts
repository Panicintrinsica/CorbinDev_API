import { Hono } from "hono";
import DB_Article from "../schema/article.schema.ts";
import DB_Media from "../schema/media.schema.ts";
import { identifyImage } from "../media/image.ts";
import {
  MAX_UPLOAD_BYTES,
  pathFromSegments,
  read,
  remove,
  store,
  toPublicUrl,
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

  const bytes = new Uint8Array(await upload.arrayBuffer());
  const info = identifyImage(bytes);
  if (!info) {
    return c.json(
      { success: 0, error: "Unsupported image format — use PNG, JPEG, GIF, WebP or AVIF" },
      415,
    );
  }

  const stored = await store(bytes, info.extension);

  // Upsert rather than insert: storage is content-addressed, so re-uploading a
  // file the library already holds should return the existing entry, not fail on
  // the unique index.
  const record = await DB_Media.findOneAndUpdate(
    { path: stored.path },
    {
      $setOnInsert: {
        path: stored.path,
        hash: stored.hash,
        mimeType: info.mimeType,
        bytes: stored.bytes,
        ...(info.width ? { width: info.width } : {}),
        ...(info.height ? { height: info.height } : {}),
        originalName: upload.name?.slice(0, 255) ?? "",
        uploadedBy: principal.userId,
      },
    },
    { upsert: true, new: true },
  );

  return c.json({
    success: 1,
    file: {
      url: toPublicUrl(stored.path, new URL(c.req.url).origin),
      path: stored.path,
      ...(record?.width ? { width: record.width } : {}),
      ...(record?.height ? { height: record.height } : {}),
      size: record?.bytes ?? stored.bytes,
      mimeType: record?.mimeType ?? info.mimeType,
      id: record?._id,
    },
  });
});

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
    data: records.map((record) => ({
      ...record.toObject(),
      url: toPublicUrl(record.path, origin),
    })),
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

  const references = await countReferences(record.path);
  if (references > 0 && c.req.query("force") !== "true") {
    return c.json(
      {
        error: `Still used by ${references} article${references === 1 ? "" : "s"}`,
        references,
      },
      409,
    );
  }

  await remove(record.path);
  await record.deleteOne();

  return c.json({ deleted: record.path, references });
});

/**
 * How many articles embed this file.
 *
 * Matched on the stored path as a suffix so it finds the image whether the block
 * recorded an absolute URL or a site-relative one.
 */
async function countReferences(path: string): Promise<number> {
  return DB_Article.countDocuments({
    "content.blocks.data.file.url": {
      $regex: `${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    },
  });
}

export default media;
