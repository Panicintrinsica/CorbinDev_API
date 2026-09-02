import { Hono } from "hono";
import DB_Article from "../schema/article.schema.ts";
import { createURI, getCurrentDate } from "../util.ts";
import {
  BlockContentError,
  deriveExcerpt,
  derivePlainText,
  normalizeDocument,
  type EditorDocument,
} from "../content/blocks.ts";
import { getAuth, type AuthEnv } from "../auth/index.ts";

/**
 * Articles: a public read surface and a permission-gated authoring surface.
 *
 * Bodies are Editor.js block documents. Everything a client sends goes through
 * `normalizeDocument` before it is stored, so the read routes — and the renderer
 * on the other side of them — can treat what comes out of Mongo as trustworthy.
 *
 * `/articles/admin/*` is gated in `index.ts`; everything else here is public and
 * therefore filters on `isPublished`. Drafts are only reachable through the admin
 * routes.
 */
const articles = new Hono<AuthEnv>();

/** Fields a reader needs for a card. Notably not `content`, which is the whole body. */
const CARD_FIELDS = "title date uri excerpt category tags author createdAt updatedAt";

/** A body larger than this is a runaway client, not an article. */
const MAX_CONTENT_BYTES = 512 * 1024;

// --- Public ------------------------------------------------------------------

/** One published article, addressed the way its URL addresses it. */
articles.get("/", async (c) => {
  const date = c.req.query("date");
  const uri = c.req.query("uri");

  if (!date || !uri) {
    return c.json({ error: "date and uri are required" }, 400);
  }

  const article = await DB_Article.findOne({ date, uri, isPublished: true });
  if (!article) return c.json({ error: "Not found" }, 404);

  return c.json(article);
});

