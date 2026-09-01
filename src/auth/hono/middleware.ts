import type { Context, MiddlewareHandler, Next } from "hono";
import type { AuthEngine } from "../engine.ts";
import type { AuthContext } from "../types.ts";
import { AuthError, isAuthError, statusForAuthError } from "../errors.ts";
import { satisfies, type PermissionRequirement } from "../authorize.ts";

/**
 * Hono adapter. Everything here is glue: header in, AuthContext into the request
 * scope, AuthError out as a response. No policy — that lives in engine.ts and
 * authorize.ts, which is what keeps a port to another framework small.
 */

export const AUTH_CONTEXT_KEY = "auth" as const;

/** Attach to a Hono app as `new Hono<AuthEnv>()` to get typed `c.get("auth")`. */
export type AuthEnv = {
  Variables: {
    [AUTH_CONTEXT_KEY]: AuthContext;
  };
};

/** Throws if called on a route that is not behind `requireAuth()`. */
export function getAuth(c: Context<AuthEnv>): AuthContext {
  const auth = c.get(AUTH_CONTEXT_KEY);
  if (!auth) throw new Error("getAuth() called outside an authenticated route");
  return auth;
}

/** Returns undefined instead of throwing, for routes using `optionalAuth()`. */
export function tryGetAuth(c: Context<AuthEnv>): AuthContext | undefined {
  return c.get(AUTH_CONTEXT_KEY);
}

export interface HonoAuthMiddleware {
  requireAuth(): MiddlewareHandler<AuthEnv>;
  optionalAuth(): MiddlewareHandler<AuthEnv>;
  require(requirement: PermissionRequirement): MiddlewareHandler<AuthEnv>;
  requirePermission(...permissions: string[]): MiddlewareHandler<AuthEnv>;
  requireAnyPermission(...permissions: string[]): MiddlewareHandler<AuthEnv>;
  requireGlobalRole(...roles: string[]): MiddlewareHandler<AuthEnv>;
}

export function createAuthMiddleware(engine: AuthEngine): HonoAuthMiddleware {
  async function ensureAuthenticated(c: Context<AuthEnv>): Promise<AuthContext> {
    const existing = c.get(AUTH_CONTEXT_KEY);
    if (existing) return existing;
    const auth = await engine.authenticate(c.req.header("Authorization"));
    c.set(AUTH_CONTEXT_KEY, auth);
    return auth;
  }

  const requireAuth = (): MiddlewareHandler<AuthEnv> => async (c, next) => {
    try {
      await ensureAuthenticated(c);
    } catch (error) {
      return authErrorResponse(c, error);
    }
    await next();
  };

  const optionalAuth = (): MiddlewareHandler<AuthEnv> => async (c, next) => {
    // Anonymous is fine; a *bad* token is not silently ignored, because a caller
    // sending credentials that do not work should be told so rather than quietly
    // served the public view.
    if (c.req.header("Authorization")) {
      try {
        await ensureAuthenticated(c);
      } catch (error) {
        return authErrorResponse(c, error);
      }
    }
    await next();
  };

  const require =
    (requirement: PermissionRequirement): MiddlewareHandler<AuthEnv> =>
    async (c, next) => {
      let auth: AuthContext;
      try {
        auth = await ensureAuthenticated(c);
      } catch (error) {
        return authErrorResponse(c, error);
      }
      if (!satisfies(requirement, auth.permissions, auth.claims.scope)) {
        return authErrorResponse(c, new AuthError("forbidden"));
      }
      await next();
    };

  return {
    requireAuth,
    optionalAuth,
    require,
    requirePermission: (...permissions) => require({ allOf: permissions }),
    requireAnyPermission: (...permissions) => require({ anyOf: permissions }),
    requireGlobalRole: (...roles) => require({ globalRoles: roles }),
  };
}

/**
 * The single place an AuthError becomes an HTTP response. The body is deliberately
 * terse — Hades invariant I15's reasoning applies here too: do not narrate to an
 * unauthenticated caller which check they failed beyond what they can already infer.
 */
export function authErrorResponse(c: Context, error: unknown) {
  if (!isAuthError(error)) throw error;
  const status = statusForAuthError(error.code);
  if (status === 503) {
    c.header("Retry-After", "5");
  }
  if (status === 401) {
    c.header("WWW-Authenticate", "Bearer");
  }
  return c.json({ error: error.publicMessage, code: error.code }, status);
}

/** Convenience for handlers that want to assert inside the body of a route. */
export function assertPermission(auth: AuthContext, ...permissions: string[]): void {
  if (!auth.hasAll(...permissions)) throw new AuthError("forbidden");
}

export type { Next };
