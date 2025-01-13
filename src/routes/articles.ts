import { Hono } from "hono";
import DB_Article from "../schema/article.schema.ts";

const articles = new Hono();

// Get a single article by its date and uri
articles.get("/", async (c) => {
  const date = c.req.queries("date");
  const uri = c.req.queries("uri");

  const article = await DB_Article.findOne({
    date: date,
    uri: uri,
    isPublished: true,
  });

  return c.json(article);
});

articles.get("/list", async (c) => {
  const articles = await DB_Article.find();

  return c.json(articles);
});

// Get the first page of articles
articles.get("page", async (c) => {
  const size = Number(c.req.query("size")) || 10; // Requested page size
  const page = Number(c.req.query("page")) || 1; // Current page number, defaults to 1
  const categories = c.req.queries("categories");

  try {
    const query: any = { isPublished: true };

    if (categories && categories.length > 0) {
      query.category = { $in: categories }; // Filter by tags if provided
    }

    // Calculate the number of documents to skip
    const skip = (page - 1) * size;

    // Fetch the articles
    const articles = await DB_Article.find(
      query,
      "title date uri aboveFold category tags author createdAt updatedAt",
    )
      .sort({ createdAt: -1 }) // Sort descending by creation date
      .skip(skip) // Skip the required number of documents
      .limit(size); // Limit to the requested size

    // Count total number of documents matching the query (for meta purposes)
    const totalCount = await DB_Article.countDocuments(query);

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / size); // Total number of pages
    const isFirstPage = page === 1;
    const isLastPage = page === totalPages;

    return c.json({
      data: articles,
      meta: {
        size,
        page,
        totalPages,
        isFirstPage,
        isLastPage,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default articles;
