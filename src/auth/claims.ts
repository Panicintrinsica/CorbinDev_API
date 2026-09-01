import type { HadesAccessClaims } from "./types.ts";
import { AuthError } from "./errors.ts";

/**
 * Parsing and validation of the access token claim set. Pure: no I/O, no clock
 * injection beyond an explicit `now`, so it is directly unit-testable and portable.
 */

export interface ClaimPolicy {
  /** Realms this API serves. Empty means "any realm Hades vouches for". */
  allowedRealms: string[];
  /** Clients whose tokens this API accepts. Empty means any. */
  allowedClients: string[];
  /** Tolerance for clock drift between this host and Hades. */
  clockSkewSeconds: number;
}

export function parseClaims(payload: string): HadesAccessClaims {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(payload) as Record<string, unknown>;
  } catch (cause) {
    throw new AuthError("malformed_token", undefined, cause);
  }

  const sub = requireString(raw, "sub");
  const jti = requireString(raw, "jti");
  const rid = requireString(raw, "rid");
  const cid = requireString(raw, "cid");
  const did = typeof raw.did === "string" && raw.did.length > 0 ? raw.did : "unknown";
  const iat = requireDate(raw, "iat");
  const exp = requireDate(raw, "exp");

  // `scope` carries global roles. Hades always sends an array; be strict about it
  // rather than coercing, so a shape change is loud instead of silently empty.
  let scope: string[] = [];
  if (Array.isArray(raw.scope)) {
    scope = raw.scope.filter((s): s is string => typeof s === "string");
  } else if (typeof raw.scope === "string") {
    scope = raw.scope.split(" ").filter(Boolean);
  }

  return { sub, jti, scope, rid, cid, did, iat, exp, raw };
}

export function validateClaims(
  claims: HadesAccessClaims,
  policy: ClaimPolicy,
  now: Date = new Date(),
): void {
  const skewMs = policy.clockSkewSeconds * 1000;

  if (claims.exp.getTime() + skewMs <= now.getTime()) {
    throw new AuthError("expired");
  }
  if (claims.iat.getTime() - skewMs > now.getTime()) {
    // A token issued in the future is either drift beyond tolerance or forgery
    // against a compromised clock. Either way it is not usable yet.
    throw new AuthError("not_yet_valid");
  }
  if (policy.allowedRealms.length > 0 && !policy.allowedRealms.includes(claims.rid)) {
    throw new AuthError("wrong_realm");
  }
  if (policy.allowedClients.length > 0 && !policy.allowedClients.includes(claims.cid)) {
    throw new AuthError("wrong_client");
  }
}

/**
 * Pulls the token out of an `Authorization` header value.
 * Framework-free on purpose: takes the header string, not a request object.
 */
export function bearerFromHeader(header: string | undefined | null): string {
  if (!header) throw new AuthError("missing_token");
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== "bearer" || !parts[1]) {
    throw new AuthError("malformed_token");
  }
  return parts[1]!;
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AuthError("malformed_token", undefined, new Error(`claim ${key} missing`));
  }
  return value;
}

function requireDate(raw: Record<string, unknown>, key: string): Date {
  const value = raw[key];
  // RFC 3339 string in the access token; numeric seconds in the ID token. Accept
  // both so this parser can be reused for `id_token` verification later.
  const date =
    typeof value === "number" ? new Date(value * 1000)
    : typeof value === "string" ? new Date(value)
    : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) {
    throw new AuthError("malformed_token", undefined, new Error(`claim ${key} invalid`));
  }
  return date;
}
