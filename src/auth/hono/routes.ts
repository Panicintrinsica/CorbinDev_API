import { Hono } from "hono";
import type { AuthEngine } from "../engine.ts";
import type { MongoAuthStore } from "../mongo/store.ts";
import { createAuthMiddleware, getAuth, type AuthEnv } from "./middleware.ts";

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

export function createAuthRouter(engine: AuthEngine, store: MongoAuthStore) {
  const mw = createAuthMiddleware(engine);
  const router = new Hono<AuthEnv>();

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
