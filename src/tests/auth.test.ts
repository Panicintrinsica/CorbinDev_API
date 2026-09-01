import { describe, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { loadEd25519PublicKey, verifyPasetoV4Public } from "../auth/paseto.ts";
import { bearerFromHeader, parseClaims, validateClaims } from "../auth/claims.ts";
import { permits, resolvePermissions, satisfies } from "../auth/authorize.ts";
import { verifyWebhook } from "../auth/webhook.ts";
import { AuthError } from "../auth/errors.ts";
import type { RoleDefinition } from "../auth/types.ts";

// --- a minimal v4.public signer, so verification is tested against real tokens ---

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

function pae(pieces: Uint8Array[]): Uint8Array {
  return concat([le64(pieces.length), ...pieces.flatMap((p) => [le64(p.length), p])]);
}

function makeKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey, publicKeyHex: raw.toString("hex") };
}

function mintToken(privateKey: ReturnType<typeof makeKeypair>["privateKey"], claims: object) {
  const encoder = new TextEncoder();
  const message = encoder.encode(JSON.stringify(claims));
  const preAuth = pae([
    encoder.encode("v4.public."),
    message,
    new Uint8Array(0),
    new Uint8Array(0),
  ]);
  const signature = new Uint8Array(cryptoSign(null, preAuth, privateKey));
  return `v4.public.${Buffer.from(concat([message, signature])).toString("base64url")}`;
}

function sampleClaims(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    sub: "8c1d0000-0000-4000-8000-000000000001",
    jti: "6f1c0000-0000-4000-8000-000000000002",
    scope: ["g_subscriber"],
    rid: "realm-1",
    cid: "client-1",
    did: "browser-1",
    iat: new Date(now - 60_000).toISOString(),
    exp: new Date(now + 900_000).toISOString(),
    ...overrides,
  };
}

const POLICY = { allowedRealms: ["realm-1"], allowedClients: ["client-1"], clockSkewSeconds: 30 };

// --- PASETO ------------------------------------------------------------------

describe("paseto v4.public", () => {
  test("verifies a well-formed token and returns its payload", () => {
    const { privateKey, publicKeyHex } = makeKeypair();
    const claims = sampleClaims();
    const token = mintToken(privateKey, claims);

    const { payload } = verifyPasetoV4Public(token, loadEd25519PublicKey(publicKeyHex));
    expect(JSON.parse(payload).sub).toBe(claims.sub);
  });

  test("rejects a token signed by a different key", () => {
    const a = makeKeypair();
    const b = makeKeypair();
    const token = mintToken(a.privateKey, sampleClaims());

    expect(() => verifyPasetoV4Public(token, loadEd25519PublicKey(b.publicKeyHex))).toThrow(
      /signature/,
    );
  });

  test("rejects a tampered payload", () => {
    const { privateKey, publicKeyHex } = makeKeypair();
    const token = mintToken(privateKey, sampleClaims());
    const body = token.slice("v4.public.".length);
    const bytes = Buffer.from(body, "base64url");
    bytes[10] = bytes[10]! ^ 0xff;
    const tampered = `v4.public.${bytes.toString("base64url")}`;

    expect(() => verifyPasetoV4Public(tampered, loadEd25519PublicKey(publicKeyHex))).toThrow();
  });

  test("rejects other purposes and versions", () => {
    const { publicKeyHex } = makeKeypair();
    const key = loadEd25519PublicKey(publicKeyHex);
    expect(() => verifyPasetoV4Public("v4.local.abc", key)).toThrow(/not a v4.public/);
    expect(() => verifyPasetoV4Public("v2.public.abc", key)).toThrow(/not a v4.public/);
  });

  test("rejects a key of the wrong length", () => {
    expect(() => loadEd25519PublicKey("aabbcc")).toThrow(/32-byte/);
  });
});

// --- claims ------------------------------------------------------------------

describe("claims", () => {
  test("parses the Hades access-token shape", () => {
    const claims = parseClaims(JSON.stringify(sampleClaims()));
    expect(claims.scope).toEqual(["g_subscriber"]);
    expect(claims.did).toBe("browser-1");
    expect(claims.exp.getTime()).toBeGreaterThan(Date.now());
  });

  test("accepts numeric timestamps too, for the ID token shape", () => {
    const claims = parseClaims(
      JSON.stringify(sampleClaims({ iat: 1756467900, exp: 1756468800 })),
    );
    expect(claims.iat.toISOString()).toBe("2025-08-29T11:45:00.000Z");
  });

  test("defaults a missing device id rather than failing", () => {
    const raw = sampleClaims();
    delete (raw as Record<string, unknown>).did;
    expect(parseClaims(JSON.stringify(raw)).did).toBe("unknown");
  });

  test("rejects a missing subject", () => {
    const raw = sampleClaims();
    delete (raw as Record<string, unknown>).sub;
    expect(() => parseClaims(JSON.stringify(raw))).toThrow(AuthError);
  });

  test("rejects an expired token", () => {
    const claims = parseClaims(
      JSON.stringify(sampleClaims({ exp: new Date(Date.now() - 60_000).toISOString() })),
    );
    expect(() => validateClaims(claims, POLICY)).toThrow(/expired/);
  });

  test("rejects a realm this API does not serve", () => {
    const claims = parseClaims(JSON.stringify(sampleClaims({ rid: "realm-other" })));
    expect(() => validateClaims(claims, POLICY)).toThrow(/wrong_realm/);
  });

  test("rejects a client this API does not accept", () => {
    const claims = parseClaims(JSON.stringify(sampleClaims({ cid: "client-other" })));
    expect(() => validateClaims(claims, POLICY)).toThrow(/wrong_client/);
  });

  test("tolerates clock skew within the configured window", () => {
    const claims = parseClaims(
      JSON.stringify(sampleClaims({ iat: new Date(Date.now() + 20_000).toISOString() })),
    );
    expect(() => validateClaims(claims, POLICY)).not.toThrow();
  });

  test("parses a bearer header and refuses anything else", () => {
    expect(bearerFromHeader("Bearer abc")).toBe("abc");
    expect(bearerFromHeader("bearer abc")).toBe("abc");
    expect(() => bearerFromHeader(undefined)).toThrow(/missing_token/);
    expect(() => bearerFromHeader("Basic abc")).toThrow(/malformed_token/);
  });
});

