import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createHadesProxyRouter } from "../auth/hono/proxy.routes.ts";
import { loadAuthConfig } from "../auth/config.ts";

/**
 * Gateway tests. Hades is replaced with a stubbed `fetch`, so these assert the
 * contract of the forwarder itself: which headers it adds, what it refuses to
 * forward, and that responses come back untouched.
 */

const config = loadAuthConfig(
  {
    hadesBaseUrl: "https://auth.impetusstudios.com",
    pasetoPublicKey: "00".repeat(32),
    clientApiKey: "client-key",
    clientId: "client-1",
    realmId: "realm-1",
  },
  {},
);

const silent = { debug: () => {}, warn: () => {}, error: () => {} };

function app() {
  const server = new Hono();
  server.route("/", createHadesProxyRouter(config, silent));
  return server;
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

const realFetch = globalThis.fetch;
let captured: Captured | undefined;

function stubHades(
  status = 200,
  body = '{"ok":true}',
  contentType = "application/json",
  extraHeaders: Record<string, string> = {},
) {
  captured = undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      // The gateway forwards bytes; tests read them as text.
      body: init?.body ? new TextDecoder().decode(init.body as Uint8Array) : undefined,
    };
    return new Response(body, { status, headers: { "Content-Type": contentType, ...extraHeaders } });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("hades gateway", () => {
  test("stamps the client and realm on a login and never forwards a bearer", async () => {
    stubHades();
    const res = await app().request("/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-ID": "browser-1",
        // A caller-supplied bearer must not ride along on a credential route.
        Authorization: "Bearer stolen",
      },
      body: JSON.stringify({ identity: "johndoe", password: "x" }),
    });

    expect(res.status).toBe(200);
    expect(captured!.url).toBe("https://auth.impetusstudios.com/auth/login");
    expect(captured!.headers["X-Client-ID"]).toBe("client-1");
    expect(captured!.headers["X-Realm-ID"]).toBe("realm-1");
    expect(captured!.headers["X-Device-ID"]).toBe("browser-1");
    expect(captured!.headers["Authorization"]).toBeUndefined();
    expect(captured!.body).toBe(JSON.stringify({ identity: "johndoe", password: "x" }));
  });

  test("a caller cannot choose the realm its token is minted for", async () => {
    stubHades();
    await app().request("/auth/register", {
      method: "POST",
      headers: { "X-Realm-ID": "realm-attacker", "X-Client-ID": "client-attacker" },
      body: "{}",
    });
    expect(captured!.headers["X-Realm-ID"]).toBe("realm-1");
    expect(captured!.headers["X-Client-ID"]).toBe("client-1");
  });

  test("caps an oversized device id rather than round-tripping a 400", async () => {
    stubHades();
    await app().request("/auth/login", {
      method: "POST",
      headers: { "X-Device-ID": "d".repeat(500) },
      body: "{}",
    });
    expect(captured!.headers["X-Device-ID"]!.length).toBe(128);
  });

  test("forwards the bearer, and no context headers, on self-service routes", async () => {
    stubHades();
    await app().request("/user/profile", {
      headers: { Authorization: "Bearer v4.public.abc", "X-Device-ID": "browser-1" },
    });

    expect(captured!.url).toBe("https://auth.impetusstudios.com/user/profile");
    expect(captured!.method).toBe("GET");
    expect(captured!.headers["Authorization"]).toBe("Bearer v4.public.abc");
    expect(captured!.headers["X-Client-ID"]).toBeUndefined();
    expect(captured!.body).toBeUndefined();
  });

  test("MFA completion is context-bound, enrolment is bearer", async () => {
    stubHades();
    await app().request("/mfa/verify/totp", { method: "POST", body: "{}" });
    expect(captured!.headers["X-Realm-ID"]).toBe("realm-1");

    stubHades();
    await app().request("/mfa/totp/setup", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: "{}",
    });
    expect(captured!.headers["Authorization"]).toBe("Bearer t");
    expect(captured!.headers["X-Realm-ID"]).toBeUndefined();
  });

  test("passes status and body through untouched", async () => {
    stubHades(401, '{"error":"Unauthorized"}');
    const res = await app().request("/auth/refresh", { method: "POST", body: "{}" });

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"error":"Unauthorized"}');
  });

  test("does not retry a 401 from refresh", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;

    await app().request("/auth/refresh", { method: "POST", body: "{}" });
    expect(calls).toBe(1);
  });

  test("503 when Hades cannot be reached", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const res = await app().request("/auth/login", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
  });

  test("validates a social provider before it reaches a URL", async () => {
    stubHades();
    const ok = await app().request("/auth/social/discord/redirect");
    expect(ok.status).toBe(200);
    expect(captured!.url).toBe(
      "https://auth.impetusstudios.com/auth/social/discord/redirect",
    );

    stubHades();
    const bad = await app().request("/auth/social/evil.com%2F../redirect");
    expect(bad.status).toBe(400);
    expect(captured).toBeUndefined();
  });

  test("validates a passkey credential id", async () => {
    stubHades();
    const bad = await app().request("/mfa/passkeys/..%2F..%2Fadmin/revoke", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: "{}",
    });
    expect(bad.status).toBe(400);
    expect(captured).toBeUndefined();
  });

  test("the admin and internal surfaces are not forwarded", async () => {
    stubHades();
    for (const path of [
      "/admin/users",
      "/internal/validate-session",
      "/admin/utils/generate-keys",
    ]) {
      const res = await app().request(path, { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
    }
    expect(captured).toBeUndefined();
  });

  test("an unlisted method on a listed path is not forwarded", async () => {
    stubHades();
    const res = await app().request("/auth/login", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(captured).toBeUndefined();
  });

  test("refuses to mount without a client and realm", () => {
    const bare = loadAuthConfig(
      { pasetoPublicKey: "00".repeat(32), sessionValidation: "off", clientId: undefined, realmId: undefined },
      {},
    );
    expect(() => createHadesProxyRouter(bare, silent)).toThrow(/HADES_CLIENT_ID/);
  });

  // --- Hades routes added since the gateway was first written ------------------

  test("forwards passwordless passkey sign-in as a context-bound route", async () => {
    for (const path of ["/mfa/webauthn/login/start", "/mfa/webauthn/login/finish"]) {
      stubHades();
      const res = await app().request(path, { method: "POST", body: "{}" });
      expect(res.status).toBe(200);
      expect(captured!.url).toBe(`https://auth.impetusstudios.com${path}`);
      expect(captured!.headers["X-Client-ID"]).toBe("client-1");
      expect(captured!.headers["X-Realm-ID"]).toBe("realm-1");
      expect(captured!.headers["Authorization"]).toBeUndefined();
    }
  });

  test("self-verification carries both the client id and the bearer", async () => {
    stubHades();
    await app().request("/user/verification/self", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(captured!.url).toBe("https://auth.impetusstudios.com/user/verification/self");
    expect(captured!.headers["X-Client-ID"]).toBe("client-1");
    expect(captured!.headers["Authorization"]).toBe("Bearer t");
  });

  test("renames a passkey, validating the credential id", async () => {
    stubHades();
    const ok = await app().request("/mfa/passkeys/abc_123-XYZ", {
      method: "PUT",
      headers: { Authorization: "Bearer t" },
      body: JSON.stringify({ name: "Laptop" }),
    });
    expect(ok.status).toBe(200);
    expect(captured!.method).toBe("PUT");
    expect(captured!.url).toBe("https://auth.impetusstudios.com/mfa/passkeys/abc_123-XYZ");
    expect(captured!.headers["Authorization"]).toBe("Bearer t");

    stubHades();
    const bad = await app().request("/mfa/passkeys/..%2Fadmin", { method: "PUT", body: "{}" });
    expect(bad.status).toBe(400);
    expect(captured).toBeUndefined();
  });

  test("a DELETE /user/account body survives the trip", async () => {
    stubHades();
    await app().request("/user/account", {
      method: "DELETE",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      body: JSON.stringify({ password: "pw" }),
    });
    expect(captured!.method).toBe("DELETE");
    expect(captured!.body).toBe('{"password":"pw"}');
  });

  // --- Caller address, so Hades limits by person and not by this gateway --------

  function appWith(trustedProxies: string[], peer: string | undefined) {
    const cfg = loadAuthConfig(
      {
        pasetoPublicKey: "00".repeat(32),
        clientApiKey: "k",
        clientId: "client-1",
        realmId: "realm-1",
        trustedProxies,
      },
      {},
    );
    const server = new Hono();
    server.route("/", createHadesProxyRouter(cfg, silent, { peerAddress: () => peer }));
    return server;
  }

  test("forwards the socket address when there is no proxy list", async () => {
    stubHades();
    await appWith([], "203.0.113.9").request("/auth/login", {
      method: "POST",
      // Believed from nobody: the peer is not a trusted proxy.
      headers: { "X-Forwarded-For": "1.2.3.4" },
      body: "{}",
    });
    expect(captured!.headers["X-Forwarded-For"]).toBe("203.0.113.9");
  });

  test("believes X-Forwarded-For only from a trusted proxy, and only its own hop", async () => {
    stubHades();
    await appWith(["10.0.0.0/8"], "10.0.0.5").request("/auth/login", {
      method: "POST",
      headers: { "X-Forwarded-For": "9.9.9.9, 198.51.100.7" },
      body: "{}",
    });
    expect(captured!.headers["X-Forwarded-For"]).toBe("198.51.100.7");
  });

  test("sends no caller address when the socket address is unknown", async () => {
    stubHades();
    await app().request("/auth/login", {
      method: "POST",
      headers: { "X-Forwarded-For": "1.2.3.4" },
      body: "{}",
    });
    expect(captured!.headers["X-Forwarded-For"]).toBeUndefined();
  });

  // --- Bounds and what comes back ----------------------------------------------

  test("refuses a body over the forwarding limit without calling Hades", async () => {
    stubHades();
    const res = await app().request("/auth/login", {
      method: "POST",
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(captured).toBeUndefined();
  });

  test("lets a client see how long to wait after a 429", async () => {
    stubHades(429, '{"error":"Too many requests"}', "application/json", { "Retry-After": "42" });
    const res = await app().request("/auth/login", { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
  });

  test("puts a deadline on the call to Hades", async () => {
    // The real deadline is 15s; assert only that a signal is attached.
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await app().request("/auth/login", { method: "POST", body: "{}" });
    expect(signal).toBeDefined();
  });

  // The calls CorbinDev_Frontend makes, exactly as its auth.service.ts makes them.
  test("serves the frontend sign-in, MFA, refresh and sign-out calls", async () => {
    const calls: Array<[string, unknown, Record<string, string>]> = [
      ["/auth/login", { identity: "me@corbin.dev", password: "pw" }, { "X-Device-ID": "dev" }],
      ["/mfa/verify/totp", { mfa_token: "m", code: "123456" }, { "X-Device-ID": "dev" }],
      ["/auth/refresh", { refresh_token: "r" }, { "X-Device-ID": "dev" }],
      ["/auth/logout", { refresh_token: "r" }, {}],
    ];
    for (const [path, body, headers] of calls) {
      stubHades(200, '{"access_token":"a","refresh_token":"r","expires_in":900}');
      const res = await app().request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      expect(captured!.url).toBe(`https://auth.impetusstudios.com${path}`);
      expect(JSON.parse(captured!.body!)).toEqual(body);
      expect((await res.json()).access_token).toBe("a");
    }
  });
});
