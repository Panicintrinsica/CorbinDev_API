# corbin-backend

BEHOLD, the API code for Corbin.Dev, displayed to prove I can write things.

## Authentication

Identity is handled by [Hades](.claude/skills/hades/SKILL.md), the central auth
service. This API verifies the access tokens it issues and owns its own
authorization data — roles and permissions — in `auth_*` collections.

- Module: [`src/auth/`](src/auth/README.md)
- Policy for this site: [`src/auth.setup.ts`](src/auth.setup.ts)
- Design decisions, written for a future port: [`src/auth/DECISIONS.md`](src/auth/DECISIONS.md)
- Configuration: see `.env.example`. The process **refuses to start** if it cannot
  verify tokens or check revocation.

```
bun test src/tests/auth.test.ts src/tests/auth.engine.test.ts
```

## Articles

Article bodies are [Editor.js](https://editorjs.io) block documents — an ordered
list of typed blocks — not markdown. The block tools the site renders are
`paragraph`, `header`, `list`, `image`, `code`, `quote`, `delimiter` and `table`;
anything else is rejected on write.

Every write goes through [`src/content/blocks.ts`](src/content/blocks.ts), which
validates the document, clamps out-of-range values, and runs the inline HTML
Editor.js embeds in block text through an allow-list. **Nothing else sanitizes
article content** — the read routes and the frontend renderer both treat what is
in Mongo as already clean, so that invariant lives or dies here.

Two fields are derived from `content` on every write and never authored directly:

| Field | For |
|---|---|
| `excerpt` | article cards, search results, `<meta description>`. An explicit value in the request wins; otherwise it is read off the leading prose |
| `plainText` | the whole body flattened, so Atlas Search indexes one text field instead of reaching into a block array whose shape changes with every new tool |

| Route | Auth | Purpose |
|---|---|---|
| `GET /articles?date=&uri=` | — | One published article, addressed as its URL addresses it |
| `GET /articles/page` | — | A page of published cards; `size`, `page`, repeated `categories` |
| `POST /articles/search` | — | Atlas Search over published articles |
| `GET /articles/admin` | `articles:write` | Every article including drafts; `status=published\|draft` |
| `GET /articles/admin/:id` | `articles:write` | One article with its body, published or not |
| `POST /articles/admin` | `articles:write` | Create |
| `PUT /articles/admin/:id` | `articles:write` | Update |
| `DELETE /articles/admin/:id` | `articles:write` | Delete |

`date` and `uri` together are the article's permanent address and are settled at
creation. A later title edit does **not** move them; `PUT` accepts an explicit
`uri` for when moving the article is the actual intent.

> [!IMPORTANT]
> The `articles_index` Atlas Search index still maps the old `aboveFold` and
> `belowFold` fields. Update it to map `excerpt` and `plainText` instead, or
> search will silently stop matching on article bodies.

## Media

Uploaded images are stored **on the filesystem**, not in an object store and not
in Mongo. At this traffic that keeps the deployment to one container plus one
volume, and the whole filesystem seam is confined to
[`src/media/storage.ts`](src/media/storage.ts) so swapping in S3 later means
reimplementing four functions rather than unpicking the routes.

Files are content-addressed — the name is a SHA-256 of the bytes — which is what
makes re-uploading the same image free, lets every URL be cached forever, and
keeps any caller-supplied string out of a filesystem path. The `media` collection
in Mongo is the catalogue over them: original filename, uploader, dimensions.

Format is decided by magic bytes, never by the declared content type or the
filename, and only PNG, JPEG, GIF, WebP, AVIF and SVG get through. Width and height
are read out of the same header so the frontend can reserve layout space before
an image loads.

| Route | Auth | Purpose |
|---|---|---|
| `GET /media/:year/:month/:name` | — | Serves a file, cached immutably |
| `POST /media/admin` | `media:write` | Multipart upload, field `image`; answers in Editor.js' image-tool shape |
| `GET /media/admin` | `media:write` | The media library, newest first |
| `DELETE /media/admin/:id` | `media:write` | Removes it; 409 if any article, skill or project still references it, `?force=true` to override |
| `POST /media/admin/sweep` | `media:write` | Runs the orphan sweep now; `?dryRun=true` reports without deleting |

**Image processing.** The upload is never served as sent. `media/process.ts`
(sharp/libvips) auto-rotates it, strips all metadata including GPS, and writes
AVIF at 480/800/1200/1600/2400px wide — never upscaling, so a 1000px
source gets 480/800/1000. An upload that is already AVIF is not transcoded, only
resized, and its full-size rung is the uploaded file itself when it carries no
EXIF to strip. A `purpose` on the upload selects a profile in `PROFILES`
(`media/process.ts`): `skill/logo` makes one 64px variant instead of the ladder.
**SVG** is stored exactly as uploaded: never resized or transcoded, capped at 10MB,
and refused if it contains script, event handlers, `foreignObject`, entities or
external references (`media/svg.ts`). Animated GIFs become animated WebP (sharp cannot write
animated AVIF). The upload response carries `variants` for `srcset`, and `url` is
the widest variant within 1600px as the fallback for a plain `<img>`. The original is kept at
`originals/YYYY/MM/<hash>.<ext>`, private and never routed, so variants can be
regenerated later. Inputs over 64 megapixels are refused (decompression bombs).
A re-upload of a file already in the library is answered without re-encoding.

**Storage housekeeping.** Identical uploads are one file, so an image is never
"owned" — it is deleted when nothing references it. References are searched in
article, skill and project content, skill `logo` and project `thumbnail`
(`media/lifecycle.ts`, wired in `media/catalog.ts`):

- **On save**, anything the record stopped referencing (an image removed from the
  body, a replaced logo) is deleted unless something else still uses it.
- **On delete** of an article, skill or project, everything it referenced, and
  every upload made on its behalf, is deleted on the same condition.
- **Single-image slots** (`skill/logo`, `project/thumbnail`): an upload may send
  `ownerKind`, `ownerId` and `slot` form fields. A new upload to a slot immediately
  deletes that slot's earlier unsaved uploads, so trying ten icons leaves one.
- **Orphan sweep**: every `MEDIA_SWEEP_INTERVAL_HOURS` (6) uploads nothing
  references, last uploaded more than `MEDIA_ORPHAN_GRACE_HOURS` (24) ago, are
  deleted. The grace period exists because Editor.js uploads when an image is
  inserted, long before the article is first saved. `MEDIA_SWEEP=off` disables it;
  `POST /media/admin/sweep?dryRun=true` shows what a run would delete.

Cleanup never fails a save and never deletes when it cannot check references.

There is deliberately no upload-by-URL: it would have the server fetch an
arbitrary address on a caller's behalf, which is an SSRF primitive aimed at
whatever else lives on the host's network.

Storage is Cloudflare R2 when `STORAGE_PUBLIC_BUCKET` is set (see `.env.example`).
R2 has no per-object ACLs, so there are two buckets: a **public** one holding the
served variants (`media/YYYY/MM/<hash>-<width>.<ext>`), attached to
`MEDIA_BASE_URL` as a custom domain, and a **private** one holding the originals
(`originals/...`), which must never get a public domain. URLs point at
`MEDIA_BASE_URL`, Cloudflare serves them, and `GET /media/...` on the API redirects
there. Unset, files go to `MEDIA_DIR` on local disk.

Cloudflare needs one **Cache Rule** for the image hostname (edge TTL 1 month,
browser TTL 1 year): uploads do not set `Cache-Control`, and the filenames are
content hashes, so the contents of a URL never change.

> [!IMPORTANT]
> Without object storage configured, `MEDIA_DIR` is the only state this container holds
> that is not in Atlas. Mount a volume there — the Dockerfile declares
> `/src/app/media` — or every uploaded image is lost the next time the container
> is replaced.

```
bun test
```
