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

export default articles;
