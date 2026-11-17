import { Hono, type Context } from "hono";
import type { AuthEngine } from "../engine.ts";
import type { MongoAuthStore } from "../mongo/store.ts";
import type { AuthLogger } from "../ports.ts";
import { isAuthError } from "../errors.ts";
import {
  DEFAULT_DISPLAY_NAME_RULES,
  normaliseDisplayName,
  toAccountResponseWire,
} from "../account.ts";
import { AUTH_CONTRACT_VERSION, type AuthMetaWire } from "../contract.ts";
import { authErrorResponse, createAuthMiddleware, getAuth, type AuthEnv } from "./middleware.ts";

/**
 * Self-service and AuthZ-administration routes for this API.
 *
 * The boundary, stated once: **account-level management happens in Hades' own
 * application, not here.** This API never creates, suspends, deletes or renames a
 * Hades account, never changes a global role, and never revokes a Hades session. It
 * administers its own record of a user — which roles and permissions they hold here,
 * and whether they are allowed to use this site at all.
 *
 * So a ban issued here is a *site* ban: the user keeps their account, keeps their
 * session, and keeps every other service in the realm. That asymmetry is deliberate
 * and is the reason none of the Hades `/admin/*` routes are proxied.
 *
 * Signup and self-service (profile, password, MFA, passkeys, account deletion) are
 * the user's own to drive and are forwarded to Hades unchanged by the gateway —
 * see `hono/proxy.routes.ts`.
 */

/** Permissions this router guards itself with. Seed them into a role. */
export const AUTH_ADMIN_PERMISSIONS = {
  readPrincipals: "auth:principals:read",
  writePrincipals: "auth:principals:write",
  readRoles: "auth:roles:read",
  writeRoles: "auth:roles:write",
} as const;

/** Longest the gateway waits on Hades when deleting an account on the caller's behalf. */
const DELETE_ACCOUNT_MIN_TIMEOUT_MS = 5000;

/** `{ error, field }` is Charon's `ErrorBody`, which `hades-ng` reads. */
function fieldError(c: Context, status: 409 | 422, error: string) {
  return c.json({ error, field: "display_name" }, status);
}

/**
 * A person renames themselves. Identity (username, email, password) belongs to Hades
 * and is changed there; this is only the name shown on this site.
 */
async function setDisplayName(c: Context<AuthEnv>, store: MongoAuthStore) {
  const auth = getAuth(c);
  const body = (await c.req.json().catch(() => ({}))) as { display_name?: unknown };
  const rules = DEFAULT_DISPLAY_NAME_RULES;
  const name =
    typeof body.display_name === "string" ? normaliseDisplayName(body.display_name, rules) : null;
  if (!name) {
    return fieldError(c, 422, `Display name must be ${rules.min} to ${rules.max} characters.`);
  }
  try {
    await store.updateDisplayName(auth.account.accountId, name);
  } catch (error) {
    if (isAuthError(error) && error.code === "display_name_taken") {
      return fieldError(c, 409, "That display name is already taken.");
    }
    return authErrorResponse(c, error);
  }
  const updated = await store.getAccount(auth.account.accountId);
  if (!updated) return c.json({ error: "Account not found" }, 404);
  return c.json(toAccountResponseWire(updated, auth.principal.roles, [...auth.permissions].sort()));
}

/**
 * Account self-service. Mount at `/account`: `GET /me`, `PUT /me/display-name`.
 * The wire shape is Charon's published contract (snake_case), which `hades-ng` reads.
 */
export function createAccountRouter(engine: AuthEngine, store: MongoAuthStore) {
  const mw = createAuthMiddleware(engine);
  const router = new Hono<AuthEnv>();

  router.get("/me", mw.requireAuth(), (c) => {
    const auth = getAuth(c);
    return c.json(
      toAccountResponseWire(auth.account, auth.principal.roles, [...auth.permissions].sort()),
    );
  });

  router.put("/me/display-name", mw.requireAuth(), (c) => setDisplayName(c, store));

  return router;
}

