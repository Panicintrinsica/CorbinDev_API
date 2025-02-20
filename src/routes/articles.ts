import { Hono } from "hono";
import DB_Article from "../schema/article.schema.ts";
import { createURI, getCurrentDate } from "../util.ts";

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

// Search the Articles
articles.post("/search", async (c) => {
  const { query } = await c.req.json();

  const results = await DB_Article.aggregate([
    {
      $search: {
        index: "articles_index",
        compound: {
          should: [
            {
              text: {
                query: query,
                path: ["category"],
                score: {
                  constant: {
                    value: 2,
                  },
                },
              },
            },
            {
              text: {
                query: query,
                path: ["tags"],
                score: {
                  constant: {
                    value: 1.25,
                  },
                },
              },
            },
            {
              text: {
                query: query,
                path: ["title", "aboveFold", "belowFold", "category", "tags"],
              },
            },
          ],
          mustNot: [
            {
              equals: {
                value: false,
                path: "isPublished",
              },
            },
          ],
        },
      },
    },
    {
      $project: {
        _id: 0,
        belowFold: 0,
        score: { $meta: "searchScore" },
      },
    },
  ]);

  return c.json({
    data: results,
    meta: {},
  });
});

articles.post("admin", async (c) => {
  const { title, aboveFold, belowFold, category, tags, author, isPublished } =
    await c.req.json();

  const article = new DB_Article({
    title,
    date: getCurrentDate(),
    uri: createURI(title),
    aboveFold,
    belowFold,
    category,
    tags,
    author,
    isPublished,
  });

  await article.save();

  return c.json(article);
});

export default articles;
