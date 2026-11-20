import { Hono } from "hono";
import { cors } from "hono/cors";

import articleRouter from "./routes/articles.ts";
import skillsRouter from "./routes/skills.ts";
import projectRouter from "./routes/projects.ts";
import contentRouter from "./routes/content.ts";
import mediaRouter from "./routes/media.ts";
import profileRouter from "./routes/profile.ts";
import { startMediaSweeper } from "./media/sweeper.ts";
import { auth, PERMISSIONS } from "./auth.setup.ts";
import type { AuthEnv } from "./auth/index.ts";

const app = new Hono<AuthEnv>();

app.use(
  "/*",
  cors({
    origin: ["https://corbin.dev", "http://localhost:4200"],
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
    // X-Device-ID is chosen by the client and forwarded to Hades by the gateway.
    allowHeaders: ["Content-Type", "Authorization", "X-Device-ID"],
  }),
);

// Authorization for the content admin surface. Each write permission is named
// after its resource so a role can be scoped to one section of the site.
app.use("/articles/admin", auth.requirePermission(PERMISSIONS.articlesWrite));
app.use("/articles/admin/*", auth.requirePermission(PERMISSIONS.articlesWrite));
app.use("/projects/admin", auth.requirePermission(PERMISSIONS.projectsWrite));
app.use("/projects/admin/*", auth.requirePermission(PERMISSIONS.projectsWrite));
app.use("/skills/admin", auth.requirePermission(PERMISSIONS.skillsWrite));
app.use("/skills/admin/*", auth.requirePermission(PERMISSIONS.skillsWrite));
app.use("/content/admin", auth.requirePermission(PERMISSIONS.contentWrite));
app.use("/content/admin/*", auth.requirePermission(PERMISSIONS.contentWrite));
app.use("/media/admin", auth.requirePermission(PERMISSIONS.mediaWrite));
app.use("/media/admin/*", auth.requirePermission(PERMISSIONS.mediaWrite));

// The Hades gateway, mounted at the root under Hades' own paths
// (/auth/login, /mfa/*, /user/*, /auth/social/*). The frontend talks only to this
// API; Hades is never reached from a browser, and its client/realm ids stay here.
app.route("/", auth.gatewayRoutes());

// This API's own auth surface: /auth/me, /auth/verify, and local principal/role
// administration. Distinct paths from the gateway's, so the two coexist.
app.route("/auth", auth.routes);
// Account self-service in Charon's wire format: GET /account/me, PUT /account/me/display-name.
app.route("/account", auth.accountRoutes);
// Hades security webhooks (bans, revocations). Register this URL with
// PUT /admin/clients/{client_id}/webhook and put the returned secret in
// HADES_WEBHOOK_SECRET.
app.route("/hooks/hades", auth.webhookRoutes);

app.route("/articles", articleRouter);
app.route("/skills", skillsRouter);
app.route("/projects", projectRouter);
app.route("/content", contentRouter);
// Uploaded images. The serving half is public; /media/admin is gated above.
app.route("/media", mediaRouter);
// A person's own profile picture, keyed by their Hades user id.
app.route("/profile", profileRouter);

app.get("ping", async (c) => {
  return c.text("pong");
});

let port = 32020;

Bun.serve({
  // The server is passed through so the gateway can see the caller's socket address and
  // forward it to Hades, which rate-limits by it (see auth/client-ip.ts).
  fetch: (request, server) => app.fetch(request, { server }),
  port: port,
});

console.log(`Application is running and listening on port ${port}`);

startMediaSweeper();
