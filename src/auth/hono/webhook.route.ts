import { Hono } from "hono";
import type { AuthLogger, AuthStore } from "../ports.ts";
import type { HadesAuthConfig } from "../config.ts";
import { applySecurityEvent, verifyWebhook } from "../webhook.ts";
import type { HadesSessionValidator } from "../session.ts";

/**
 * Receiver for Hades security webhooks. Mount at the path registered with
 * `PUT /admin/clients/{client_id}/webhook`.
 *
 * The route reads the RAW body and signs over those bytes — re-serialising parsed
 * JSON would not reproduce them and every signature would fail.
 */
export function createWebhookRouter(deps: {
  config: HadesAuthConfig;
  store: AuthStore;
  logger: AuthLogger;
  /** Optional: lets a delivery drop any cached "session is live" verdict at once. */
  sessionValidator?: Pick<HadesSessionValidator, "invalidateUser">;
}) {
  const router = new Hono();

  router.post("/", async (c) => {
    const rawBody = await c.req.text();
    const verdict = verifyWebhook(
      rawBody,
      {
        signature: c.req.header("X-Hades-Signature"),
        timestamp: c.req.header("X-Hades-Timestamp"),
        eventId: c.req.header("X-Hades-Event-Id"),
        eventType: c.req.header("X-Hades-Event"),
      },
      deps.config.webhookSecret,
      deps.config.webhookToleranceSeconds,
    );

    if (!verdict.ok) {
      deps.logger.warn("rejected webhook delivery", { reason: verdict.reason });
      // 4xx other than 408/429 stops Hades retrying, which is right for a delivery
      // we will never accept. 503 keeps the retries coming while we are misconfigured.
      return c.json({ error: verdict.reason }, verdict.status);
    }

    try {
      const applied = await applySecurityEvent(verdict.event, deps.store, deps.logger);
      if (applied) deps.sessionValidator?.invalidateUser(verdict.event.user_id);
    } catch (error) {
      // Answer 5xx so the event is retried — dropping it would leave a banned user
      // holding a usable access token until it expires.
      deps.logger.error("failed to apply security event", {
        eventId: verdict.event.id,
        error: String(error),
      });
      return c.json({ error: "could not record event" }, 503);
    }

    return c.json({ received: true });
  });

  return router;
}
