import { Hono, type Context } from "hono";
import { getConnInfo } from "hono/bun";
import type { HadesAuthConfig } from "../config.ts";
import type { AuthLogger, AuthStore } from "../ports.ts";
import { parseTrusted, resolveClientIp } from "../client-ip.ts";
import { DEFAULT_DISPLAY_NAME_RULES, normaliseDisplayName } from "../account.ts";
import { unverifiedPayload } from "../paseto.ts";
import { isAuthError } from "../errors.ts";
import { authErrorResponse } from "./middleware.ts";

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
 *  - Hades rate-limits by caller address. Without the caller's address forwarded
 *    (see `client-ip.ts`), every visitor shares this process's bucket.
 *
 * The paths are Hades' own, unchanged, so the frontend's client code is written
 * against the Hades API documentation verbatim and switching this gateway in or out
 * is a base-URL change on the frontend and nothing more.
 *
 * What it deliberately does NOT do:
 *  - inspect, cache, log or reshape bodies — they carry passwords, tokens, recovery
 *    codes and WebAuthn material. The one exception is `POST /auth/register`, which
 *    honours an optional `display_name` (see `registerHandler`),
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

/**
 * Largest request body the gateway will buffer and forward. Every route here carries a
 * small JSON document, and most are reachable without signing in.
 */
export const MAX_FORWARD_BODY_BYTES = 1024 * 1024;

/** `POST /auth/register` is inspected, so it is held to a tighter bound. */
const MAX_REGISTER_BODY_BYTES = 64 * 1024;

/** Longest the gateway waits on Hades for one request. */
const UPSTREAM_TIMEOUT_MS = 15_000;

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
  // `POST /auth/register` is handled separately (display names) and is not in this table.
  { method: "POST", path: "/auth/login", context: true, bearer: false },
  { method: "POST", path: "/auth/refresh", context: true, bearer: false },
  // Logout and the public reset/verify flows take no context headers in Hades.
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
  // Passkey sign-in with no username or password (discoverable credentials / autofill).
  { method: "POST", path: "/mfa/webauthn/login/start", context: true, bearer: false },
  { method: "POST", path: "/mfa/webauthn/login/finish", context: true, bearer: false },

  // --- MFA enrolment: bearer ---------------------------------------------------
  { method: "POST", path: "/mfa/totp/setup", context: false, bearer: true },
  { method: "POST", path: "/mfa/totp/verify", context: false, bearer: true },
  { method: "POST", path: "/mfa/webauthn/register/start", context: false, bearer: true },
  { method: "POST", path: "/mfa/webauthn/register/finish", context: false, bearer: true },

  // --- MFA removal: bearer AND the account password (invariant I12) ------------
  { method: "POST", path: "/mfa/totp/disable", context: false, bearer: true },
  { method: "POST", path: "/mfa/disable", context: false, bearer: true },
  { method: "POST", path: "/mfa/recovery/regenerate", context: false, bearer: true },

  // --- User self-service: bearer -----------------------------------------------
  { method: "GET", path: "/user/profile", context: false, bearer: true },
  { method: "PUT", path: "/user/profile", context: false, bearer: true },
  { method: "POST", path: "/user/password", context: false, bearer: true },
  // Hades reads `X-Client-ID` to find which product's profile URL must be linked back
  // to, so this is both context-stamped and bearer-authenticated.
  { method: "POST", path: "/user/verification/self", context: true, bearer: true },
  { method: "DELETE", path: "/user/account", context: false, bearer: true },
];

export interface HadesProxyOptions {
  /**
   * Needed to honour `display_name` at registration. Without it the field is passed
   * through to Hades untouched (which ignores it) and no account is pre-named.
   */
  store?: AuthStore;
  /**
   * The socket address of the request, for the caller-address Hades rate-limits by.
   * Defaults to Bun's `server.requestIP`, which needs the server passed as the second
   * argument of `fetch` (`app.fetch(req, { server })`). Without it the address is
   * unknown, nothing is sent, and Hades sees only this process.
   */
  peerAddress?: (c: Context) => string | undefined;
}

function bunPeerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

const TOO_LARGE = Symbol("too large");

