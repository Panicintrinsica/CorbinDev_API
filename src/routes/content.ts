import { Hono } from "hono";
import DB_ContentBlock from "../schema/contentBlock.schema.ts";

const siteContent = new Hono();

siteContent.get("/:selector", async (c) => {
  const selector = c.req.param("selector");

  const page = await DB_ContentBlock.find({ page: selector });

  return c.json(page);
});

siteContent.post("admin", async (c) => {
  const { page, uri, title, body } = await c.req.json();

  const block = new DB_ContentBlock({
    page,
    uri,
    title,
    body,
  });

  await block.save();

  return c.json(block);
});

export default siteContent;
