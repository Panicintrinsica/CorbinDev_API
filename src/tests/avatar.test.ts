import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { referencedPaths } from "../media/lifecycle.ts";
import { ImageProcessingError, PROFILES, processImage } from "../media/process.ts";

const profile = PROFILES["account/avatar"];
const png = async (w: number, h: number) =>
  new Uint8Array(
    await sharp({ create: { width: w, height: h, channels: 3, background: "#884422" } }).png().toBuffer(),
  );

describe("account/avatar profile", () => {
  test("makes a 48px avatar and a 256px full version, both square", async () => {
    const { variants, width, height } = await processImage(await png(1000, 600), profile);
    expect(variants.map((v) => `${v.width}x${v.height}`)).toEqual(["48x48", "256x256"]);
    expect(variants.every((v) => v.format === "avif")).toBe(true);
    // Cut from the shorter side.
    expect({ width, height }).toEqual({ width: 600, height: 600 });
    for (const v of variants) {
      const meta = await sharp(v.data).metadata();
      expect([meta.width, meta.height]).toEqual([v.width, v.width]);
    }
  });

  test("accepts exactly 256px", async () => {
    const { variants } = await processImage(await png(256, 256), profile);
    expect(variants.map((v) => v.width)).toEqual([48, 256]);
  });

  test("requires 256px on the shorter side", async () => {
    await expect(processImage(await png(255, 255), profile)).rejects.toBeInstanceOf(ImageProcessingError);
    // Wide, but too short to cut a 256px square from.
    await expect(processImage(await png(2000, 200), profile)).rejects.toThrow("shorter side");
  });

  test("an avatar counts as a reference, so replacing it frees the old picture", () => {
    expect([...referencedPaths({ avatar: { url: `https://img.example.com/media/2026/08/${"a".repeat(32)}-256.avif` } })]).toEqual([
      `/media/2026/08/${"a".repeat(32)}-256.avif`,
    ]);
  });
});
