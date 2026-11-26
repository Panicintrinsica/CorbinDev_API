import { Hono } from "hono";
import { buildFeed, type FeedArticle } from "../content/feed.ts";
import DB_Article from "../schema/article.schema.ts";

/** The public RSS feed. The site proxies it at https://corbin.dev/rss.xml. */
const feed = new Hono();

const FEED_SIZE = 20;

feed.get("/", async (c) => {
  const articles = await DB_Article.find({ isPublished: true })
    .sort({ createdAt: -1 })
    .limit(FEED_SIZE);
  const mediaBase = process.env.MEDIA_BASE_URL || new URL(c.req.url).origin;

  return c.body(buildFeed(articles as unknown as FeedArticle[], mediaBase), 200, {
    "Content-Type": "application/rss+xml; charset=utf-8",
    "Cache-Control": "public, max-age=900",
  });
});

export default feed;
