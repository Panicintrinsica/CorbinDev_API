import type { Principal, RoleDefinition } from "./types.ts";

/**
 * The ports the auth engine talks to. Everything storage- or network-shaped is
 * behind one of these, which is what makes the engine portable: a port to Express,
 * Fastify or a Rust service re-implements these two interfaces and keeps the rest.
 */

export interface AuthStore {
  /** null when this API has never seen the user. */
  getPrincipal(userId: string): Promise<Principal | null>;

  /**
   * Just-in-time provisioning. Called the first time a valid token arrives for an
   * unknown `sub`. Must be idempotent — two concurrent first requests are normal,
   * and uniqueness is settled by the index, not by a prior read (Hades invariant I8).
   */
  provisionPrincipal(input: {
    userId: string;
    roles: string[];
    displayName?: string;
  }): Promise<Principal>;

  /** Role definitions by name. Missing names are simply absent from the result. */
  getRoles(names: string[]): Promise<RoleDefinition[]>;

  /** Roles marked `isDefault`, used when provisioning. */
  getDefaultRoles(): Promise<RoleDefinition[]>;

  /**
   * Raises the local revocation watermark. Driven by Hades security webhooks, and
   * by local admin action. Tokens issued at or before `at` stop being accepted.
   */
  revokeBefore(userId: string, at: Date, reason: string): Promise<void>;

  /** Local disable/enable, independent of the account's status in Hades. */
  setStatus(userId: string, status: Principal["status"]): Promise<void>;

  /** Best-effort presence. Failures here must never fail a request. */
  touchLastSeen(userId: string, at: Date): Promise<void>;

  /**
   * Records a webhook event id. Returns false when it was already recorded —
   * Hades delivery is at-least-once and must be de-duplicated by the receiver.
   */
  recordWebhookEvent(event: {
    eventId: string;
    type: string;
    userId: string;
    occurredAt: Date;
  }): Promise<boolean>;
}

/**
 * Confirms with Hades that the session behind an access token is still live.
 * Backed by `POST /internal/validate-session`, which is the authoritative check —
 * webhooks are a notification, not a substitute (Hades invariant I23).
 */
export interface SessionValidator {
  isSessionLive(input: {
    jti: string;
    userId: string;
    deviceId: string;
  }): Promise<boolean>;
}

/** Structured, level-tagged logging without binding to a logger. */
export interface AuthLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const consoleAuthLogger: AuthLogger = {
  debug: (m, f) => console.debug(`[auth] ${m}`, f ?? ""),
  warn: (m, f) => console.warn(`[auth] ${m}`, f ?? ""),
  error: (m, f) => console.error(`[auth] ${m}`, f ?? ""),
};
