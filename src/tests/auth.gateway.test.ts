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
    internalApiKey: "internal",
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

function stubHades(status = 200, body = '{"ok":true}', contentType = "application/json") {
  captured = undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    return new Response(body, { status, headers: { "Content-Type": contentType } });
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
      { pasetoPublicKey: "00".repeat(32), internalApiKey: "k", clientId: undefined, realmId: undefined },
      {},
    );
    expect(() => createHadesProxyRouter(bare, silent)).toThrow(/HADES_CLIENT_ID/);
  });
});
