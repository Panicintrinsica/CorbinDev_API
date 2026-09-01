import type { HadesAuthConfig } from "./config.ts";
import type { AuthLogger, SessionValidator } from "./ports.ts";
import { TtlCache } from "./cache.ts";

/**
 * `POST /internal/validate-session` client.
 *
 * Hades answers 200 when a non-revoked `refresh_tokens` row matches the access
 * token's `jti` and the user is not suspended, and 403 for every other case
 * (docs/agent/api/admin.md). It is the authoritative revocation check; the security
 * webhook is only a push notification that lets us react sooner.
 *
 * PORTABILITY: uses global `fetch` and `AbortSignal.timeout`, both standard. The
 * verdict cache is in-process — see cache.ts.
 */
export class HadesSessionValidator implements SessionValidator {
  private readonly cache = new TtlCache<boolean>();

  constructor(
    private readonly config: HadesAuthConfig,
    private readonly logger: AuthLogger,
  ) {}

  async isSessionLive(input: {
    jti: string;
    userId: string;
    deviceId: string;
  }): Promise<boolean> {
    // The key includes every field sent, so a mismatch cannot be served a verdict
    // computed for a different tuple.
    const key = `${input.userId}|${input.jti}|${input.deviceId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const response = await fetch(`${this.config.hadesBaseUrl}/internal/validate-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": this.config.internalApiKey ?? "",
      },
      body: JSON.stringify({
        jti: input.jti,
        user_id: input.userId,
        device_id: input.deviceId,
      }),
      signal: AbortSignal.timeout(this.config.sessionValidateTimeoutMs),
    });

    if (response.status === 200) {
      this.cache.set(key, true, this.config.sessionCacheTtlSeconds);
      return true;
    }
    if (response.status === 403) {
      this.cache.set(key, false, this.config.sessionNegativeCacheTtlSeconds);
      return false;
    }

    // 401/404/5xx are "we did not get an answer", not "the session is dead".
    // Distinguishing them matters: the engine fails closed on a thrown error but
    // must not cache a denial it never actually received.
    this.logger.warn("unexpected status from validate-session", {
      status: response.status,
    });
    throw new Error(`validate-session returned ${response.status}`);
  }

  /** Drops a cached verdict, e.g. when a webhook says the session just died. */
  invalidateUser(_userId: string): void {
    // Keys are per (user, session, device) and there is no index by user, so the
    // cheap correct move is to clear. Entries are short-lived and cheap to rebuild.
    this.cache.clear();
  }
}

/** Used when `sessionValidation: "off"`. Says yes and records why in one place. */
export const alwaysLiveSessionValidator: SessionValidator = {
  async isSessionLive() {
    return true;
  },
};