/** A page of published article cards, newest first, optionally filtered by category. */
articles.get("/page", async (c) => {
  const size = Math.min(Number(c.req.query("size")) || 10, 50);
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const categories = c.req.queries("categories");

  try {
    const query: Record<string, unknown> = { isPublished: true };
    if (categories && categories.length > 0) {
      query.category = { $in: categories };
    }

    const [data, totalCount] = await Promise.all([
      DB_Article.find(query, CARD_FIELDS)
        .sort({ createdAt: -1 })
        .skip((page - 1) * size)
        .limit(size),
      DB_Article.countDocuments(query),
    ]);

    const totalPages = Math.ceil(totalCount / size);

    return c.json({
      data,
      meta: {
        size,
        page,
        totalPages,
        isFirstPage: page === 1,
        // An empty collection has no pages, so nothing is "before the last" either.
        isLastPage: page >= totalPages,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

/**
 * Full-text search across published articles.
 *
 * Runs against the `articles_index` Atlas Search index. The body is searched
 * through `plainText` — see the schema for why the block array is not indexed
 * directly — so that index needs a text mapping on `plainText` and `excerpt`
 * where it used to have one on `aboveFold` and `belowFold`.
 */
articles.post("/search", async (c) => {
  const { query } = await c.req.json();

  if (typeof query !== "string" || query.trim() === "") {
    return c.json({ data: [], meta: {} });
  }

  const results = await DB_Article.aggregate([
    {
      $search: {
        index: "articles_index",
        compound: {
          should: [
            {
              text: {
                query,
                path: ["category"],
                score: { constant: { value: 2 } },
              },
            },
            {
              text: {
                query,
                path: ["tags"],
                score: { constant: { value: 1.25 } },
              },
            },
            {
              text: {
                query,
                path: ["title", "excerpt", "plainText", "category", "tags"],
              },
            },
          ],
          mustNot: [{ equals: { value: false, path: "isPublished" } }],
        },
      },
    },
    { $limit: 25 },
    { $addFields: { score: { $meta: "searchScore" } } },
    // Exclusion-only, so it stays a legal projection alongside the added score.
    { $project: { _id: 0, content: 0, plainText: 0 } },
  ]);

  return c.json({ data: results, meta: {} });
});

// --- Authoring ---------------------------------------------------------------

/** Every article including drafts, newest first. Cards only. Supports search, category filter, and pagination. */
articles.get("/admin", async (c) => {
  const size = Math.min(Number(c.req.query("size")) || 25, 100);
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const status = c.req.query("status");
  const category = c.req.query("category");
  const categories = c.req.queries("categories");
  const search = c.req.query("search") || c.req.query("q");
  const tag = c.req.query("tag");
  const title = c.req.query("title");

  const query: Record<string, unknown> = {};
  if (status === "published") query.isPublished = true;
  if (status === "draft") query.isPublished = false;

  if (category && category !== "all") {
    query.category = category;
  } else if (categories && categories.length > 0) {
    query.category = { $in: categories };
  }

  if (tag && tag.trim()) {
    const escapedTag = tag.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.tags = { $regex: new RegExp(`^${escapedTag}$`, "i") };
  }

  if (title && title.trim()) {
    const escapedTitle = title.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.title = { $regex: new RegExp(escapedTitle, "i") };
  }

  if (search && search.trim()) {
    const escapedSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const searchRegex = new RegExp(escapedSearch, "i");
    query.$or = [
      { title: { $regex: searchRegex } },
      { tags: { $regex: searchRegex } },
    ];
  }

  try {
    const [data, totalCount] = await Promise.all([
      DB_Article.find(query, `${CARD_FIELDS} isPublished`)
        .sort({ createdAt: -1 })
        .skip((page - 1) * size)
        .limit(size),
      DB_Article.countDocuments(query),
    ]);

    const totalPages = Math.ceil(totalCount / size);

    return c.json({
      data,
      meta: {
        size,
        page,
        totalPages,
        totalCount,
        isFirstPage: page === 1,
        isLastPage: page >= totalPages,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

/** One article by id, published or not, with its full body for editing. */
articles.get("/admin/:id", async (c) => {
  const article = await DB_Article.findById(c.req.param("id"));
  if (!article) return c.json({ error: "Not found" }, 404);

  return c.json(article);
});

articles.post("/admin", async (c) => {
  const { principal } = getAuth(c);
  const body = await c.req.json();

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return c.json({ error: "title is required" }, 400);

  let content: EditorDocument;
  try {
    content = parseContent(body.content);
  } catch (error) {
    if (error instanceof BlockContentError) return c.json({ error: error.message }, 400);
    throw error;
  }

  const date = getCurrentDate();

  const article = new DB_Article({
    title,
    date,
    // date + uri is the article's permanent address, so the slug is settled once,
    // here, and never recomputed from a later title edit.
    uri: await uniqueUri(createURI(title), date),
    content,
    ...derivedFrom(content, body.excerpt),
    category: typeof body.category === "string" ? body.category : "",
    tags: Array.isArray(body.tags) ? body.tags.filter((t: unknown) => typeof t === "string") : [],
    author: typeof body.author === "string" && body.author ? body.author : principal.userId,
    isPublished: body.isPublished === true,
  });

  await article.save();

  return c.json(article, 201);
});

articles.put("/admin/:id", async (c) => {
  const body = await c.req.json();
  // `plainText` is deselected by default, and a document saved without it loaded
  // is a document one required field away from surprising behaviour.
  const article = await DB_Article.findById(c.req.param("id")).select("+plainText");
  if (!article) return c.json({ error: "Not found" }, 404);

  if (typeof body.title === "string" && body.title.trim()) {
    article.title = body.title.trim();
  }
  if (body.content !== undefined) {
    let content: EditorDocument;
    try {
      content = parseContent(body.content);
    } catch (error) {
      if (error instanceof BlockContentError) return c.json({ error: error.message }, 400);
      throw error;
    }
    article.content = content;
    // `content` is a Mixed path: Mongoose does not track changes inside one, so
    // the change is declared rather than assumed.
    article.markModified("content");
    const derived = derivedFrom(content, body.excerpt);
    article.excerpt = derived.excerpt;
    article.plainText = derived.plainText;
  } else if (typeof body.excerpt === "string") {
    article.excerpt = body.excerpt.trim();
  }

  if (typeof body.category === "string") article.category = body.category;
  if (Array.isArray(body.tags)) {
    article.tags = body.tags.filter((t: unknown) => typeof t === "string");
  }
  if (typeof body.author === "string" && body.author) article.author = body.author;
  if (typeof body.isPublished === "boolean") article.isPublished = body.isPublished;

  // `uri` is only ever changed on an explicit request, because changing it breaks
  // every existing link to the article.
  if (typeof body.uri === "string" && body.uri.trim()) {
    const requested = createURI(body.uri);
    if (requested !== article.uri) {
      article.uri = await uniqueUri(requested, article.date, article.id);
    }
  }

  await article.save();

  return c.json(article);
});

articles.delete("/admin/:id", async (c) => {
  const article = await DB_Article.findByIdAndDelete(c.req.param("id"));
  if (!article) return c.json({ error: "Not found" }, 404);

  return c.json({ deleted: article.id });
});

// --- Helpers -----------------------------------------------------------------

function parseContent(input: unknown): EditorDocument {
  // Measured before normalizing, so a hostile payload is rejected on size rather
  // than walked block by block.
  if (JSON.stringify(input ?? null).length > MAX_CONTENT_BYTES) {
    throw new BlockContentError("content exceeds the maximum article size");
  }
  return normalizeDocument(input);
}

/** An explicit excerpt wins; otherwise one is read off the leading prose. */
function derivedFrom(content: EditorDocument, excerpt: unknown) {
  const explicit = typeof excerpt === "string" ? excerpt.trim() : "";
  return {
    excerpt: explicit || deriveExcerpt(content),
    plainText: derivePlainText(content),
  };
}

/**
 * Settles a slug collision within a date.
 *
 * Two articles written on the same day with the same title would otherwise
 * violate the unique (date, uri) index and surface as a duplicate-key error, so
 * the second one gets a suffix instead.
 */
async function uniqueUri(base: string, date: string, excludeId?: string): Promise<string> {
  const slug = base || "article";

  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? slug : `${slug}-${suffix + 1}`;
    const clash = await DB_Article.exists({
      date,
      uri: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (!clash) return candidate;
  }

  return `${slug}-${Date.now()}`;
}

export default articles;
