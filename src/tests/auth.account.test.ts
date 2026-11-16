import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { generateKeyPairSync, sign as cryptoSign, createHmac } from "node:crypto";

import { AuthEngine } from "../auth/engine.ts";
import { loadAuthConfig, type HadesAuthConfig } from "../auth/config.ts";
import { InMemoryAuthStore } from "../auth/memory/store.ts";
import { createAccountRouter, createAuthRouter } from "../auth/hono/routes.ts";
import { createAuthMiddleware, type AuthEnv } from "../auth/hono/middleware.ts";
import { createHadesProxyRouter } from "../auth/hono/proxy.routes.ts";
import { createWebhookRouter } from "../auth/hono/webhook.route.ts";
import { applySecurityEvent, type HadesSecurityEvent } from "../auth/webhook.ts";
import { parseTrusted, resolveClientIp } from "../auth/client-ip.ts";
import { unverifiedPayload } from "../auth/paseto.ts";
import type { MongoAuthStore } from "../auth/mongo/store.ts";
import type { HostEvent } from "../auth/events.ts";
import {
  baseTier,
  displayNameKey,
  normaliseDisplayName,
  placeholderDisplayName,
  tierName,
} from "../auth/account.ts";

/**
 * Everything added to follow Charon and the newer Hades: accounts and display names,
 * the account-level / verification / deletion events, `/auth/meta`, the `/account`
 * routes, account deletion, registration with a chosen name, and caller-address
 * resolution. In-memory ports throughout — no MongoDB, no Hades.
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
    sub: "6f1c0d0e-0000-4000-8000-000000000001",
    jti: "session-1",
    scope: ["g_subscriber"],
    rid: "realm-1",
    cid: "client-1",
    did: "device-1",
    lvl: 10,
    ev: true,
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

const USER = "6f1c0d0e-0000-4000-8000-000000000001";
const silent = { debug: () => {}, warn: () => {}, error: () => {} };

function config(overrides: Partial<HadesAuthConfig> = {}) {
  return loadAuthConfig(
    {
      hadesBaseUrl: "http://hades.test",
      pasetoPublicKey: PUBLIC_KEY_HEX,
      clientId: "client-1",
      realmId: "realm-1",
      clientApiKey: "client-key",
      sessionValidation: "off",
      ...overrides,
    },
    {},
  );
}

function setup(overrides: Partial<HadesAuthConfig> = {}) {
  const store = new InMemoryAuthStore();
  const events: HostEvent[] = [];
  const engine = new AuthEngine(
    config(overrides),
    store,
    { isSessionLive: async () => true },
    silent,
    (event) => {
      events.push(event);
    },
  );
  return { store, engine, events };
}

const bearer = (token = mint()) => ({
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
});

// --- the pure parts ------------------------------------------------------------

describe("display names", () => {
  test("trims, collapses whitespace and bounds the length in characters", () => {
    expect(normaliseDisplayName("  Nova   Prime  ")).toBe("Nova Prime");
    expect(normaliseDisplayName("a\t\nb")).toBe("a b");
    expect(normaliseDisplayName("")).toBeNull();
    expect(normaliseDisplayName("   ")).toBeNull();
    expect(normaliseDisplayName("x".repeat(64))).toHaveLength(64);
    expect(normaliseDisplayName("x".repeat(65))).toBeNull();
    // Counted in characters, not UTF-16 units: 64 astral characters are acceptable.
    expect(normaliseDisplayName("𝔸".repeat(64))).not.toBeNull();
    expect(normaliseDisplayName("𝔸".repeat(65))).toBeNull();
  });

  test("refuses control characters that survive whitespace folding", () => {
    expect(normaliseDisplayName("a\u0000b")).toBeNull();
    expect(normaliseDisplayName("a\u001bb")).toBeNull();
  });

  test("uniqueness is case-insensitive but does not fold lookalikes", () => {
    expect(displayNameKey("Nova")).toBe(displayNameKey("nOVA"));
    expect(displayNameKey("nova")).not.toBe(displayNameKey("nоva")); // Cyrillic о
  });

  test("placeholders derive from the user id, then go random on collision", () => {
    expect(placeholderDisplayName("abcdef123", 0)).toBe("Vanguard#abcdef");
    expect(placeholderDisplayName("abcdef123", 0, "Ferryman")).toBe("Ferryman#abcdef");
    expect(placeholderDisplayName("abcdef123", 1)).toMatch(/^Vanguard#[0-9a-f]{8}$/);
  });
});

describe("account levels", () => {
  test("tiers are bands of ten, with everything above 99 a developer", () => {
    expect(tierName(0)).toBe("Iron");
    expect(tierName(9)).toBe("Iron");
    expect(tierName(10)).toBe("Copper");
    expect(tierName(55)).toBe("Platinum");
    expect(tierName(99)).toBe("Ruby");
    expect(tierName(100)).toBe("Alexandrite");
    expect(tierName(4000)).toBe("Alexandrite");
    expect(baseTier(57)).toBe(50);
  });
});

describe("client address resolution", () => {
  const trusted = parseTrusted(["10.0.0.0/8"]);

  test("an untrusted peer ignores the header", () => {
    expect(resolveClientIp("203.0.113.9", "1.2.3.4", trusted)).toBe("203.0.113.9");
    expect(resolveClientIp("203.0.113.9", "1.2.3.4", [])).toBe("203.0.113.9");
  });

  test("a trusted peer gives the forwarded address, and a spoofed left entry is ignored", () => {
    expect(resolveClientIp("10.0.0.5", "198.51.100.7", trusted)).toBe("198.51.100.7");
    expect(resolveClientIp("10.0.0.5", "9.9.9.9, 198.51.100.7", trusted)).toBe("198.51.100.7");
  });

  test("trusted hops are skipped from the right", () => {
    expect(resolveClientIp("10.0.0.5", "198.51.100.7, 10.0.0.9", trusted)).toBe("198.51.100.7");
  });

  test("an all-internal chain gives the nearest entry", () => {
    expect(resolveClientIp("10.0.0.5", "10.1.1.1, 10.2.2.2", trusted)).toBe("10.2.2.2");
  });

  test("garbage or no header falls back to the peer, and no peer is unknown", () => {
    expect(resolveClientIp("10.0.0.5", undefined, trusted)).toBe("10.0.0.5");
    expect(resolveClientIp("10.0.0.5", "1.2.3.4, not-an-ip", trusted)).toBe("10.0.0.5");
    expect(resolveClientIp(undefined, "1.2.3.4", trusted)).toBeUndefined();
  });

  test("an IPv4-mapped peer matches an IPv4 range", () => {
    expect(resolveClientIp("::ffff:10.0.0.5", "198.51.100.7", trusted)).toBe("198.51.100.7");
  });

  test("IPv6 ranges work", () => {
    const v6 = parseTrusted(["fd00::/8"]);
    expect(resolveClientIp("fd00::1", "2001:db8::7", v6)).toBe("2001:db8::7");
    expect(resolveClientIp("2001:db8::1", "1.2.3.4", v6)).toBe("2001:db8::1");
  });

  test("a bad trusted entry is an error, and a bare address is a /32", () => {
    expect(() => parseTrusted(["10.0.0.0/8", "nope"])).toThrow(/AUTH_TRUSTED_PROXIES/);
    expect(() => parseTrusted(["10.0.0.0/33"])).toThrow();
    expect(() => parseTrusted(["172.18.0.5"])).not.toThrow();
    expect(resolveClientIp("172.18.0.5", "198.51.100.7", parseTrusted(["172.18.0.5"]))).toBe(
      "198.51.100.7",
    );
    expect(resolveClientIp("172.18.0.6", "198.51.100.7", parseTrusted(["172.18.0.5"]))).toBe(
      "172.18.0.6",
    );
  });

  test("the config refuses to start with a bad proxy list", () => {
    expect(() => config({ trustedProxies: ["not-a-network"] })).toThrow(/AUTH_TRUSTED_PROXIES/);
  });
});

// --- the engine ----------------------------------------------------------------

describe("accounts in the engine", () => {
  test("first sight provisions an account with a placeholder name and the token's level", async () => {
    const { engine, store } = setup();
    const auth = await engine.authenticate(`Bearer ${mint({ lvl: 30 })}`);

    expect(auth.account.displayName).toBe("Vanguard#6f1c0d");
    expect(auth.account.displayNameSet).toBe(false);
    expect(auth.account.accountLevel).toBe(30);
    expect(auth.claims.lvl).toBe(30);
    expect(auth.claims.ev).toBe(true);
    expect(await store.getAccountByHadesId(USER)).not.toBeNull();
  });

  test("a token without lvl or ev still works, as level zero", async () => {
    const { engine } = setup();
    const auth = await engine.authenticate(`Bearer ${mint({ lvl: undefined, ev: undefined })}`);
    expect(auth.account.accountLevel).toBe(0);
    expect(auth.claims.ev).toBe(false);
  });

  test("a second visit reuses the account", async () => {
    const { engine, store } = setup();
    const first = await engine.authenticate(`Bearer ${mint()}`);
    const second = await engine.authenticate(`Bearer ${mint()}`);
    expect(second.account.accountId).toBe(first.account.accountId);
    expect(store.accounts.size).toBe(1);
  });

  test("a taken placeholder is retried with a random suffix", async () => {
    const { engine, store } = setup();
    // Someone already holds the name this user would be given.
    await store.provisionAccount({ hadesUserId: "other", displayName: "vanguard#6f1c0d", level: 0 });
    const auth = await engine.authenticate(`Bearer ${mint()}`);
    expect(auth.account.displayName).toMatch(/^Vanguard#[0-9a-f]{8}$/);
  });

  test("a locally disabled account is refused", async () => {
    const { engine, store } = setup();
    const first = await engine.authenticate(`Bearer ${mint()}`);
    store.accounts.get(first.account.accountId)!.status = "disabled";
    expect(engine.authenticate(`Bearer ${mint()}`)).rejects.toThrow(/principal_disabled/);
  });

  test("no account is created for an unknown subject when auto-provisioning is off", async () => {
    const { engine, store } = setup({ autoProvision: false });
    expect(engine.authenticate(`Bearer ${mint()}`)).rejects.toThrow(/principal_disabled/);
    expect(store.accounts.size).toBe(0);
  });

  test("an unreadable account store fails closed", async () => {
    const { engine, store } = setup();
    store.getAccountByHadesId = async () => {
      throw new Error("mongo is down");
    };
    expect(engine.authenticate(`Bearer ${mint()}`)).rejects.toThrow(/store_unavailable/);
  });

  test("requireProfiled refuses until a display name is chosen", async () => {
    const { engine, store } = setup();
    const mw = createAuthMiddleware(engine);
    const app = new Hono<AuthEnv>();
    app.get("/profiled", mw.requireProfiled(), (c) => c.json({ ok: true }));
    app.get("/plain", mw.requireAuth(), (c) => c.json({ ok: true }));

    const refused = await app.request("/profiled", bearer());
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("display_name_required");
    expect((await app.request("/plain", bearer())).status).toBe(200);

    const account = (await store.getAccountByHadesId(USER))!;
    await store.updateDisplayName(account.accountId, "Nova");
    expect((await app.request("/profiled", bearer())).status).toBe(200);
  });
});

// --- webhook events ------------------------------------------------------------

function event(
  type: string,
  data?: Record<string, unknown>,
  id: string = crypto.randomUUID(),
): HadesSecurityEvent {
  return { id, type, occurred_at: new Date().toISOString(), user_id: USER, data };
}

describe("account events from Hades", () => {
  test("account_level_changed updates the account and tells the host", async () => {
    const { engine, store, events } = setup();
    const { account } = await engine.authenticate(`Bearer ${mint()}`);

    await applySecurityEvent(event("account_level_changed", { account_level: 40 }), store, silent, (e) =>
      engine.emit(e),
    );

    expect((await store.getAccount(account.accountId))!.accountLevel).toBe(40);
    expect(events).toEqual([
      { type: "account_level_changed", hadesUserId: USER, accountId: account.accountId, level: 40 },
    ]);
  });

  test("a level change with no usable level, or no account yet, changes nothing", async () => {
    const { store, events } = setup();
    const emit = async (e: HostEvent) => void events.push(e);
    await applySecurityEvent(event("account_level_changed", { account_level: "ten" }), store, silent, emit);
    await applySecurityEvent(event("account_level_changed", { account_level: -1 }), store, silent, emit);
    await applySecurityEvent(event("account_level_changed", { account_level: 20 }), store, silent, emit);
    expect(events).toEqual([]);
    expect(store.accounts.size).toBe(0);
  });

  test("verification_changed records the tier and link, and refuses an unknown tier", async () => {
    const { engine, store, events } = setup();
    const { account } = await engine.authenticate(`Bearer ${mint()}`);
    const emit = (e: HostEvent) => engine.emit(e);

    await applySecurityEvent(
      event("verification_changed", { tier: "self", url: "https://example.com/me" }),
      store,
      silent,
      emit,
    );
    const updated = (await store.getAccount(account.accountId))!;
    expect(updated.verificationTier).toBe("self");
    expect(updated.verificationUrl).toBe("https://example.com/me");
    expect(events).toEqual([
      { type: "verification_changed", hadesUserId: USER, accountId: account.accountId, tier: "self" },
    ]);

    await applySecurityEvent(event("verification_changed", { tier: "godlike" }), store, silent, emit);
    expect((await store.getAccount(account.accountId))!.verificationTier).toBe("self");
    expect(events).toHaveLength(1);
  });

  test("account_deleted tells the host first, then forgets the account and the principal", async () => {
    const { engine, store, events } = setup();
    const { account } = await engine.authenticate(`Bearer ${mint()}`);
    const order: string[] = [];
    const emit = async (e: HostEvent) => {
      // The account must still be resolvable when the host hears about it.
      order.push(`emit:${(await store.getAccount(account.accountId)) ? "present" : "gone"}`);
      await engine.emit(e);
    };

    await applySecurityEvent(event("account_deleted"), store, silent, emit);

    expect(order).toEqual(["emit:present"]);
    expect(events).toEqual([{ type: "account_deleted", hadesUserId: USER, accountId: account.accountId }]);
    expect(await store.getAccountByHadesId(USER)).toBeNull();
    expect(await store.getPrincipal(USER)).toBeNull();
  });

  test("a redelivered event is applied once", async () => {
    const { engine, store, events } = setup();
    await engine.authenticate(`Bearer ${mint()}`);
    const e = event("account_level_changed", { account_level: 20 }, "evt-1");
    const emit = (ev: HostEvent) => engine.emit(ev);

    expect(await applySecurityEvent(e, store, silent, emit)).toBe(true);
    expect(await applySecurityEvent(e, store, silent, emit)).toBe(false);
    expect(events).toHaveLength(1);
  });

  test("an event that fails to apply is released, so Hades' retry is applied", async () => {
    const { engine, store } = setup();
    const { account } = await engine.authenticate(`Bearer ${mint()}`);
    const real = store.updateAccountLevel.bind(store);
    let failures = 1;
    store.updateAccountLevel = async (id, level) => {
      if (failures-- > 0) throw new Error("mongo blip");
      return real(id, level);
    };
    const e = event("account_level_changed", { account_level: 50 }, "evt-retry");

    expect(applySecurityEvent(e, store, silent)).rejects.toThrow(/mongo blip/);
    await Bun.sleep(0);
    // The retry must not be swallowed as a duplicate.
    expect(await applySecurityEvent(e, store, silent)).toBe(true);
    expect((await store.getAccount(account.accountId))!.accountLevel).toBe(50);
  });

  test("a throwing host handler never fails the delivery", async () => {
    const store = new InMemoryAuthStore();
    const engine = new AuthEngine(config(), store, { isSessionLive: async () => true }, silent, () => {
      throw new Error("host is broken");
    });
    await engine.authenticate(`Bearer ${mint()}`);
    const applied = await applySecurityEvent(
      event("account_level_changed", { account_level: 20 }),
      store,
      silent,
      (e) => engine.emit(e),
    );
    expect(applied).toBe(true);
  });
});

describe("the webhook receiver", () => {
  const SECRET = "whsec_test";

  function signed(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
    const signature = `v1=${createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex")}`;
    return {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "X-Hades-Signature": signature,
        "X-Hades-Timestamp": timestamp,
        "X-Hades-Event-Id": "evt-x",
      },
    };
  }

  test("applies a signed account_level_changed end to end, and 503s a failure", async () => {
    const { engine, store, events } = setup({ webhookSecret: SECRET });
    const { account } = await engine.authenticate(`Bearer ${mint()}`);
    const router = createWebhookRouter({
      config: engine.config,
      store,
      logger: silent,
      emit: (e) => engine.emit(e),
    });

    const body = JSON.stringify(event("account_level_changed", { account_level: 60 }, "evt-wh"));
    expect((await router.request("/", signed(body))).status).toBe(200);
    expect((await store.getAccount(account.accountId))!.accountLevel).toBe(60);
    expect(events).toHaveLength(1);

    store.deleteAccountByHadesId = async () => {
      throw new Error("mongo blip");
    };
    const failing = JSON.stringify(event("account_deleted", undefined, "evt-wh-2"));
    expect((await router.request("/", signed(failing))).status).toBe(503);
    expect(store.events.has("evt-wh-2")).toBe(false);
  });
});

// --- routes --------------------------------------------------------------------

function routes(overrides: Partial<HadesAuthConfig> = {}) {
  const ctx = setup(overrides);
  const asMongo = ctx.store as unknown as MongoAuthStore;
  const auth = createAuthRouter(ctx.engine, asMongo, { logger: silent });
  const account = createAccountRouter(ctx.engine, asMongo);
  return { ...ctx, auth, account };
}

describe("GET /auth/meta", () => {
  test("is public and reports Charon's contract", async () => {
    const { auth } = routes({ domainName: "corbin.dev", socialProviders: ["discord", "twitch"] });
    const res = await auth.request("/meta");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      contract_version: 1,
      domain_name: "corbin.dev",
      social_providers: ["discord", "twitch"],
      features: { register: true, passkeys: true, passwordless: true, delete_account: true },
      display_name_rules: { min: 1, max: 64 },
    });
  });
});

describe("/account", () => {
  test("GET /me is the account in Charon's snake_case, plus roles and permissions", async () => {
    const { account, store } = routes();
    await store.roles.set("member", { name: "member", permissions: ["x:read"], isDefault: true });
    const res = await account.request("/me", bearer(mint({ lvl: 55 })));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      hades_user_id: USER,
      display_name: "Vanguard#6f1c0d",
      display_name_set: false,
      account_level: 55,
      tier_name: "Platinum",
      base_tier: 50,
      verification_tier: "none",
      verification_url: null,
      status: "active",
      roles: ["member"],
      effective_permissions: ["x:read"],
      extra: {},
    });
    expect(typeof body.account_id).toBe("string");
    expect(typeof body.created_at).toBe("string");
  });

  test("GET /me needs a token", async () => {
    const { account } = routes();
    expect((await account.request("/me")).status).toBe(401);
  });

  test("PUT /me/display-name sets the name and marks it chosen", async () => {
    const { account } = routes();
    const res = await account.request("/me/display-name", {
      method: "PUT",
      body: JSON.stringify({ display_name: "  Nova   Prime " }),
      ...bearer(),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.display_name).toBe("Nova Prime");
    expect(body.display_name_set).toBe(true);
    // The full response shape, so a client typed for either variant is satisfied.
    expect(body.tier_name).toBeDefined();
  });

  test("a bad name is 422 with the field named", async () => {
    const { account } = routes();
    for (const display_name of ["", "   ", "x".repeat(65), 42, undefined]) {
      const res = await account.request("/me/display-name", {
        method: "PUT",
        body: JSON.stringify({ display_name }),
        ...bearer(),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: "Display name must be 1 to 64 characters.",
        field: "display_name",
      });
    }
  });

  test("a name someone else holds is 409, in any casing; your own is fine", async () => {
    const { account, store } = routes();
    await store.provisionAccount({ hadesUserId: "other", displayName: "Nova", level: 0 });

    const taken = await account.request("/me/display-name", {
      method: "PUT",
      body: JSON.stringify({ display_name: "NOVA" }),
      ...bearer(),
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({
      error: "That display name is already taken.",
      field: "display_name",
    });

    const mine = { method: "PUT", ...bearer() };
    await account.request("/me/display-name", { ...mine, body: JSON.stringify({ display_name: "Orion" }) });
    const recased = await account.request("/me/display-name", {
      ...mine,
      body: JSON.stringify({ display_name: "ORION" }),
    });
    expect(recased.status).toBe(200);
  });

  test("the same rename is available under /auth", async () => {
    const { auth } = routes();
    const res = await auth.request("/account/display-name", {
      method: "PUT",
      body: JSON.stringify({ display_name: "Nova" }),
      ...bearer(),
    });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /auth/account", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stub(status: number, body = "{}") {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      return new Response(status === 204 ? null : body, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return seen;
  }

  test("deletes in Hades first, then locally, and tells the host before the records go", async () => {
    const { auth, store, events } = routes();
    const token = mint();
    await auth.request("/me", bearer(token)); // provisions
    const first = (await store.getAccountByHadesId(USER))!;
    const seen = stub(204);

    const res = await auth.request("/account", {
      method: "DELETE",
      body: JSON.stringify({ password: "hunter2" }),
      ...bearer(token),
    });

    expect(res.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://hades.test/user/account");
    expect(seen[0]!.init.method).toBe("DELETE");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    expect(seen[0]!.init.body).toBe('{"password":"hunter2"}');
    expect(events).toEqual([{ type: "account_deleted", hadesUserId: USER, accountId: first.accountId }]);
    expect(await store.getAccountByHadesId(USER)).toBeNull();
    expect(await store.getPrincipal(USER)).toBeNull();
  });

  test("a wrong password changes nothing anywhere, and Hades' answer comes back verbatim", async () => {
    const { auth, store, events } = routes();
    const token = mint();
    await auth.request("/me", bearer(token));
    stub(401, '{"error":"Invalid password"}');

    const res = await auth.request("/account", {
      method: "DELETE",
      body: JSON.stringify({ password: "nope" }),
      ...bearer(token),
    });

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"error":"Invalid password"}');
    expect(events).toEqual([]);
    expect(await store.getAccountByHadesId(USER)).not.toBeNull();
    expect(await store.getPrincipal(USER)).not.toBeNull();
  });

  test("502 when Hades cannot be reached, with nothing deleted", async () => {
    const { auth, store } = routes();
    const token = mint();
    await auth.request("/me", bearer(token));
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const res = await auth.request("/account", {
      method: "DELETE",
      body: JSON.stringify({ password: "pw" }),
      ...bearer(token),
    });
    expect(res.status).toBe(502);
    expect(await store.getAccountByHadesId(USER)).not.toBeNull();
  });

  test("a password is required, and a request without one never reaches Hades", async () => {
    const { auth } = routes();
    const seen = stub(204);
    const res = await auth.request("/account", { method: "DELETE", body: "{}", ...bearer() });
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  test("a local cleanup failure does not report failure after Hades succeeded", async () => {
    const { auth, store } = routes();
    const token = mint();
    await auth.request("/me", bearer(token));
    stub(204);
    store.deleteAccountByHadesId = async () => {
      throw new Error("mongo blip");
    };
    const res = await auth.request("/account", {
      method: "DELETE",
      body: JSON.stringify({ password: "pw" }),
      ...bearer(token),
    });
    expect(res.status).toBe(204);
  });
});

// --- registration with a chosen display name -----------------------------------

describe("POST /auth/register", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function gateway(store: InMemoryAuthStore) {
    const app = new Hono();
    app.route("/", createHadesProxyRouter(config(), silent, { store, peerAddress: () => undefined }));
    return app;
  }

  function hades(status: number, body: unknown) {
    const seen: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.body ? new TextDecoder().decode(init.body as Uint8Array) : "");
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return seen;
  }

  const register = (app: Hono, payload: unknown) =>
    app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });

  test("strips display_name before Hades sees it, then names the new account", async () => {
    const store = new InMemoryAuthStore();
    const seen = hades(201, { access_token: mint({ lvl: 20 }), refresh_token: "r" });

    const res = await register(gateway(store), {
      username: "nova",
      email: "n@example.com",
      password: "pw",
      display_name: "  Nova  ",
    });

    expect(res.status).toBe(201);
    expect(JSON.parse(seen[0]!)).toEqual({ username: "nova", email: "n@example.com", password: "pw" });
    const account = (await store.getAccountByHadesId(USER))!;
    expect(account.displayName).toBe("Nova");
    expect(account.displayNameSet).toBe(true);
    expect(account.accountLevel).toBe(20);
    // The response is Hades' own, untouched.
    expect((await res.json()).refresh_token).toBe("r");
  });

  test("a taken name is refused before Hades is called, so no half-made account remains", async () => {
    const store = new InMemoryAuthStore();
    await store.provisionAccount({ hadesUserId: "other", displayName: "nova", level: 0 });
    const seen = hades(201, {});

    const res = await register(gateway(store), { username: "n", display_name: "Nova" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "That display name is already taken.", field: "display_name" });
    expect(seen).toEqual([]);
  });

  test("an unusable name is 422 before Hades is called", async () => {
    const store = new InMemoryAuthStore();
    const seen = hades(201, {});
    const res = await register(gateway(store), { username: "n", display_name: "x".repeat(65) });
    expect(res.status).toBe(422);
    expect(seen).toEqual([]);
  });

  test("with no display_name the body is forwarded byte for byte and no account is made", async () => {
    const store = new InMemoryAuthStore();
    const raw = '{ "username":"nova",  "email":"n@example.com" }';
    const seen = hades(201, { access_token: mint() });

    await register(gateway(store), raw);
    expect(seen[0]).toBe(raw);
    expect(store.accounts.size).toBe(0);
  });

  test("a failed registration leaves nothing behind", async () => {
    const store = new InMemoryAuthStore();
    hades(409, { error: "Username already taken" });
    const res = await register(gateway(store), { username: "n", display_name: "Nova" });
    expect(res.status).toBe(409);
    expect(store.accounts.size).toBe(0);
  });

  test("losing the race for the name after Hades succeeds still completes the registration", async () => {
    const store = new InMemoryAuthStore();
    hades(201, { access_token: mint() });
    // Someone takes the name between the pre-check and the account being created.
    const real = store.displayNameTaken.bind(store);
    store.displayNameTaken = async (name) => {
      const answer = await real(name);
      // Planted directly: `provisionAccount` itself consults `displayNameTaken`.
      store.accounts.set("rival", {
        accountId: "rival",
        hadesUserId: "rival",
        displayName: name,
        displayNameSet: true,
        accountLevel: 0,
        verificationTier: "none",
        verificationUrl: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSeenAt: null,
        extra: {},
      });
      return answer;
    };

    const res = await register(gateway(store), { username: "n", display_name: "Nova" });
    expect(res.status).toBe(201);
    expect(await store.getAccountByHadesId(USER)).toBeNull(); // first sign-in will assign a placeholder
  });

  test("a body that is not JSON is passed through for Hades to reject", async () => {
    const store = new InMemoryAuthStore();
    const seen = hades(400, { error: "bad json" });
    const res = await register(gateway(store), "not json");
    expect(res.status).toBe(400);
    expect(seen[0]).toBe("not json");
  });

  test("an oversized register body is refused", async () => {
    const store = new InMemoryAuthStore();
    const seen = hades(201, {});
    const res = await register(gateway(store), "x".repeat(65 * 1024));
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });
});

describe("unverifiedPayload", () => {
  test("reads the claims of a token without checking it", () => {
    expect(unverifiedPayload(mint())?.sub).toBe(USER);
  });

  test("is null for anything that is not a v4.public token", () => {
    expect(unverifiedPayload("garbage")).toBeNull();
    expect(unverifiedPayload("v4.public.")).toBeNull();
    expect(unverifiedPayload("v4.public.AAAA")).toBeNull();
  });
});
