import type { Account, VerificationTier } from "./account.ts";
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

  /** Forgets this API's record of a user. Returns whether one existed. */
  deletePrincipal(userId: string): Promise<boolean>;

  // --- Realm accounts ---------------------------------------------------------

  getAccountByHadesId(hadesUserId: string): Promise<Account | null>;
  getAccount(accountId: string): Promise<Account | null>;

  /**
   * Creates the account for a Hades user, or returns the one they already have.
   * `displayName` is a *placeholder* the system chose: the account starts with
   * `displayNameSet = false` until the person picks one via `updateDisplayName`.
   * Throws `AuthError("display_name_taken")` if another account already uses it.
   * Idempotent under concurrency — the unique index settles it, not a prior read.
   */
  provisionAccount(input: {
    hadesUserId: string;
    displayName: string;
    level: number;
  }): Promise<Account>;

  /** Removes the account for a Hades user. Returns whether one existed. */
  deleteAccountByHadesId(hadesUserId: string): Promise<boolean>;

  /** Records the Hades verification signal. A no-op when there is no account. */
  setAccountVerification(
    hadesUserId: string,
    tier: VerificationTier,
    url: string | null,
  ): Promise<void>;

  updateAccountLevel(accountId: string, level: number): Promise<void>;

  /**
   * Sets the person's chosen name and marks it set. Names are unique across the site,
   * case-insensitively; another account holding it is `display_name_taken`. Keeping or
   * re-casing your own name is fine. `displayName` must already be normalised.
   */
  updateDisplayName(accountId: string, displayName: string): Promise<void>;

  /** The account holding this (normalised) name, case-insensitively, or null. */
  getAccountByDisplayName(displayName: string): Promise<Account | null>;
  displayNameTaken(displayName: string): Promise<boolean>;
  listAccounts(): Promise<Account[]>;

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

  /**
   * Un-records an event whose application failed, so Hades' retry is applied rather
   * than swallowed as a duplicate. Without this, "answer 503 so it is retried" is a lie:
   * the retry would find the id already recorded and be acknowledged without effect.
   */
  forgetWebhookEvent(eventId: string): Promise<void>;
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

  /**
   * Drops any cached verdict for a user. Called when something this process just did
   * (an account deletion, a webhook) makes a cached "live" answer stale.
   */
  invalidateUser?(userId: string): void;
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
