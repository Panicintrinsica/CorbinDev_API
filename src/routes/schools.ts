import { Hono } from "hono";

const schools = new Hono();

schools.get("/", async (c) => {
  return c.json({});
});

schools.get("/:id", (c) => {
  return c.json("get schools by id");
});

export default schools;
