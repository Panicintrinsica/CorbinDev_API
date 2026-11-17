import { afterEach, describe, expect, test } from "bun:test";
import { HadesSessionValidator } from "../auth/session.ts";
import { loadAuthConfig } from "../auth/config.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const config = loadAuthConfig(
  { clientId: "c", clientApiKey: "k", hadesBaseUrl: "http://hades.test" } as never,
  { HADES_PASETO_PUBLIC_KEY: "00".repeat(32), HADES_SESSION_VALIDATION: "off" },
);
const logger = { debug() {}, warn() {}, error() {} };
const input = { jti: "j", userId: "u", deviceId: "d" };

function stub(res: Response) {
  globalThis.fetch = (async () => res) as unknown as typeof fetch;
}

describe("HadesSessionValidator verdicts", () => {
  test("200 is live", async () => {
    stub(new Response(null, { status: 200 }));
    expect(await new HadesSessionValidator(config, logger).isSessionLive(input)).toBe(true);
  });

  test("Hades' own JSON 403 is a dead session", async () => {
    stub(Response.json({ error: "Forbidden" }, { status: 403 }));
    expect(await new HadesSessionValidator(config, logger).isSessionLive(input)).toBe(false);
  });

  test("a plain-text 403 from an ingress is NOT a revocation", async () => {
    stub(new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } }));
    await expect(new HadesSessionValidator(config, logger).isSessionLive(input)).rejects.toThrow();
  });
});

describe("HadesSessionValidator.probe", () => {
  const v = () => new HadesSessionValidator(config, logger);

  test("Hades' JSON 403 means reachable and authorised", async () => {
    stub(Response.json({ error: "Forbidden" }, { status: 403 }));
    await v().probe();
  });
  test("401 means the key was rejected", async () => {
    stub(new Response(null, { status: 401 }));
    await expect(v().probe()).rejects.toThrow("rejected");
  });
  test("a plain 403 means something in front of Hades", async () => {
    stub(new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } }));
    await expect(v().probe()).rejects.toThrow("not Hades");
  });
  test("a network failure is reported as unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    await expect(v().probe()).rejects.toThrow("unreachable");
  });
});
