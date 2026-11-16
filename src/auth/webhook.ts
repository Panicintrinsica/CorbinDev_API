import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthLogger, AuthStore } from "./ports.ts";
import { isVerificationTier } from "./account.ts";
import type { HostEvent } from "./events.ts";

/**
 * Receiver for Hades security webhooks (docs/agent/api/webhooks.md).
 *
 * Contract, restated because getting any of it wrong is a security bug:
 *  - Signature is `v1=HMAC-SHA256(secret, "{timestamp}.{RAW body bytes}")`, hex.
 *    Sign the raw body — re-serialising parsed JSON will not reproduce it.
 *  - Reject a delivery whose timestamp is more than ~300s from our clock.
 *  - Compare in constant time.
 *  - Deduplicate on `X-Hades-Event-Id`: delivery is at-least-once.
 *  - Answer 2xx as soon as the event is durably recorded; do the work after.
 *
 * PORTABILITY: `node:crypto` for HMAC only. Everything else is plain data.
 */

export type HadesEventType =
  | "user_banned"
  | "user_unbanned"
  | "sessions_revoked"
  | "account_level_changed"
  | "verification_changed"
  | "account_deleted";

export interface HadesSecurityEvent {
  id: string;
  type: HadesEventType | string;
  occurred_at: string;
  user_id: string;
  actor_id?: string;
  /** Event-specific payload, e.g. `{ account_level: 10 }`. Absent on the original events. */
  data?: Record<string, unknown>;
}

export interface WebhookHeaders {
  signature: string | undefined;
  timestamp: string | undefined;
  eventId: string | undefined;
  eventType: string | undefined;
}

export type WebhookVerdict =
  | { ok: true; event: HadesSecurityEvent }
  | { ok: false; status: 400 | 401 | 503; reason: string };

/** Pure: raw bytes in, verdict out. No I/O, trivially unit-testable. */
export function verifyWebhook(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string | undefined,
  toleranceSeconds: number,
  now: Date = new Date(),
): WebhookVerdict {
  if (!secret) {
    // No secret configured means we cannot tell a real event from a forged one.
    // Closed, not open — same reasoning as Hades invariant I16.
    return { ok: false, status: 503, reason: "webhook receiver is not configured" };
  }
  if (!headers.signature || !headers.timestamp) {
    return { ok: false, status: 400, reason: "missing signature headers" };
  }

  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, status: 400, reason: "bad timestamp" };
  }
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) {
    return { ok: false, status: 400, reason: "timestamp outside tolerance" };
  }

  const expected = `v1=${createHmac("sha256", secret)
    .update(`${headers.timestamp}.${rawBody}`)
    .digest("hex")}`;
  if (!constantTimeEquals(expected, headers.signature)) {
    return { ok: false, status: 401, reason: "signature mismatch" };
  }

  let event: HadesSecurityEvent;
  try {
    event = JSON.parse(rawBody) as HadesSecurityEvent;
  } catch {
    return { ok: false, status: 400, reason: "body is not JSON" };
  }
  if (!event?.id || !event.type || !event.user_id) {
    return { ok: false, status: 400, reason: "incomplete event" };
  }

  return { ok: true, event };
}

export function constantTimeEquals(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // timingSafeEqual throws on a length mismatch, which is itself a leak of length
  // only — acceptable, and the lengths here are fixed by the format.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Applies a verified event to local state. Idempotent by event id.
 * Returns false when the event was a duplicate and nothing was applied.
 *
 * `emit` tells the host about events only it can act on. If applying throws, the event
 * id is forgotten again before the error propagates, so the retry Hades sends in
 * response to our 5xx is applied instead of being acknowledged as a duplicate.
 */
export async function applySecurityEvent(
  event: HadesSecurityEvent,
  store: AuthStore,
  logger: AuthLogger,
  emit: (event: HostEvent) => Promise<void> = async () => {},
): Promise<boolean> {
  const occurredAt = new Date(event.occurred_at);
  const at = Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;

  const isNew = await store.recordWebhookEvent({
    eventId: event.id,
    type: event.type,
    userId: event.user_id,
    occurredAt: at,
  });
  if (!isNew) {
    logger.debug("duplicate security event ignored", { eventId: event.id });
    return false;
  }

  try {
    await applyNew(event, at, store, logger, emit);
  } catch (error) {
    await store
      .forgetWebhookEvent(event.id)
      .catch((cause) =>
        logger.error("could not release a failed webhook event for retry", {
          eventId: event.id,
          error: String(cause),
        }),
      );
    throw error;
  }
  return true;
}

async function applyNew(
  event: HadesSecurityEvent,
  at: Date,
  store: AuthStore,
  logger: AuthLogger,
  emit: (event: HostEvent) => Promise<void>,
): Promise<void> {
  switch (event.type) {
    case "user_banned":
      // Hades revoked every session. Mirror it locally so we stop honouring
      // already-issued access tokens without waiting for a validate-session call.
      await store.revokeBefore(event.user_id, at, "hades:user_banned");
      await store.setStatus(event.user_id, "disabled");
      break;
    case "sessions_revoked":
      await store.revokeBefore(event.user_id, at, "hades:sessions_revoked");
      break;
    case "user_unbanned":
      // Sessions are NOT restored by an unban — only the ability to authenticate
      // again. The watermark deliberately stays where it is.
      await store.setStatus(event.user_id, "active");
      break;
    case "account_level_changed": {
      const level = event.data?.account_level;
      if (typeof level !== "number" || !Number.isInteger(level) || level < 0) {
        logger.warn("account_level_changed without a usable account_level", { eventId: event.id });
        break;
      }
      const account = await store.getAccountByHadesId(event.user_id);
      // No local account yet: provisioning reads the level from the token instead.
      if (!account) break;
      await store.updateAccountLevel(account.accountId, level);
      await emit({
        type: "account_level_changed",
        hadesUserId: event.user_id,
        accountId: account.accountId,
        level,
      });
      break;
    }
    case "verification_changed": {
      const tier = event.data?.tier;
      if (!isVerificationTier(tier)) {
        logger.warn("verification_changed with a bad tier", { eventId: event.id });
        break;
      }
      const url = typeof event.data?.url === "string" ? event.data.url : null;
      await store.setAccountVerification(event.user_id, tier, url);
      const account = await store.getAccountByHadesId(event.user_id);
      if (account) {
        await emit({
          type: "verification_changed",
          hadesUserId: event.user_id,
          accountId: account.accountId,
          tier,
        });
      }
      break;
    }
    case "account_deleted": {
      // Host first, while the account id is still resolvable.
      const account = await store.getAccountByHadesId(event.user_id);
      await emit({
        type: "account_deleted",
        hadesUserId: event.user_id,
        accountId: account?.accountId ?? null,
      });
      await store.deleteAccountByHadesId(event.user_id);
      await store.deletePrincipal(event.user_id);
      break;
    }
    default:
      logger.warn("unhandled security event type", { type: event.type });
  }
}
