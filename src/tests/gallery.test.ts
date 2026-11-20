import { describe, expect, test } from "bun:test";
import { BlockContentError } from "../content/blocks.ts";
import { MAX_GALLERY_ITEMS, normalizeGallery } from "../content/gallery.ts";
import { referencedPaths } from "../media/lifecycle.ts";
import { normalizeBanner } from "../content/banner.ts";
import sharp from "sharp";
import { ImageProcessingError, PROFILES, processImage, widthLadder } from "../media/process.ts";

const hash = "a".repeat(32);
const base = `https://img.example.com/media/2026/08/${hash}`;
const image = (extra = {}) => ({
  type: "image",
  caption: "  The   dashboard ",
  image: {
    url: `${base}-480.avif`,
    width: 1600,
    height: 900,
    variants: [
      { format: "avif", width: 1920, url: `${base}-1920.avif` },
      { format: "avif", width: 480, url: `${base}-480.avif` },
    ],
  },
  ...extra,
});
const video = { type: "video" as const, caption: "Demo", videoId: "dQw4w9WgXcQ" };

describe("normalizeGallery", () => {
  test("keeps images and videos, tidies captions, sorts variants", () => {
    const [first, second] = normalizeGallery([image(), video]);
    expect(first).toMatchObject({ type: "image", caption: "The dashboard" });
    const widths = (first as { image: { variants: Array<{ width: number }> } }).image.variants.map(
      (v) => v.width,
    );
    expect(widths).toEqual([480, 1920]);
    expect(second).toEqual(video);
  });

  test("nothing is an empty gallery", () => {
    expect(normalizeGallery(undefined)).toEqual([]);
    expect(normalizeGallery([])).toEqual([]);
  });

  test.each([
    ["missing caption", [image({ caption: "  " })]],
    ["bad video id", [{ type: "video", caption: "x", videoId: "../etc" }]],
    ["a video url instead of an id", [{ ...video, videoId: "https://youtu.be/dQw4w9WgXcQ" }]],
    ["unknown type", [{ type: "audio", caption: "x" }]],
    ["inline data image", [image({ image: { url: "data:image/png;base64,AAAA" } })]],
    ["javascript url", [image({ image: { url: "javascript:alert(1)" } })]],
    ["not a list", {}],
    ["too many", Array.from({ length: MAX_GALLERY_ITEMS + 1 }, () => image())],
  ])("rejects %s", (_name, input) => {
    expect(() => normalizeGallery(input)).toThrow(BlockContentError);
  });
});

describe("gallery references", () => {
  test("gallery images count as references so their files are kept, then released", () => {
    const paths = referencedPaths({ gallery: normalizeGallery([image(), video]) });
    expect([...paths]).toEqual([`/media/2026/08/${hash}-480.avif`]);
  });
});

describe("thumbnail + full rungs", () => {
  test("a large source gets exactly two", () => {
    expect(widthLadder(4000, [480, 1920])).toEqual([480, 1920]);
  });
  test("never upscales the full image", () => {
    expect(widthLadder(1000, [480, 1920])).toEqual([480, 1000]);
  });
  test("a tiny source gets one", () => {
    expect(widthLadder(300, [480, 1920])).toEqual([300]);
  });
});

describe("article banner", () => {
  const banner = (width: number) => ({
    url: `${base}-800.avif`,
    width,
    height: 400,
    alt: " A  view ",
    variants: [
      { format: "avif", width: 400, url: `${base}-400.avif` },
      { format: "avif", width: 800, url: `${base}-800.avif` },
    ],
  });
  const png = async (w: number) =>
    new Uint8Array(
      await sharp({ create: { width: w, height: 300, channels: 3, background: "#336699" } }).png().toBuffer(),
    );

  test("is optional: nothing clears it", () => {
    expect(normalizeBanner(undefined)).toBeNull();
    expect(normalizeBanner(null)).toBeNull();
    expect(normalizeBanner({})).toBeNull();
  });

  test("accepts 800px and up, and tidies the alt text", () => {
    expect(normalizeBanner(banner(800))).toMatchObject({ width: 800, alt: "A view" });
    expect(normalizeBanner(banner(2400))).not.toBeNull();
  });

  test("rejects anything narrower than 800px, or of unknown width", () => {
    expect(() => normalizeBanner(banner(799))).toThrow("at least 800px");
    expect(() => normalizeBanner({ ...banner(800), width: undefined })).toThrow(BlockContentError);
  });

  test("the profile makes exactly 400 and 800, and refuses a smaller source", async () => {
    const profile = PROFILES["article/banner"];
    expect((await processImage(await png(1600), profile)).variants.map((v) => v.width)).toEqual([400, 800]);
    expect((await processImage(await png(800), profile)).variants.map((v) => v.width)).toEqual([400, 800]);
    await expect(processImage(await png(799), profile)).rejects.toBeInstanceOf(ImageProcessingError);
  });

  test("a banner counts as a reference, so replacing it frees the old file", () => {
    expect([...referencedPaths({ banner: banner(800) })]).toEqual([`/media/2026/08/${hash}-800.avif`]);
  });
});
