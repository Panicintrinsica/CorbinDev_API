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
filename, and only PNG, JPEG, GIF, WebP and AVIF get through. Width and height
are read out of the same header so the frontend can reserve layout space before
an image loads.

| Route | Auth | Purpose |
|---|---|---|
| `GET /media/:year/:month/:name` | — | Serves a file, cached immutably |
| `POST /media/admin` | `media:write` | Multipart upload, field `image`; answers in Editor.js' image-tool shape |
| `GET /media/admin` | `media:write` | The media library, newest first |
| `DELETE /media/admin/:id` | `media:write` | Removes it; 409 if an article still references it, `?force=true` to override |

There is deliberately no upload-by-URL: it would have the server fetch an
arbitrary address on a caller's behalf, which is an SSRF primitive aimed at
whatever else lives on the host's network.

> [!IMPORTANT]
> `MEDIA_DIR` is the only state this container holds that is not in Atlas. Mount a
> volume there — the Dockerfile declares `/src/app/media` — or every uploaded
> image is lost the next time the container is replaced.

```
bun test src/tests/blocks.test.ts src/tests/media.test.ts
```