export function createAuthRouter(
  engine: AuthEngine,
  store: MongoAuthStore,
  deps: { logger: AuthLogger } = { logger: { debug() {}, warn() {}, error() {} } },
) {
  const mw = createAuthMiddleware(engine);
  const router = new Hono<AuthEnv>();

  /**
   * Readiness for deploy checks and monitors: 200 only when this API can really use
   * Hades. The body carries no detail (it is public); the reason goes to the log.
   */
  router.get("/ready", async (c) => {
    try {
      await engine.checkHades();
      return c.json({ ok: true });
    } catch (error) {
      deps.logger.error("readiness check failed", { reason: String(error) });
      return c.json({ ok: false }, 503);
    }
  });

  /**
   * Public: what this API offers, so a client can shape its sign-in and sign-up screens.
   * Charon's `AuthMeta`; `contract_version` is what `hades-ng` checks for compatibility.
   */
  router.get("/meta", (c) => {
    const rules = DEFAULT_DISPLAY_NAME_RULES;
    const meta: AuthMetaWire = {
      contract_version: AUTH_CONTRACT_VERSION,
      domain_name: engine.config.domainName,
      social_providers: engine.config.socialProviders,
      features: { register: true, passkeys: true, passwordless: true, delete_account: true },
      display_name_rules: { min: rules.min, max: rules.max },
    };
    return c.json(meta);
  });

  /** The same rename as `PUT /account/me/display-name`, under the `/auth` prefix. */
  router.put("/account/display-name", mw.requireAuth(), (c) => setDisplayName(c, store));

  /**
   * Deletes the caller's Hades account, then this site's records of them.
   *
   * Hades announces a deletion by webhook too, but that is best-effort and arrives
   * later; doing it here as well means a person who deletes their account is not left
   * with a name and a principal until a webhook happens to land. Order matters: the
   * session is live for the Hades call (it is revoked the moment the account goes), and
   * only a Hades success removes local data, so a wrong password changes nothing
   * anywhere. Both paths are idempotent, so whichever comes second is a no-op.
   */
  router.delete("/account", mw.requireAuth(), async (c) => {
    const auth = getAuth(c);
    const authorization = c.req.header("Authorization");
    if (!authorization) return c.json({ error: "Unauthorized", code: "missing_token" }, 401);

    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    if (typeof body.password !== "string") {
      return c.json({ error: "password is required" }, 400);
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${engine.config.hadesBaseUrl}/user/account`, {
        method: "DELETE",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ password: body.password }),
        redirect: "manual",
        signal: AbortSignal.timeout(
          Math.max(engine.config.sessionValidateTimeoutMs, DELETE_ACCOUNT_MIN_TIMEOUT_MS),
        ),
      });
    } catch (error) {
      deps.logger.error("account deletion could not reach hades", { error: String(error) });
      return c.json({ error: "Authentication service unavailable" }, 502);
    }

    if (!upstream.ok) {
      // Verbatim: a wrong password is Hades to explain.
      return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
      });
    }

    // Hades has already deleted the account. A local failure must not report failure to
    // the person, but it must be loud: the leftovers are orphaned.
    const id = auth.claims.sub;
    await engine.emit({
      type: "account_deleted",
      hadesUserId: id,
      accountId: auth.account.accountId,
    });
    await store
      .deleteAccountByHadesId(id)
      .catch((error) =>
        deps.logger.error("account deleted in Hades but local account cleanup failed", {
          user: id,
          error: String(error),
        }),
      );
    await store
      .deletePrincipal(id)
      .catch((error) =>
        deps.logger.error("account deleted in Hades but local principal cleanup failed", {
          user: id,
          error: String(error),
        }),
      );
    engine.invalidateSessions(id);
    return c.body(null, 204);
  });

  /** Who am I here — the local view, not Hades' profile. */
  router.get("/me", mw.requireAuth(), (c) => {
    const auth = getAuth(c);
    return c.json({
      userId: auth.principal.userId,
      roles: auth.principal.roles,
      permissions: [...auth.permissions].sort(),
      status: auth.principal.status,
      globalRoles: auth.claims.scope,
      realm: auth.claims.rid,
      client: auth.claims.cid,
      device: auth.claims.did,
      session: auth.claims.jti,
      sessionChecked: auth.sessionChecked,
      expiresAt: auth.claims.exp.toISOString(),
    });
  });

  /** Cheap "is this token still good" probe for a frontend. */
  router.get("/verify", mw.requireAuth(), (c) => c.json({ ok: true }));

  // --- Principals ------------------------------------------------------------

  const readPrincipals = mw.require({
    allOf: [AUTH_ADMIN_PERMISSIONS.readPrincipals],
    globalRoles: ["g_superadmin"],
  });
  const writePrincipals = mw.require({
    allOf: [AUTH_ADMIN_PERMISSIONS.writePrincipals],
    globalRoles: ["g_superadmin"],
  });

  router.get("/principals", readPrincipals, async (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    const skip = Number(c.req.query("skip") ?? 0);
    return c.json(
      await store.listPrincipals(
        Number.isFinite(limit) ? limit : 100,
        Number.isFinite(skip) ? skip : 0,
      ),
    );
  });

  router.get("/principals/:userId", readPrincipals, async (c) => {
    const principal = await store.getPrincipal(c.req.param("userId"));
    if (!principal) return c.json({ error: "Not found" }, 404);
    return c.json(principal);
  });

  router.put("/principals/:userId/roles", writePrincipals, async (c) => {
    const body = (await c.req.json()) as { roles?: unknown };
    if (!Array.isArray(body.roles) || body.roles.some((r) => typeof r !== "string")) {
      return c.json({ error: "roles must be an array of strings" }, 400);
    }
    // Absolute, not a merge — the same contract Hades uses for global roles, so the
    // two admin surfaces do not behave differently for the same-looking call.
    const updated = await store.setRoles(c.req.param("userId"), body.roles as string[]);
    engine.invalidateRoleCache();
    return c.json(updated);
  });

  /** Direct grants and withholdings, on top of whatever the roles give. */
  router.put("/principals/:userId/permissions", writePrincipals, async (c) => {
    const body = (await c.req.json()) as {
      directPermissions?: unknown;
      deniedPermissions?: unknown;
    };
    for (const field of ["directPermissions", "deniedPermissions"] as const) {
      const value = body[field];
      if (value !== undefined && (!Array.isArray(value) || value.some((p) => typeof p !== "string"))) {
        return c.json({ error: `${field} must be an array of strings` }, 400);
      }
    }
    const updated = await store.setPermissions(c.req.param("userId"), {
      directPermissions: body.directPermissions as string[] | undefined,
      deniedPermissions: body.deniedPermissions as string[] | undefined,
    });
    return c.json(updated);
  });

  router.put("/principals/:userId/status", writePrincipals, async (c) => {
    const body = (await c.req.json()) as { status?: unknown };
    if (body.status !== "active" && body.status !== "disabled") {
      return c.json({ error: 'status must be "active" or "disabled"' }, 400);
    }
    await store.setStatus(c.req.param("userId"), body.status);
    return c.json({ userId: c.req.param("userId"), status: body.status });
  });

  /**
   * Site ban. Disables the principal here and voids the tokens they already hold
   * against this API. Their Hades account, session and access to other services are
   * untouched — suspending the account itself is done in the Hades application.
   */
  router.post("/principals/:userId/ban", writePrincipals, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === "string" && body.reason ? body.reason : "local:admin_ban";
    return c.json(await store.banPrincipal(c.req.param("userId"), reason));
  });

  /** Lifts a site ban. Sessions killed by the ban are not restored. */
  router.post("/principals/:userId/unban", writePrincipals, async (c) => {
    const updated = await store.unbanPrincipal(c.req.param("userId"));
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json(updated);
  });

  /**
   * Local "log out everywhere, here". Does not touch Hades — the user's sessions
   * elsewhere stay alive, and the Hades-side equivalent is an operator action in the
   * Hades application, not something this API can or should reach for.
   */
  router.post("/principals/:userId/revoke", writePrincipals, async (c) => {
    const now = new Date();
    await store.revokeBefore(c.req.param("userId"), now, "local:admin_revoke");
    return c.json({ userId: c.req.param("userId"), revokedBefore: now.toISOString() });
  });

  /**
   * Forgets this API's record of the user. Not a ban: with auto-provisioning on,
   * their next request recreates it with the default roles. Use `POST .../ban` to
   * keep someone out, and this to reset them or to clear up after a Hades account
   * that no longer exists.
   */
  router.delete("/principals/:userId", writePrincipals, async (c) => {
    const deleted = await store.deletePrincipal(c.req.param("userId"));
    return deleted ? c.json({ deleted: true }) : c.json({ error: "Not found" }, 404);
  });

  // --- Roles -----------------------------------------------------------------

  const readRoles = mw.require({
    allOf: [AUTH_ADMIN_PERMISSIONS.readRoles],
    globalRoles: ["g_superadmin"],
  });
  const writeRoles = mw.require({
    allOf: [AUTH_ADMIN_PERMISSIONS.writeRoles],
    globalRoles: ["g_superadmin"],
  });

  router.get("/roles", readRoles, async (c) => c.json(await store.listRoles()));

  router.put("/roles/:name", writeRoles, async (c) => {
    const body = (await c.req.json()) as {
      permissions?: unknown;
      description?: unknown;
      isDefault?: unknown;
    };
    if (!Array.isArray(body.permissions) || body.permissions.some((p) => typeof p !== "string")) {
      return c.json({ error: "permissions must be an array of strings" }, 400);
    }
    const role = await store.upsertRole({
      name: c.req.param("name"),
      permissions: body.permissions as string[],
      description: typeof body.description === "string" ? body.description : undefined,
      isDefault: body.isDefault === true,
    });
    engine.invalidateRoleCache();
    return c.json(role);
  });

  router.delete("/roles/:name", writeRoles, async (c) => {
    const deleted = await store.deleteRole(c.req.param("name"));
    engine.invalidateRoleCache();
    return deleted ? c.json({ deleted: true }) : c.json({ error: "Not found" }, 404);
  });

  return router;
}
