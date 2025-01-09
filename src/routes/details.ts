import { Hono } from "hono";
import { getXataClient } from "../xata.ts";

const details = new Hono();
const xata = getXataClient();

details.get("/", async (c) => {
  const details = await xata.db["details"].getAll();
  return c.json(details);
});

details.get("/contact", (c) => {
  return c.json("get all details");
});

details.get("/profile", (c) => {
  return c.json("get all details");
});

details.get("/:id", (c) => {
  return c.json("get detail by id");
});

export default details;
