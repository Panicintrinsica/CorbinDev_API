/**
 * Shared shapes. Nothing in here imports a framework or a driver.
 */

/**
 * The claim set Hades stamps into a v4.public access token.
 * Source: `.claude/skills/hades/docs/agent/architecture.md` -> "Token model".
 *
 * `iat`/`exp` are RFC 3339 *strings* in the access token (the ID token uses numeric
 * seconds instead — do not assume one shape for both).
 */
export interface HadesAccessClaims {
  /** Global user id (UUID). The primary key of a principal in this API too. */
  sub: string;
  /** Session id — equal to the refresh token's `_id` (Hades invariant I17). */
  jti: string;
  /** Global roles from Hades, e.g. ["g_subscriber"]. NOT this API's roles. */
  scope: string[];
  /** Realm id the token was minted for. */
  rid: string;
  /** Client id the token was minted for. */
  cid: string;
  /** Caller-chosen device/session scope. Never a trust boundary on its own. */
  did: string;
  iat: Date;
  exp: Date;
  /** Anything else Hades adds later, kept so nothing is silently dropped. */
  raw: Record<string, unknown>;
}

/** This API's own record of a Hades user. AuthZ lives here, not in Hades. */
export interface Principal {
  /** Hades `sub`. */
  userId: string;
  /** Roles defined by THIS api (e.g. "editor"), distinct from Hades global roles. */
  roles: string[];
  /** Permissions granted straight to the user, on top of the roles'. */
  directPermissions: string[];
  /** Permissions explicitly withheld, applied last. Wins over every grant. */
  deniedPermissions: string[];
  /** Local status. A user can be fine in Hades and disabled here. */
  status: PrincipalStatus;
  /** Non-authoritative cache of display data. Never used to identify anyone. */
  displayName?: string;
  /** Access tokens issued at or before this instant are refused. */
  revokedBefore?: Date;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt?: Date;
}

export type PrincipalStatus = "active" | "disabled";

/** A role as this API defines it. */
export interface RoleDefinition {
  name: string;
  permissions: string[];
  description?: string;
  /** Assigned to every principal provisioned on first sight. */
  isDefault: boolean;
}

/** What a handler gets once authentication and authorization have run. */
export interface AuthContext {
  claims: HadesAccessClaims;
  principal: Principal;
  /** Fully resolved permission set: roles' ∪ direct, minus denied. */
  permissions: ReadonlySet<string>;
  /** True when the session was confirmed live with Hades on this request. */
  sessionChecked: boolean;
  has(permission: string): boolean;
  hasAny(...permissions: string[]): boolean;
  hasAll(...permissions: string[]): boolean;
}
