/**
 * Auth failures as data, not exceptions thrown across layers.
 *
 * PORTABILITY: `AuthErrorCode` -> HTTP status mapping lives in exactly one place
 * (`statusForAuthError`). A port to another framework re-uses the map and only
 * replaces how a response is written.
 */

export type AuthErrorCode =
  | "missing_token" // no Authorization header
  | "malformed_token" // not a v4.public PASETO / claims unparseable
  | "invalid_signature"
  | "expired"
  | "not_yet_valid"
  | "wrong_realm" // rid not served by this API
  | "wrong_client" // cid not accepted by this API
  | "session_revoked" // Hades says the session is dead, or a webhook told us so
  | "validator_unavailable" // could not reach Hades and we fail closed
  | "principal_disabled" // locally disabled in THIS api, independent of Hades
  | "forbidden" // authenticated, but lacks the permission
  | "store_unavailable"; // could not read local AuthZ state; fail closed

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  /** Safe to hand back to the caller. Deliberately vague — see Hades invariant I15. */
  readonly publicMessage: string;

  constructor(code: AuthErrorCode, publicMessage?: string, cause?: unknown) {
    super(`${code}${publicMessage ? `: ${publicMessage}` : ""}`, { cause });
    this.name = "AuthError";
    this.code = code;
    this.publicMessage = publicMessage ?? defaultMessage(code);
  }
}

function defaultMessage(code: AuthErrorCode): string {
  switch (code) {
    case "forbidden":
    case "principal_disabled":
      return "Forbidden";
    case "validator_unavailable":
    case "store_unavailable":
      return "Authorization temporarily unavailable";
    default:
      return "Unauthorized";
  }
}

export function statusForAuthError(code: AuthErrorCode): 401 | 403 | 503 {
  switch (code) {
    case "forbidden":
    case "principal_disabled":
      return 403;
    case "validator_unavailable":
    case "store_unavailable":
      return 503;
    default:
      return 401;
  }
}

export function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError;
}
