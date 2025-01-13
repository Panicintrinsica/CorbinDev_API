import { Hono } from "hono";

const details = new Hono();

details.get("/", async (c) => {
  return c.json({});
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
