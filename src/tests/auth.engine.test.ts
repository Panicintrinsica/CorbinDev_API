import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { AuthEngine } from "../auth/engine.ts";
import { loadAuthConfig, type HadesAuthConfig } from "../auth/config.ts";
import type { AuthStore, SessionValidator } from "../auth/ports.ts";
import type { Principal, RoleDefinition } from "../auth/types.ts";
import { createAuthMiddleware, getAuth, type AuthEnv } from "../auth/hono/middleware.ts";

/**
 * End-to-end coverage of the engine and the Hono adapter using in-memory ports —
 * no MongoDB, no Hades. That this is possible at all is the point of ports.ts.
 */

// --- token minting -------------------------------------------------------------

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
const PUBLIC_KEY_HEX = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");

function mint(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const claims = {
    sub: "user-1",
    jti: "session-1",
    scope: ["g_subscriber"],
    rid: "realm-1",
    cid: "client-1",
    did: "device-1",
    iat: new Date(now - 60_000).toISOString(),
    exp: new Date(now + 900_000).toISOString(),
    ...overrides,
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

// --- in-memory ports -------------------------------------------------------------

class MemoryStore implements AuthStore {
  principals = new Map<string, Principal>();
  roles = new Map<string, RoleDefinition>();
  events = new Set<string>();
  failReads = false;

  async getPrincipal(userId: string) {
    if (this.failReads) throw new Error("mongo is down");
    return this.principals.get(userId) ?? null;
  }
  async provisionPrincipal(input: { userId: string; roles: string[] }) {
    const now = new Date();
    const principal: Principal = {
      userId: input.userId,
      roles: input.roles,
      directPermissions: [],
      deniedPermissions: [],
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.principals.set(input.userId, principal);
    return principal;
  }
  async getRoles(names: string[]) {
    return names.map((n) => this.roles.get(n)).filter((r): r is RoleDefinition => !!r);
  }
  async getDefaultRoles() {
    return [...this.roles.values()].filter((r) => r.isDefault);
  }
  async revokeBefore(userId: string, at: Date) {
    const existing = this.principals.get(userId);
    if (existing) existing.revokedBefore = at;
  }
  async setStatus(userId: string, status: Principal["status"]) {
    const existing = this.principals.get(userId);
    if (existing) existing.status = status;
  }
  async touchLastSeen() {}
  async recordWebhookEvent(event: { eventId: string }) {
    if (this.events.has(event.eventId)) return false;
    this.events.add(event.eventId);
    return true;
  }
}

class FakeValidator implements SessionValidator {
  live = true;
  throws = false;
  calls = 0;
  async isSessionLive() {
    this.calls++;
    if (this.throws) throw new Error("hades unreachable");
    return this.live;
  }
}

function config(overrides: Partial<HadesAuthConfig> = {}): HadesAuthConfig {
  return loadAuthConfig(
    {
      hadesBaseUrl: "http://hades.test",
      pasetoPublicKey: PUBLIC_KEY_HEX,
      internalApiKey: "internal",
      allowedRealms: ["realm-1"],
      allowedClients: ["client-1"],
      ...overrides,
    },
    {},
  );
}

function setup(overrides: Partial<HadesAuthConfig> = {}) {
  const store = new MemoryStore();
  store.roles.set("member", { name: "member", permissions: [], isDefault: true });
  store.roles.set("editor", {
    name: "editor",
    permissions: ["articles:*"],
    isDefault: false,
  });
  const validator = new FakeValidator();
  const engine = new AuthEngine(config(overrides), store, validator, {
    debug: () => {},
    warn: () => {},
    error: () => {},
  });
  return { store, validator, engine };
}

// --- engine ----------------------------------------------------------------------

describe("AuthEngine.authenticate", () => {
  test("provisions an unknown subject with the default roles", async () => {
    const { engine, store } = setup();
    const auth = await engine.authenticate(`Bearer ${mint()}`);

    expect(auth.principal.roles).toEqual(["member"]);
    expect(store.principals.has("user-1")).toBe(true);
    expect(auth.sessionChecked).toBe(true);
  });

  test("resolves permissions from local roles, not from the token scope", async () => {
    const { engine, store } = setup();
    await engine.authenticate(`Bearer ${mint()}`);
    store.principals.get("user-1")!.roles = ["editor"];

    const auth = await engine.authenticate(`Bearer ${mint()}`);
    expect(auth.has("articles:write")).toBe(true);
    expect(auth.has("projects:write")).toBe(false);
    // Global roles stay separate from the permission set.
    expect(auth.claims.scope).toEqual(["g_subscriber"]);
    expect([...auth.permissions]).toEqual(["articles:*"]);
  });

  test("rejects a token issued at or before the local revocation watermark", async () => {
    const { engine, store } = setup();
    await engine.authenticate(`Bearer ${mint()}`);
    store.principals.get("user-1")!.revokedBefore = new Date();

    expect(engine.authenticate(`Bearer ${mint()}`)).rejects.toThrow(/session_revoked/);
  });

  test("rejects a locally disabled principal even when Hades is happy", async () => {
    const { engine, store } = setup();
    await engine.authenticate(`Bearer ${mint()}`);
    store.principals.get("user-1")!.status = "disabled";

    expect(engine.authenticate(`Bearer ${mint()}`)).rejects.toThrow(/principal_disabled/);
  });

  test("rejects a session Hades says is dead", async () => {
    const { engine, validator } = setup();
    validator.live = false;
    expect(engine.authenticate(`Bearer ${mint()}`)).rejects.toThrow(/session_revoked/);
  });

  test("fails closed when the validator is unreachable", async () => {
    const { engine, validator } = setup();
    validator.throws = true;
    expect(engine.authenticate(`Bearer ${mint()}`)).rejects.toThrow(/validator_unavailable/);
  });

  test("fails open only when explicitly configured to", async () => {
    const { engine, validator } = setup({ onValidatorError: "open" });
    validator.throws = true;
    const auth = await engine.authenticate(`Bearer ${mint()}`);
    expect(auth.sessionChecked).toBe(false);
  });

  test("fails closed when the local store cannot be read", async () => {
    const { engine, store } = setup();
    store.failReads = true;
    expect(engine.authenticate(`Bearer ${mint()}`)).rejects.toThrow(/store_unavailable/);
  });

  test("the watermark is checked before Hades is called", async () => {
    const { engine, store, validator } = setup();
    await engine.authenticate(`Bearer ${mint()}`);
    store.principals.get("user-1")!.revokedBefore = new Date();
    const before = validator.calls;

    await engine.authenticate(`Bearer ${mint()}`).catch(() => {});
    expect(validator.calls).toBe(before);
  });

  test("skips session validation entirely when it is turned off", async () => {
    const { engine, validator } = setup({ sessionValidation: "off" });
    const auth = await engine.authenticate(`Bearer ${mint()}`);
    expect(validator.calls).toBe(0);
    expect(auth.sessionChecked).toBe(false);
  });

  test("refuses an unknown subject when auto-provisioning is off", async () => {
    const { engine } = setup({ autoProvision: false });
    expect(engine.authenticate(`Bearer ${mint()}`)).rejects.toThrow(/principal_disabled/);
  });
});

// --- hono adapter -----------------------------------------------------------------

describe("hono middleware", () => {
  function app(engineBundle: ReturnType<typeof setup>) {
    const mw = createAuthMiddleware(engineBundle.engine);
    const server = new Hono<AuthEnv>();
    server.get("/open", (c) => c.text("public"));
    server.get("/private", mw.requireAuth(), (c) => c.json({ user: getAuth(c).principal.userId }));
    server.get("/edit", mw.requirePermission("articles:write"), (c) => c.text("edited"));
    server.get("/admin", mw.requireGlobalRole("g_superadmin"), (c) => c.text("admin"));
    server.get("/maybe", mw.optionalAuth(), (c) =>
      c.json({ authenticated: !!c.get("auth") }),
    );
    return server;
  }

  test("401 without a token, 200 with one", async () => {
    const server = app(setup());
    expect((await server.request("/private")).status).toBe(401);
    const ok = await server.request("/private", {
      headers: { Authorization: `Bearer ${mint()}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ user: "user-1" });
  });

  test("401 carries WWW-Authenticate and a machine-readable code", async () => {
    const res = await app(setup()).request("/private");
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect((await res.json()).code).toBe("missing_token");
  });

  test("403 when authenticated but not permitted", async () => {
    const res = await app(setup()).request("/edit", {
      headers: { Authorization: `Bearer ${mint()}` },
    });
    expect(res.status).toBe(403);
  });

  test("200 once the permission is granted", async () => {
    const bundle = setup();
    await bundle.engine.authenticate(`Bearer ${mint()}`);
    bundle.store.principals.get("user-1")!.roles = ["editor"];

    const res = await app(bundle).request("/edit", {
      headers: { Authorization: `Bearer ${mint()}` },
    });
    expect(res.status).toBe(200);
  });

  test("a Hades global role opens a global-role route", async () => {
    const bundle = setup();
    const res = await app(bundle).request("/admin", {
      headers: { Authorization: `Bearer ${mint({ scope: ["g_superadmin"] })}` },
    });
    expect(res.status).toBe(200);
  });

  test("503, not 401, when the dependency is down", async () => {
    const bundle = setup();
    bundle.validator.throws = true;
    const res = await app(bundle).request("/private", {
      headers: { Authorization: `Bearer ${mint()}` },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
  });

  test("optionalAuth allows anonymous but still rejects a bad token", async () => {
    const server = app(setup());
    const anon = await server.request("/maybe");
    expect(await anon.json()).toEqual({ authenticated: false });

    const bad = await server.request("/maybe", { headers: { Authorization: "Bearer nonsense" } });
    expect(bad.status).toBe(401);
  });

  test("a token for another realm is refused", async () => {
    const res = await app(setup()).request("/private", {
      headers: { Authorization: `Bearer ${mint({ rid: "realm-2" })}` },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("wrong_realm");
  });
});
