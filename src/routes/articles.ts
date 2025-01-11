import { Hono } from "hono";
import { getXataClient } from "../xata.ts";
import {
  cacheDelete,
  CacheType,
  handleCache,
} from "../services/cache.service.ts";

const xata = getXataClient();
const articles = new Hono();

articles.post("getWithFilters", async (c) => {
  const { size, offset, tags } = await c.req.json();
  const queryKey = Bun.hash(JSON.stringify({ size, offset, tags }));

  const data = await handleCache(
    queryKey.toString(),
    CacheType.SEARCH,
    xata.db.articles
      .select(["title", "slug", "aboveFold", "tags", "category"])
      .filter({
        category: { $any: tags },
      })
      .sort("xata.createdAt", "desc")
      .getPaginated({
        pagination: {
          size,
          offset: Number(offset * size),
        },
      }),
  );

  return c.json(data);
});

articles.get("single/:slug", async (c) => {
  const slug = c.req.param("slug");

  const data = await handleCache(
    slug,
    CacheType.ARTICLE,
    xata.db.articles.filter({ slug: slug }).getFirst(),
  );

  return c.json(data);
});

articles.post("search", async (c) => {
  const { searchString } = await c.req.json();

  const sanitizedString = searchString.replace(/[^a-zA-Z0-9 ]/g, "");

  const results = await xata.db.articles.search(sanitizedString, {
    target: ["title", "aboveFold", "tags", "category", "content"],
    boosters: [
      { valueBooster: { column: "tags", value: sanitizedString, factor: 3 } },
    ],
    fuzziness: 1,
    prefix: "phrase",
  });

  const formattedResults = results.records
    .filter((article) => (article.xata?.score ?? 0) >= 1) // Handle undefined score with default value
    .map((article) => ({
      title: article.title,
      slug: article.slug,
      aboveFold: article.aboveFold,
      tags: article.tags,
      category: article.category,
      xata: article.xata,
    }));

  return c.json({
    records: formattedResults,
    totalCount: results.totalCount,
  });
});

// [ADMIN] List of all articles
articles.get("admin/list", async (c) => {
  const size = Number(c.req.queries("size"));
  const offset = Number(c.req.queries("offset"));

  const page = await xata.db.articles
    .select(["id", "title", "tags", "category"])
    .sort("xata.createdAt", "desc")
    .getPaginated({
      pagination: { size, offset: offset * size },
    });

  return c.json(page);
});

articles.get("admin/list/recent", async (c) => {
  const data = await handleCache(
    "RecentArticles",
    CacheType.COLLECTION,
    xata.db.articles
      .select(["id", "title", "tags", "category"])
      .sort("xata.createdAt", "desc")
      .getPaginated({ pagination: { size: 6 } }),
  );

  return c.json(data);
});

// [ADMIN] Get a single article by ID
articles.get("admin/:id", async (c) => {
  const articleID = c.req.param("id");

  const data = await handleCache(
    "RecentArticles",
    CacheType.ARTICLE,
    xata.db.articles.read(articleID),
  );

  return c.json(data);
});

// [ADMIN] Post a new article
articles.post("admin", async (c) => {
  cacheDelete("RecentArticles", CacheType.COLLECTION);

  return c.json({
    message: "Article Posted",
  });
});

// [ADMIN] Update an existing article
articles.put("admin", async (c) => {
  return c.json({
    message: "Article Posted",
  });
});

// [ADMIN] Delete an article
articles.delete("admin", async (c) => {
  const ArticleID = "PLACEHOLDER";

  cacheDelete(ArticleID, CacheType.ARTICLE);
  cacheDelete("RecentArticles", CacheType.COLLECTION);

  return c.json({
    message: "Article Posted",
  });
});

export default articles;
