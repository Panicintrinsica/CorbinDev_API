import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

app.use("/*", cors());

// app.use("/*/admin/*", isAdmin());
//
// app.route("/articles", articleRouter);
// app.route("/skills", skillsRouter);
// app.route("/projects", projectRouter);
// app.route("/content", contentRouter);

app.get("ping", async (c) => {
  return c.text("pong");
});

let port = 5250;

Bun.serve({
  fetch: app.fetch,
  port: port,
});

console.log(`Application is running and listening on port ${port}`);

await Bun.build({
  entrypoints: ["./index.ts"],
  outdir: "./built",
});
