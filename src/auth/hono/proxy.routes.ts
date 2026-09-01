import { Hono, type Context } from "hono";
import type { HadesAuthConfig } from "../config.ts";
import type { AuthLogger } from "../ports.ts";

/**
 * Hades gateway. The browser talks to this API and nothing else; this API is the
 * only thing that talks to Hades.
 *
 * Why it exists:
 *  - Every token-issuing Hades route requires `X-Client-ID` and `X-Realm-ID`, and
 *    the client must belong to the realm (invariant I1). Stamping them here means a
 *    browser cannot choose the realm its token is minted for, and the ids are never
 *    published to a client at all.
 *  - One origin for the frontend: no second CORS surface, no second base URL, and
 *    Hades needs no allow-list entry for the site.
 *
 * The paths are Hades' own, unchanged, so the frontend's client code is written
 * against the Hades API documentation verbatim and switching this gateway in or out
 * is a base-URL change on the frontend and nothing more.
 *
 * What it deliberately does NOT do:
 *  - inspect, cache, log or reshape bodies — they carry passwords, tokens, recovery
 *    codes and WebAuthn material,
 *  - add retries: a `401` from `/auth/refresh` means re-authenticate, never retry
 *    (invariant I3),
 *  - implement any auth logic. Hades owns all of it; this forwards.
 *
 * PORTABILITY: the route table below is data. A port re-implements `forward()` — one
 * fetch, a fixed header set, status and body returned verbatim — and reuses the table.
 */

/** Providers Hades implements. An allow-list, so a path parameter cannot be aimed anywhere. */
const SOCIAL_PROVIDERS = ["twitch", "discord", "epic", "steam"] as const;

/** WebAuthn credential ids are base64url. Anything else is not a credential id. */
const CRED_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

interface ProxyRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path on this API and on Hades — they are identical by design. */
  path: string;
  /**
   * Stamp `X-Client-ID` / `X-Realm-ID` / `X-Device-ID`. True for every route Hades
   * runs `request_context()` on: the token-issuing paths and the MFA/social flows
   * that complete them (invariants I1, I5, I10).
   */
  context: boolean;
  /**
   * Forward the caller's `Authorization` header. True for routes Hades authenticates
   * with a bearer token — enrolment, removal and user self-service.
   */
  bearer: boolean;
}

const ROUTES: ProxyRoute[] = [
  // --- Credentials: mint or destroy a session ---------------------------------
  { method: "POST", path: "/auth/register", context: true, bearer: false },
  { method: "POST", path: "/auth/login", context: true, bearer: false },
  { method: "POST", path: "/auth/refresh", context: true, bearer: false },
  // Logout and the public reset/verify flows take no context headers in Hades, but
  // sending them is harmless and keeps one code path.
  { method: "POST", path: "/auth/logout", context: false, bearer: false },
  { method: "POST", path: "/auth/reset-password", context: false, bearer: false },
  { method: "POST", path: "/auth/reset-password/confirm", context: false, bearer: false },
  { method: "POST", path: "/auth/verify-email", context: false, bearer: false },
  { method: "POST", path: "/auth/verify-email/confirm", context: false, bearer: false },

  // --- MFA completion: finishes a login, so it is context-bound ----------------
  { method: "POST", path: "/mfa/verify/totp", context: true, bearer: false },
  // `auth/start` is unauthenticated in both modes (second factor and passwordless).
  { method: "POST", path: "/mfa/webauthn/auth/start", context: true, bearer: false },
  { method: "POST", path: "/mfa/webauthn/auth/finish", context: true, bearer: false },

  // --- MFA enrolment: bearer ---------------------------------------------------
  { method: "POST", path: "/mfa/totp/setup", context: false, bearer: true },
  { method: "POST", path: "/mfa/totp/verify", context: false, bearer: true },
  { method: "POST", path: "/mfa/webauthn/register/start", context: false, bearer: true },
  { method: "POST", path: "/mfa/webauthn/register/finish", context: false, bearer: true },

  // --- MFA removal: bearer AND the account password (invariant I12) ------------
  { method: "POST", path: "/mfa/totp/disable", context: false, bearer: true },
  { method: "POST", path: "/mfa/disable", context: false, bearer: true },
  { method: "POST", path: "/mfa/recovery/regenerate", context: false, bearer: true },

  // --- User self-service: bearer, no context headers ---------------------------
  { method: "GET", path: "/user/profile", context: false, bearer: true },
  { method: "PUT", path: "/user/profile", context: false, bearer: true },
  { method: "POST", path: "/user/password", context: false, bearer: true },
  { method: "DELETE", path: "/user/account", context: false, bearer: true },
];

