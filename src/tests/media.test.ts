import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifyImage } from "../media/image.ts";

// storage.ts reads MEDIA_DIR at module scope, so the temp root has to be in place
// before it is imported. Hence the dynamic import rather than a static one.
const root = await mkdtemp(join(tmpdir(), "corbin-media-"));
process.env.MEDIA_DIR = root;
const storage = await import("../media/storage.ts");

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// --- Synthetic headers, built to the shape each decoder walks -----------------

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([...("GIF89a" as string)].map((c) => c.charCodeAt(0)), 0);
  new DataView(bytes.buffer).setUint16(6, width, true);
  new DataView(bytes.buffer).setUint16(8, height, true);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8], 0); // SOI
  bytes.set([0xff, 0xe0, 0x00, 0x10], 2); // APP0, length 16 — skipped over
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20); // SOF0, length 17, 8-bit precision
  view.setUint16(25, height);
  view.setUint16(27, width);
  return bytes;
}

function webpLossless(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  const ascii = (text: string, at: number) =>
    bytes.set([...text].map((c) => c.charCodeAt(0)), at);
  ascii("RIFF", 0);
  ascii("WEBP", 8);
  ascii("VP8L", 12);
  bytes[20] = 0x2f;
  new DataView(bytes.buffer).setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return bytes;
}

function webpExtended(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  const ascii = (text: string, at: number) =>
    bytes.set([...text].map((c) => c.charCodeAt(0)), at);
  ascii("RIFF", 0);
  ascii("WEBP", 8);
  ascii("VP8X", 12);
  const write24 = (value: number, at: number) => {
    bytes[at] = value & 0xff;
    bytes[at + 1] = (value >> 8) & 0xff;
    bytes[at + 2] = (value >> 16) & 0xff;
  };
  write24(width - 1, 24);
  write24(height - 1, 27);
  return bytes;
}

describe("identifyImage", () => {
  test("reads PNG dimensions", () => {
    expect(identifyImage(png(1200, 630))).toEqual({
      mimeType: "image/png",
      extension: "png",
      width: 1200,
      height: 630,
    });
  });

  test("reads GIF dimensions", () => {
    expect(identifyImage(gif(64, 48))).toMatchObject({ width: 64, height: 48 });
  });

  test("walks JPEG segments to the start of frame", () => {
    expect(identifyImage(jpeg(800, 600))).toEqual({
      mimeType: "image/jpeg",
      extension: "jpg",
      width: 800,
      height: 600,
    });
  });

  test("reads both lossless and extended WebP", () => {
    expect(identifyImage(webpLossless(100, 50))).toMatchObject({
      mimeType: "image/webp",
      width: 100,
      height: 50,
    });
    expect(identifyImage(webpExtended(1920, 1080))).toMatchObject({
      width: 1920,
      height: 1080,
    });
  });

  test("rejects anything that is not an accepted image format", () => {
    const svg = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
    expect(identifyImage(svg)).toBeNull();
    expect(identifyImage(new TextEncoder().encode("MZ\x90\x00"))).toBeNull();
    expect(identifyImage(new Uint8Array(0))).toBeNull();
  });

  test("a truncated header identifies the format without inventing a size", () => {
    const truncated = png(10, 10).slice(0, 12);
    expect(identifyImage(truncated)).toEqual({ mimeType: "image/png", extension: "png" });
  });
});

describe("storage paths", () => {
  test("accepts only the hashed path shape it writes", () => {
    const name = `${"a".repeat(32)}.webp`;
    expect(storage.pathFromSegments("2026", "08", name)).toBe(`/media/2026/08/${name}`);
  });

  test("rejects traversal and anything else that is not a stored name", () => {
    expect(storage.pathFromSegments("2026", "08", "../../../.env")).toBeNull();
    expect(storage.pathFromSegments("..", "..", "id_rsa")).toBeNull();
    expect(storage.pathFromSegments("2026", "8", `${"a".repeat(32)}.webp`)).toBeNull();
    expect(storage.pathFromSegments("2026", "08", "notahash.webp")).toBeNull();
  });

  test("reduces a stored URL back to a path, whatever form it was recorded in", () => {
    const path = `/media/2026/08/${"b".repeat(32)}.png`;
    expect(storage.toStoredPath(`https://api.corbin.dev${path}`)).toBe(path);
    expect(storage.toStoredPath(`${path}?v=2`)).toBe(path);
    expect(storage.toStoredPath("https://evil.example/media/2026/08/x.png")).toBeNull();
  });
});

describe("storage round trip", () => {
  test("stores by content hash, is idempotent, and reads back", async () => {
    const bytes = png(4, 4);

    const first = await storage.store(bytes, "png", new Date(Date.UTC(2026, 7, 15)));
    expect(first.path).toMatch(/^\/media\/2026\/08\/[0-9a-f]{32}\.png$/);

    // The same bytes in the same month resolve to the same file, not a second copy.
    const second = await storage.store(bytes, "png", new Date(Date.UTC(2026, 7, 20)));
    expect(second.path).toBe(first.path);

    const file = await storage.read(first.path);
    expect(file).not.toBeNull();
    expect([...new Uint8Array(await file!.arrayBuffer())]).toEqual([...bytes]);

    await storage.remove(first.path);
    expect(await storage.read(first.path)).toBeNull();
  });

  test("different bytes get a different path", async () => {
    const a = await storage.store(png(1, 1), "png");
    const b = await storage.store(png(2, 2), "png");
    expect(a.path).not.toBe(b.path);
  });

  test("leaves no partial files behind", async () => {
    await storage.store(png(9, 9), "png");
    const strays = [...new Bun.Glob("**/*.part").scanSync(root)];
    expect(strays).toEqual([]);
  });
});