/** Reads a request body, refusing — without buffering it all — anything over `limit`. */
async function readBounded(request: Request, limit: number): Promise<Uint8Array | typeof TOO_LARGE> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return TOO_LARGE;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function createHadesProxyRouter(
  config: HadesAuthConfig,
  logger: AuthLogger,
  options: HadesProxyOptions = {},
) {
  if (!config.clientId || !config.realmId) {
    throw new Error(
      "HADES_CLIENT_ID and HADES_REALM_ID are required to mount the Hades gateway",
    );
  }
  const clientId = config.clientId;
  const realmId = config.realmId;
  const trusted = parseTrusted(config.trustedProxies);
  const peerAddress = options.peerAddress ?? bunPeerAddress;
  const store = options.store;

  if (trusted.length === 0) {
    logger.debug(
      "AUTH_TRUSTED_PROXIES is empty: callers are identified by the socket address only; set it if this service sits behind a proxy",
    );
  }
  let warnedNoPeer = false;

  const router = new Hono();

  const tooLarge = (c: Context) => c.json({ error: "Request body too large" }, 413);

  /**
   * One fetch, a fixed header set, status and body returned verbatim.
   * `body` is the already-read request body; omit it to read (bounded) from the request.
   */
  async function forward(
    c: Context,
    route: Pick<ProxyRoute, "context" | "bearer">,
    upstreamPath: string,
    method: string,
    body?: Uint8Array,
  ): Promise<Response> {
    const headers: Record<string, string> = {};

    const contentType = c.req.header("Content-Type");
    if (contentType) headers["Content-Type"] = contentType;

    // Who is really calling, so Hades can limit by person and not by this gateway.
    // Replaces whatever the caller sent: this is the address we have vetted.
    const peer = peerAddress(c);
    const caller = resolveClientIp(peer, c.req.header("X-Forwarded-For"), trusted);
    if (caller) {
      headers["X-Forwarded-For"] = caller;
    } else if (!warnedNoPeer) {
      warnedNoPeer = true;
      logger.warn(
        "gateway request has no socket address; pass the Bun server to fetch (app.fetch(req, { server })) or Hades cannot rate-limit by caller",
        { path: upstreamPath },
      );
    }

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

    let payload = body;
    if (payload === undefined && method !== "GET" && method !== "HEAD") {
      const read = await readBounded(c.req.raw, MAX_FORWARD_BODY_BYTES);
      if (read === TOO_LARGE) return tooLarge(c);
      payload = read;
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${config.hadesBaseUrl}${upstreamPath}`, {
        method,
        headers,
        body: payload && payload.length > 0 ? payload : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      logger.error("hades gateway request failed", {
        path: upstreamPath,
        ip: caller ?? "unknown",
        error: String(error),
      });
      return c.json({ error: "Authentication service unavailable" }, 503);
    }

    // Status and body verbatim. Never reshape an auth response: the client's state
    // machine is written against Hades' contract, including its status codes.
    let text: ArrayBuffer;
    try {
      text = await upstream.arrayBuffer();
    } catch (error) {
      logger.error("failed to read the hades response body", {
        path: upstreamPath,
        error: String(error),
      });
      return c.json({ error: "Authentication service unavailable" }, 503);
    }
    const out: Record<string, string> = {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
    };
    // A 429 is only useful to the client if it can see how long to wait.
    const retryAfter = upstream.headers.get("Retry-After");
    if (retryAfter) out["Retry-After"] = retryAfter;
    return new Response(text, { status: upstream.status, headers: out });
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

  // --- Registration, which honours an optional display name ---------------------
  //
  // Hades knows nothing of display names, so the name is checked BEFORE forwarding (a
  // taken name must not leave behind a Hades account the person cannot finish signing
  // up with) and set AFTER Hades succeeds. If someone takes it in between, the account
  // keeps a generated placeholder and the person is asked to choose, as for any new one.

  router.post("/auth/register", async (c) => {
    const read = await readBounded(c.req.raw, MAX_REGISTER_BODY_BYTES);
    if (read === TOO_LARGE) return c.json({ error: "Failed to read request body" }, 400);

    let parsed: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(read));
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      // Not JSON: forwarded untouched, and Hades says so.
    }

    let chosen: string | undefined;
    if (parsed && "display_name" in parsed) {
      const value = parsed.display_name;
      delete parsed.display_name;
      if (typeof value === "string" && value.trim()) chosen = value;
    }

    const rules = DEFAULT_DISPLAY_NAME_RULES;
    let name: string | undefined;
    if (chosen !== undefined && store) {
      const normalised = normaliseDisplayName(chosen, rules);
      if (!normalised) {
        return c.json(
          {
            error: `Display name must be ${rules.min} to ${rules.max} characters.`,
            field: "display_name",
          },
          422,
        );
      }
      try {
        if (await store.displayNameTaken(normalised)) {
          return c.json(
            { error: "That display name is already taken.", field: "display_name" },
            409,
          );
        }
      } catch (error) {
        if (isAuthError(error)) return authErrorResponse(c, error);
        throw error;
      }
      name = normalised;
    }

    // Forward without `display_name` when one was extracted; otherwise byte-for-byte.
    const forwarded =
      chosen !== undefined && parsed ? new TextEncoder().encode(JSON.stringify(parsed)) : read;
    const response = await forward(c, { context: true, bearer: false }, "/auth/register", "POST", forwarded);

    if (!name || !store || !response.ok) return response;

    const bytes = new Uint8Array(await response.arrayBuffer());
    try {
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const token =
        typeof body === "object" && body !== null
          ? (body as { access_token?: unknown }).access_token
          : undefined;
      const claims = typeof token === "string" ? unverifiedPayload(token) : null;
      const sub = typeof claims?.sub === "string" ? claims.sub : undefined;
      if (sub) {
        const lvl = typeof claims?.lvl === "number" && claims.lvl >= 0 ? claims.lvl : 0;
        const account = await store.provisionAccount({
          hadesUserId: sub,
          displayName: name,
          level: lvl,
        });
        await store.updateDisplayName(account.accountId, name);
      }
    } catch (error) {
      // Hades has already created the account; the person is simply asked to choose a
      // name on first sign-in. Never fail a registration that succeeded.
      logger.warn("registered, but could not apply the chosen display name", {
        error: String(error),
      });
    }
    return new Response(bytes, { status: response.status, headers: response.headers });
  });

  // --- Routes with a path parameter, validated before it reaches a URL ---------

  router.put("/mfa/passkeys/:credId", async (c) => {
    const credId = c.req.param("credId");
    if (!CRED_ID_PATTERN.test(credId)) {
      return c.json({ error: "Invalid credential id" }, 400);
    }
    return forward(c, { context: false, bearer: true }, `/mfa/passkeys/${credId}`, "PUT");
  });

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
  "POST /auth/register",
  "PUT /mfa/passkeys/:credId",
  "POST /mfa/passkeys/:credId/revoke",
  "GET /auth/social/:provider/redirect",
  "POST /auth/social/:provider/callback",
] as const;