export function createHadesProxyRouter(config: HadesAuthConfig, logger: AuthLogger) {
  if (!config.clientId || !config.realmId) {
    throw new Error(
      "HADES_CLIENT_ID and HADES_REALM_ID are required to mount the Hades gateway",
    );
  }
  const clientId = config.clientId;
  const realmId = config.realmId;

  const router = new Hono();

  async function forward(
    c: Context,
    route: Pick<ProxyRoute, "context" | "bearer">,
    upstreamPath: string,
    method: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {};

    const contentType = c.req.header("Content-Type");
    if (contentType) headers["Content-Type"] = contentType;

    if (route.context) {
      headers["X-Client-ID"] = clientId;
      headers["X-Realm-ID"] = realmId;
      // Device id is caller-chosen and only scopes sessions. Hades caps it at 128
      // bytes; do the same here so an oversized header is not a 400 round-trip.
      const device = c.req.header("X-Device-ID");
      if (device) headers["X-Device-ID"] = device.slice(0, 128);
    }
    if (route.bearer) {
      const authorization = c.req.header("Authorization");
      if (authorization) headers["Authorization"] = authorization;
    }

    const body = method === "GET" ? undefined : await c.req.text();

    let upstream: Response;
    try {
      upstream = await fetch(`${config.hadesBaseUrl}${upstreamPath}`, {
        method,
        headers,
        body,
        redirect: "manual",
      });
    } catch (error) {
      logger.error("hades gateway request failed", {
        path: upstreamPath,
        error: String(error),
      });
      return c.json({ error: "Authentication service unavailable" }, 503);
    }

    // Status and body verbatim. Never reshape an auth response: the client's state
    // machine is written against Hades' contract, including its status codes.
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      },
    });
  }

  for (const route of ROUTES) {
    const handler = (c: Context) => forward(c, route, route.path, route.method);

    switch (route.method) {
      case "GET":
        router.get(route.path, handler);
        break;
      case "POST":
        router.post(route.path, handler);
        break;
      case "PUT":
        router.put(route.path, handler);
        break;
      case "DELETE":
        router.delete(route.path, handler);
        break;
    }
  }

  // --- Routes with a path parameter, validated before it reaches a URL ---------

  router.post("/mfa/passkeys/:credId/revoke", async (c) => {
    const credId = c.req.param("credId");
    if (!CRED_ID_PATTERN.test(credId)) {
      return c.json({ error: "Invalid credential id" }, 400);
    }
    return forward(
      c,
      { context: false, bearer: true },
      `/mfa/passkeys/${credId}/revoke`,
      "POST",
    );
  });

  router.get("/auth/social/:provider/redirect", async (c) => {
    const provider = c.req.param("provider");
    if (!isKnownProvider(provider)) return c.json({ error: "Unknown provider" }, 400);
    return forward(
      c,
      { context: true, bearer: false },
      `/auth/social/${provider}/redirect`,
      "GET",
    );
  });

  router.post("/auth/social/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    if (!isKnownProvider(provider)) return c.json({ error: "Unknown provider" }, 400);
    return forward(
      c,
      { context: true, bearer: false },
      `/auth/social/${provider}/callback`,
      "POST",
    );
  });

  return router;
}

function isKnownProvider(value: string): value is (typeof SOCIAL_PROVIDERS)[number] {
  return (SOCIAL_PROVIDERS as readonly string[]).includes(value);
}

/** Exported for tests and for documenting the gateway's surface. */
export const PROXIED_ROUTES: ReadonlyArray<Readonly<ProxyRoute>> = ROUTES;
export const PROXIED_PARAM_ROUTES = [
  "POST /mfa/passkeys/:credId/revoke",
  "GET /auth/social/:provider/redirect",
  "POST /auth/social/:provider/callback",
] as const;
