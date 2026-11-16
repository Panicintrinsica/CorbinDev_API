/**
 * Events this module hands to the host application, which owns data it cannot see
 * (comments, orders, content authored by an account). Mirrors `charon/src/events.rs`.
 *
 * Delivery is at-least-once — a Hades webhook can be retried and a self-service
 * deletion is also announced by Hades itself — so a handler must be idempotent.
 */

export type HostEvent =
  /**
   * The Hades account is gone. Fired *before* local account records are removed, so
   * `accountId` is still resolvable. `accountId` is null if this site never had one.
   */
  | { type: "account_deleted"; hadesUserId: string; accountId: string | null }
  | { type: "account_level_changed"; hadesUserId: string; accountId: string; level: number }
  | { type: "verification_changed"; hadesUserId: string; accountId: string; tier: string };

export type HostEventHandler = (event: HostEvent) => void | Promise<void>;
