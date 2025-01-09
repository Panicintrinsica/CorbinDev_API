import { Hono } from "hono";
import { getXataClient } from "../xata.ts";
import { CacheType, handleCache } from "../services/cache.service.ts";

const xata = getXataClient();

const siteContent = new Hono();

siteContent.get("/:selector", async (c) => {
  const selector = c.req.param("selector");

  const data = await handleCache(
    selector,
    CacheType.CONTENT,
    xata.db.content.filter({ slug: selector }).getFirst(),
  );

  return c.json(data);
});

siteContent.get("/group/:selector", async (c) => {
  const selector = c.req.param("selector");

  const data = await handleCache(
    `g_${selector}`,
    CacheType.CONTENT,
    xata.db.content.filter({ group: selector }).getMany(),
  );

  return c.json(data);
});

export default siteContent;
