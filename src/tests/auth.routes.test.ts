import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { AuthEngine } from "../auth/engine.ts";
import { loadAuthConfig } from "../auth/config.ts";
import { createAuthRouter } from "../auth/hono/routes.ts";
import type { MongoAuthStore } from "../auth/mongo/store.ts";
import type { AuthStore } from "../auth/ports.ts";
import type { Principal, RoleDefinition } from "../auth/types.ts";

/**
 * The local AuthZ administration surface. The store is a stub, so these assert the
 * routes' contract: who may call them, what they validate, and which store operation
 * each one maps to. Hades is not involved in any of it — that is the point.
 */

// --- token minting (same shape as the engine tests) ------------------------------

function le64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n) & 0x7fffffffffffffffn, true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_HEX = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");

function mint(scope: string[] = ["g_subscriber"]) {
  const now = Date.now();
  const claims = {
    sub: "user-1",
    jti: "session-1",
    scope,
    rid: "realm-1",
    cid: "client-1",
    did: "device-1",
    iat: new Date(now - 60_000).toISOString(),
    exp: new Date(now + 900_000).toISOString(),
  };
  const encoder = new TextEncoder();
  const message = encoder.encode(JSON.stringify(claims));
  const preAuth = concat([
    le64(4),
    le64(10),
    encoder.encode("v4.public."),
    le64(message.length),
    message,
    le64(0),
    le64(0),
  ]);
  const signature = new Uint8Array(cryptoSign(null, preAuth, privateKey));
  return `v4.public.${Buffer.from(concat([message, signature])).toString("base64url")}`;
}

// --- stub store ------------------------------------------------------------------

const ROLES: RoleDefinition[] = [
  { name: "member", permissions: [], isDefault: true },
  { name: "owner", permissions: ["*", "auth:principals:*", "auth:roles:*"], isDefault: false },
];

function principal(over: Partial<Principal> = {}): Principal {
  const now = new Date();
  return {
    userId: "user-1",
    roles: ["member"],
    directPermissions: [],
    deniedPermissions: [],
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function makeStore(current: Principal = principal()) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
    return Promise.resolve(op === "deletePrincipal" ? true : current);
  };

  const store = {
    calls,
    getPrincipal: async () => current,
    provisionPrincipal: async () => current,
    getRoles: async (names: string[]) => ROLES.filter((r) => names.includes(r.name)),
    getDefaultRoles: async () => ROLES.filter((r) => r.isDefault),
    revokeBefore: record("revokeBefore"),
    setStatus: record("setStatus"),
    touchLastSeen: async () => {},
    recordWebhookEvent: async () => true,
    setRoles: record("setRoles"),
    setPermissions: record("setPermissions"),
    banPrincipal: record("banPrincipal"),
    unbanPrincipal: record("unbanPrincipal"),
    deletePrincipal: record("deletePrincipal"),
    listPrincipals: async () => [current],
    listRoles: async () => ROLES,
    upsertRole: record("upsertRole"),
    deleteRole: record("deleteRole"),
    ensureRoles: async () => {},
  };
  return store;
}

function setup(current?: Principal) {
  const store = makeStore(current);
  const engine = new AuthEngine(
    loadAuthConfig(
      {
        pasetoPublicKey: PUBLIC_KEY_HEX,
        sessionValidation: "off",
        allowedRealms: ["realm-1"],
        allowedClients: ["client-1"],
      },
      {},
    ),
    store as unknown as AuthStore,
    { isSessionLive: async () => true },
    { debug: () => {}, warn: () => {}, error: () => {} },
  );
  const router = createAuthRouter(engine, store as unknown as MongoAuthStore);
  return { store, router };
}

function auth(scope?: string[]) {
  return { headers: { Authorization: `Bearer ${mint(scope)}`, "Content-Type": "application/json" } };
}

const SUPERADMIN = ["g_superadmin"];

// --- tests -----------------------------------------------------------------------