// --- authorization -----------------------------------------------------------

const ROLES: RoleDefinition[] = [
  { name: "member", permissions: ["articles:read"], isDefault: true },
  { name: "editor", permissions: ["articles:*", "projects:write"], isDefault: false },
  { name: "owner", permissions: ["*"], isDefault: false },
];

function principal(over: Partial<{ roles: string[]; direct: string[]; denied: string[] }> = {}) {
  return {
    roles: over.roles ?? [],
    directPermissions: over.direct ?? [],
    deniedPermissions: over.denied ?? [],
  };
}

describe("authorize", () => {
  test("resolves role permissions", () => {
    const granted = resolvePermissions(principal({ roles: ["editor"] }), ROLES);
    expect([...granted].sort()).toEqual(["articles:*", "projects:write"]);
  });

  test("an unknown role grants nothing", () => {
    const granted = resolvePermissions(principal({ roles: ["nope"] }), ROLES);
    expect(granted.size).toBe(0);
  });

  test("wildcards match on the grant side only", () => {
    const granted = resolvePermissions(principal({ roles: ["editor"] }), ROLES);
    expect(permits(granted, "articles:write")).toBe(true);
    expect(permits(granted, "articles:delete:hard")).toBe(true);
    expect(permits(granted, "projects:delete")).toBe(false);
  });

  test("a requirement is literal, never a wildcard", () => {
    const granted = resolvePermissions(principal({ roles: ["member"] }), ROLES);
    expect(permits(granted, "articles:*")).toBe(false);
  });

  test("the global wildcard grants everything", () => {
    const granted = resolvePermissions(principal({ roles: ["owner"] }), ROLES);
    expect(permits(granted, "anything:at:all")).toBe(true);
  });

  test("denials are literal and applied last", () => {
    const granted = resolvePermissions(
      principal({ roles: ["editor"], denied: ["articles:*"] }),
      ROLES,
    );
    expect(permits(granted, "articles:write")).toBe(false);
    expect(permits(granted, "projects:write")).toBe(true);
  });

  test("a Hades global role satisfies a requirement outright", () => {
    const granted = new Set<string>();
    expect(satisfies({ allOf: ["auth:roles:write"] }, granted, ["g_subscriber"])).toBe(false);
    expect(
      satisfies({ allOf: ["auth:roles:write"], globalRoles: ["g_superadmin"] }, granted, [
        "g_superadmin",
      ]),
    ).toBe(true);
  });

  test("a global-role-only requirement fails when the role is absent", () => {
    expect(satisfies({ globalRoles: ["g_superadmin"] }, new Set(), ["g_subscriber"])).toBe(false);
  });

  test("an empty requirement means authenticated is enough", () => {
    expect(satisfies({}, new Set(), [])).toBe(true);
  });
});

// --- webhooks ----------------------------------------------------------------

describe("webhook verification", () => {
  const SECRET = "whsec_test";
  const body = JSON.stringify({
    id: "0f0e0000-0000-4000-8000-000000000003",
    type: "user_banned",
    occurred_at: "2026-08-29T14:03:11.482Z",
    user_id: "8c1d0000-0000-4000-8000-000000000001",
  });

  function sign(rawBody: string, timestamp: string, secret = SECRET) {
    return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  }

  function headers(timestamp: string, signature: string) {
    return { timestamp, signature, eventId: "e", eventType: "user_banned" };
  }

  test("accepts a correctly signed, fresh delivery", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const verdict = verifyWebhook(body, headers(ts, sign(body, ts)), SECRET, 300);
    expect(verdict.ok).toBe(true);
  });

  test("rejects a wrong secret", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const verdict = verifyWebhook(body, headers(ts, sign(body, ts, "other")), SECRET, 300);
    expect(verdict).toMatchObject({ ok: false, status: 401 });
  });

  test("rejects a stale delivery even with a valid signature", () => {
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    const verdict = verifyWebhook(body, headers(ts, sign(body, ts)), SECRET, 300);
    expect(verdict).toMatchObject({ ok: false, status: 400 });
  });

  test("a re-serialised body does not verify — the raw bytes are what is signed", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    const verdict = verifyWebhook(reserialised, headers(ts, sign(body, ts)), SECRET, 300);
    expect(verdict).toMatchObject({ ok: false, status: 401 });
  });

  test("closes rather than opens when no secret is configured", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const verdict = verifyWebhook(body, headers(ts, sign(body, ts)), undefined, 300);
    expect(verdict).toMatchObject({ ok: false, status: 503 });
  });

  test("rejects an incomplete event", () => {
    const partial = JSON.stringify({ id: "x", type: "user_banned" });
    const ts = String(Math.floor(Date.now() / 1000));
    const verdict = verifyWebhook(partial, headers(ts, sign(partial, ts)), SECRET, 300);
    expect(verdict).toMatchObject({ ok: false, status: 400 });
  });
});
