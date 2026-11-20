import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * Object-store mode against a fake S3 endpoint.
 *
 * The real Bun S3 client signs and sends real requests; the server just records
 * them. That pins down what goes over the wire — bucket, key, content type, and the
 * absence of an ACL header, which R2 does not implement — without needing R2.
 */

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
}

const seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name] = value;
      });
      seen.push({ method: request.method, path: new URL(request.url).pathname, headers });
      // Nothing exists yet (HEAD -> 404); writes and deletes succeed.
      if (request.method === "HEAD") return new Response(null, { status: 404 });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(null, { status: 200, headers: { ETag: '"abc"' } });
    },
  });
});

afterAll(() => server.stop(true));

async function runFixture(env: Record<string, string>) {
  const process_ = Bun.spawn(
    [process.execPath, "--no-env-file", "run", new URL("./fixtures/remote-storage.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
    { env: { PATH: Bun.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
    process_.exited,
  ]);
  return { out, err, code };
}

const baseEnv = () => ({
  STORAGE_ENDPOINT: `http://localhost:${server.port}`,
  STORAGE_PUBLIC_BUCKET: "pub-bucket",
  STORAGE_PRIVATE_BUCKET: "priv-bucket",
  STORAGE_ACCESS_KEY_ID: "test-key",
  STORAGE_SECRET_ACCESS_KEY: "test-secret",
  MEDIA_BASE_URL: "https://img.example.com/",
});

describe("object-store mode", () => {
  test("routes public and private files to their own buckets, signed, with no ACL", async () => {
    seen.length = 0;
    const { out, err, code } = await runFixture(baseEnv());
    expect(err).toBe("");
    expect(code).toBe(0);

    const puts = seen.filter((request) => request.method === "PUT");
    const served = puts.find((request) => request.path.endsWith("-800.webp"))!;
    const original = puts.find((request) => request.path.includes("/originals/"))!;

    // Path-style addressing: /<bucket>/<key>, with the key being the stored path.
    expect(served.path).toBe(`/pub-bucket/media/2026/08/${"d".repeat(32)}-800.webp`);
    expect(original.path).toBe(`/priv-bucket/originals/2026/08/${"d".repeat(32)}.png`);

    expect(served.headers["content-type"]).toBe("image/webp");
    expect(served.headers["authorization"]).toStartWith("AWS4-HMAC-SHA256");
    // R2 has no ACLs; sending one risks the request being rejected.
    for (const request of seen) expect(request.headers["x-amz-acl"]).toBeUndefined();

    const result = JSON.parse(out);
    expect(result.url).toBe(`https://img.example.com/media/2026/08/${"d".repeat(32)}-800.webp`);
    // The bucket's own domain serves the files, not this process.
    expect(result.read).toBeNull();
  });

  test("store() checks for an existing object before writing", async () => {
    seen.length = 0;
    await runFixture(baseEnv());

    const head = seen.findIndex((request) => request.method === "HEAD");
    expect(head).toBeGreaterThanOrEqual(0);
    expect(seen[head]!.path).toStartWith("/pub-bucket/media/2026/08/");
  });

  test("deletes each file from the bucket it lives in", async () => {
    seen.length = 0;
    await runFixture(baseEnv());

    const deletes = seen.filter((request) => request.method === "DELETE").map((r) => r.path);
    expect(deletes).toEqual([
      `/pub-bucket/media/2026/08/${"d".repeat(32)}-800.webp`,
      `/priv-bucket/originals/2026/08/${"d".repeat(32)}.png`,
    ]);
  });

  test("refuses a path that is not one of ours before it reaches the bucket", async () => {
    seen.length = 0;
    const { out } = await runFixture(baseEnv());

    expect(JSON.parse(out).badPath).toContain("unrecognised media path");
    expect(seen.some((request) => request.path.includes("passwd"))).toBe(false);
  });

  test("fails fast when configuration is incomplete", async () => {
    const { MEDIA_BASE_URL: _unused, ...partial } = baseEnv();
    const { STORAGE_PRIVATE_BUCKET: _private, ...missingPrivate } = baseEnv();

    expect((await runFixture(missingPrivate)).err).toContain("STORAGE_PRIVATE_BUCKET must be set");
    // Without MEDIA_BASE_URL a URL would be built from the API's own origin: wrong.
    expect((await runFixture(partial)).err).toContain("MEDIA_BASE_URL must be set");
  });
});
