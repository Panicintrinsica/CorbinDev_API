import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  ImageProcessingError,
  MAX_WIDTH,
  pickFallback,
  processImage,
  widthLadder,
} from "../media/process.ts";

/** A real, decodable image — header-only fakes would not survive libvips. */
async function photo(width: number, height: number, format: "png" | "jpeg" = "png") {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } },
  });
  return new Uint8Array(await (format === "png" ? base.png() : base.jpeg()).toBuffer());
}

describe("widthLadder", () => {
  test("never upscales: a mid-sized source tops out at its own width", () => {
    expect(widthLadder(1000)).toEqual([480, 800, 1000]);
  });

  test("a large source is capped at the widest rung", () => {
    expect(widthLadder(6000)).toEqual([480, 800, 1200, 1600, MAX_WIDTH]);
  });

  test("a tiny source yields a single variant at its own size", () => {
    expect(widthLadder(120)).toEqual([120]);
  });

  test("a source exactly on a rung is not duplicated", () => {
    expect(widthLadder(800)).toEqual([480, 800]);
  });
});

describe("processImage", () => {
  test("produces AVIF at each width, ascending", async () => {
    const result = await processImage(await photo(1000, 500));

    expect(result).toMatchObject({ width: 1000, height: 500, animated: false });
    expect(result.variants.map((v) => `${v.format}${v.width}`)).toEqual([
      "avif480",
      "avif800",
      "avif1000",
    ]);
  });

  test("variants keep the aspect ratio and really are those formats", async () => {
    const { variants } = await processImage(await photo(1000, 500));

    for (const variant of variants) {
      expect(variant.height).toBe(variant.width / 2);
      const meta = await sharp(variant.data).metadata();
      // sharp reports AVIF as "heif"; the brand is what distinguishes it.
      expect(meta.format).toBe(variant.format === "avif" ? "heif" : "webp");
      expect(meta.width).toBe(variant.width);
    }
  });

  test("bakes EXIF orientation into the pixels and reports the rotated size", async () => {
    // Stored 600x300 but tagged "rotate 90 degrees": it displays as 300x600.
    const sideways = new Uint8Array(
      await sharp({
        create: { width: 600, height: 300, channels: 3, background: "#369" },
      })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer(),
    );

    const result = await processImage(sideways);
    expect(result).toMatchObject({ width: 300, height: 600 });

    const widest = result.variants.filter((v) => v.format === "avif").at(-1)!;
    expect(widest).toMatchObject({ width: 300, height: 600 });
  });

  test("strips metadata from every variant", async () => {
    const tagged = new Uint8Array(
      await sharp({ create: { width: 64, height: 64, channels: 3, background: "#000" } })
        .jpeg()
        .withExif({ IFD0: { Copyright: "private", Artist: "someone" } })
        .toBuffer(),
    );
    expect((await sharp(tagged).metadata()).exif).toBeDefined();

    const { variants } = await processImage(tagged);
    for (const variant of variants) {
      expect((await sharp(variant.data).metadata()).exif).toBeUndefined();
    }
  });

  test("animated images are kept animated and served as WebP only", async () => {
    const frame = (color: string) =>
      sharp({ create: { width: 32, height: 32, channels: 3, background: color } })
        .png()
        .toBuffer();
    const animated = new Uint8Array(
      await sharp([await frame("#f00"), await frame("#0f0"), await frame("#00f")], {
        join: { animated: true },
      })
        .gif()
        .toBuffer(),
    );

    const result = await processImage(animated);
    expect(result.animated).toBe(true);
    expect(result.variants.every((v) => v.format === "webp")).toBe(true);
    expect((await sharp(result.variants[0]!.data, { animated: true }).metadata()).pages).toBe(3);
  });

  test("a smaller output than a PNG source, which is the point", async () => {
    const source = await photo(1600, 900, "png");
    const { variants } = await processImage(source);
    const widest = variants.filter((v) => v.format === "avif").at(-1)!;
    expect(widest.bytes).toBeLessThan(source.byteLength);
  });

  test("rejects bytes that are not a decodable image", async () => {
    const junk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    await expect(processImage(junk)).rejects.toBeInstanceOf(ImageProcessingError);
  });

  test("rejects a decompression bomb before allocating it", async () => {
    // 10000x10000 = 100MP of a single colour is a PNG small enough to pass the
    // 8MB upload limit, which is exactly why the pixel cap has to exist.
    const bomb = await photo(10_000, 10_000);
    expect(bomb.byteLength).toBeLessThan(8 * 1024 * 1024);
    await expect(processImage(bomb)).rejects.toBeInstanceOf(ImageProcessingError);
  });
});

describe("pickFallback", () => {
  const set = (...widths: number[]) =>
    widths.map((width) => ({ format: "avif", width }));

  test("takes the widest within the cap", () => {
    expect(pickFallback(set(480, 800, 1200, 1600, 2400))).toEqual({ format: "avif", width: 1600 });
  });

  test("a small source falls back to its own size", () => {
    expect(pickFallback(set(480, 700))).toEqual({ format: "avif", width: 700 });
  });
});

describe("fixed width (icons)", () => {
  test("produces a single variant at the requested width", async () => {
    const result = await processImage(await photo(512, 512), { width: 64 });
    expect(result.variants.map((v) => `${v.format}${v.width}`)).toEqual(["avif64"]);
    expect(result.variants[0]).toMatchObject({ width: 64, height: 64 });
  });

  test("never upscales a smaller source", async () => {
    const result = await processImage(await photo(32, 32), { width: 64 });
    expect(result.variants.map((v) => v.width)).toEqual([32]);
  });
});

describe("AVIF sources", () => {
  const avif = async (width: number, height: number, exif = false) => {
    const pipeline = sharp({
      create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
    }).avif({ quality: 50 });
    return new Uint8Array(await (exif ? pipeline.withExif({ IFD0: { Copyright: "x" } }) : pipeline).toBuffer());
  };

  test("is resized into the ladder, and its full-size rung is the upload itself", async () => {
    const source = await avif(1000, 500);
    const { variants } = await processImage(source);

    expect(variants.map((v) => v.width)).toEqual([480, 800, 1000]);
    expect(variants.every((v) => v.format === "avif")).toBe(true);
    // Not transcoded: byte-for-byte what was uploaded.
    expect(variants.at(-1)!.data).toBe(source);
    // The smaller rungs are genuine resizes.
    expect(variants[0]!.data).not.toBe(source);
  });

  test("is re-encoded when it carries EXIF, so metadata is still stripped", async () => {
    const source = await avif(600, 300, true);
    const { variants } = await processImage(source);
    expect(variants.at(-1)!.data).not.toBe(source);
    expect((await sharp(variants.at(-1)!.data).metadata()).exif).toBeUndefined();
  });
});