describe("local principal administration", () => {
  test("/me reports local and global authority separately", async () => {
    const { router } = setup(principal({ roles: ["owner"] }));
    const res = await router.request("/me", auth());
    const body = await res.json();

    expect(body.roles).toEqual(["owner"]);
    expect(body.globalRoles).toEqual(["g_subscriber"]);
    expect(body.permissions).toContain("auth:principals:*");
  });

  test("a plain member cannot administer anyone", async () => {
    const { router, store } = setup();
    for (const [path, init] of [
      ["/principals", { method: "GET" }],
      ["/principals/user-2/roles", { method: "PUT", body: '{"roles":[]}' }],
      ["/principals/user-2/ban", { method: "POST", body: "{}" }],
      ["/principals/user-2", { method: "DELETE" }],
    ] as const) {
      const res = await router.request(path, { ...init, ...auth() });
      expect(res.status).toBe(403);
    }
    expect(store.calls).toEqual([]);
  });

  test("a Hades superadmin may administer without a local role", async () => {
    const { router } = setup();
    const res = await router.request("/principals", { ...auth(SUPERADMIN) });
    expect(res.status).toBe(200);
  });

  test("banning is local: it disables and voids tokens here only", async () => {
    const { router, store } = setup();
    const res = await router.request("/principals/user-2/ban", {
      method: "POST",
      body: JSON.stringify({ reason: "spam" }),
      ...auth(SUPERADMIN),
    });

    expect(res.status).toBe(200);
    expect(store.calls).toEqual([{ op: "banPrincipal", args: ["user-2", "spam"] }]);
  });

  test("a ban with no body still records a reason", async () => {
    const { router, store } = setup();
    await router.request("/principals/user-2/ban", { method: "POST", ...auth(SUPERADMIN) });
    expect(store.calls[0]!.args[1]).toBe("local:admin_ban");
  });

  test("unban lifts the ban", async () => {
    const { router, store } = setup();
    const res = await router.request("/principals/user-2/unban", {
      method: "POST",
      ...auth(SUPERADMIN),
    });
    expect(res.status).toBe(200);
    expect(store.calls[0]!.op).toBe("unbanPrincipal");
  });

  test("delete removes the local record", async () => {
    const { router, store } = setup();
    const res = await router.request("/principals/user-2", {
      method: "DELETE",
      ...auth(SUPERADMIN),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(store.calls[0]!.op).toBe("deletePrincipal");
  });

  test("roles are replaced absolutely, and validated", async () => {
    const { router, store } = setup();
    const ok = await router.request("/principals/user-2/roles", {
      method: "PUT",
      body: JSON.stringify({ roles: ["owner"] }),
      ...auth(SUPERADMIN),
    });
    expect(ok.status).toBe(200);
    expect(store.calls[0]).toEqual({ op: "setRoles", args: ["user-2", ["owner"]] });

    const bad = await router.request("/principals/user-2/roles", {
      method: "PUT",
      body: JSON.stringify({ roles: "owner" }),
      ...auth(SUPERADMIN),
    });
    expect(bad.status).toBe(400);
  });

  test("direct grants and denials can be set independently", async () => {
    const { router, store } = setup();
    const res = await router.request("/principals/user-2/permissions", {
      method: "PUT",
      body: JSON.stringify({ deniedPermissions: ["articles:delete"] }),
      ...auth(SUPERADMIN),
    });

    expect(res.status).toBe(200);
    expect(store.calls[0]).toEqual({
      op: "setPermissions",
      args: ["user-2", { directPermissions: undefined, deniedPermissions: ["articles:delete"] }],
    });
  });

  test("rejects a malformed permission list", async () => {
    const { router, store } = setup();
    const res = await router.request("/principals/user-2/permissions", {
      method: "PUT",
      body: JSON.stringify({ directPermissions: [1, 2] }),
      ...auth(SUPERADMIN),
    });
    expect(res.status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  test("no route here reaches a Hades account", async () => {
    // The surface is fixed and local. Anything account-shaped is Hades' own app's.
    const { router } = setup();
    for (const path of [
      "/principals/user-2/suspend-account",
      "/principals/user-2/global-roles",
      "/principals/user-2/password",
    ]) {
      const res = await router.request(path, { method: "POST", ...auth(SUPERADMIN) });
      expect(res.status).toBe(404);
    }
  });
});
