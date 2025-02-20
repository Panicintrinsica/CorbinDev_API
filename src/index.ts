import { Hono } from "hono";
import { cors } from "hono/cors";

import articleRouter from "./routes/articles.ts";
import skillsRouter from "./routes/skills.ts";
import projectRouter from "./routes/projects.ts";
import contentRouter from "./routes/content.ts";
import { isAdmin } from "./middleware/auth.ts";

const app = new Hono();

app.use(
  "/*",
  cors({
    origin: ["https://corbin.dev", "http://localhost:4200"],
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use("/*/admin/*", isAdmin());

app.route("/articles", articleRouter);
app.route("/skills", skillsRouter);
app.route("/projects", projectRouter);
app.route("/content", contentRouter);

app.get("ping", async (c) => {
  return c.text("pong");
});

let port = 32020;

Bun.serve({
  fetch: app.fetch,
  port: port,
});

console.log(`Application is running and listening on port ${port}`);
