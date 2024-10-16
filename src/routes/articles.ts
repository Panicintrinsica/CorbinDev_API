import { Hono } from "hono";
import { getXataClient } from "../xata";

const xata = getXataClient();
const articles = new Hono();

articles.post("getWithFilters", async (c) => {
  const { size, offset, tags } = await c.req.json();

  const page = await xata.db.articles
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
    });

  return c.json(page);
});

articles.get("single/:slug", async (c) => {
  const slug = c.req.param("slug");

  const article = await xata.db.articles.filter({ slug: slug }).getFirst();

  return c.json(article);
});

articles.post("search", async (c) => {
  const { searchString } = await c.req.json();

  const sanitizedString = searchString.replace(/[^a-zA-Z0-9 ]/g, "");

  const results = await xata.db.articles.search(sanitizedString, {
    target: ["title", "aboveFold", "tags", "category", "content"],
    boosters: [
      { valueBooster: { column: "tags", value: sanitizedString, factor: 5 } },
    ],
    fuzziness: 2,
    prefix: "phrase",
  });

  const formattedResults = results.records.map((article) => ({
    title: article.title,
    slug: article.slug,
    aboveFold: article.aboveFold,
    tags: article.tags,
    category: article.category,
  }));

  return c.json({
    records: formattedResults,
    totalCount: results.totalCount,
  });
});

export default articles;
