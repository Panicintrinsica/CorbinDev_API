/**
 * Turns an uploaded image into the set of files the site actually serves.
 *
 * The original is never served. Each upload is decoded once per variant,
 * auto-rotated from its EXIF orientation, stripped of all metadata (camera
 * serials and GPS coordinates included), downscaled to a ladder of widths, and
 * re-encoded as AVIF. The browser picks the right width via `srcset`. AVIF only:
 * browsers old enough to lack it are deliberately unsupported. Exceptions:
 *   - animation, which sharp cannot write as AVIF, is served as animated WebP
 *   - a source that is already AVIF is not transcoded: it is only resized, and its
 *     full-size rung is the uploaded file itself when it carries nothing to strip
 * SVG never comes through here; it is stored as-is (see `svg.ts`).
 *
 * sharp (libvips) is used rather than anything pure-JS because encoding AVIF and
 * resampling large images in JavaScript is an order of magnitude slower, and
 * because it ships prebuilt binaries for every platform this runs on — Windows
 * for development, glibc and musl Linux for the container.
 */

import { MIN_BANNER_WIDTH } from "../content/banner.ts";
import sharp, { type Metadata, type Sharp } from "sharp";

/** Ladder of output widths. Chosen to cover phone, tablet and the 46rem reading column at 1x-3x. */
export const WIDTHS = [480, 800, 1200, 1600, 2400] as const;

/** The widest variant ever produced; a larger source is downscaled to this. */
export const MAX_WIDTH = WIDTHS[WIDTHS.length - 1]!;

/**
 * The variant used as the plain `<img src>`: the widest variant at or under this.
 * It is what a client with no `srcset` support, the editor preview, and the
 * block's `url` all get, so it is sized for a retina reading column, not a hero.
 */
export const FALLBACK_MAX_WIDTH = 1600;

/**
 * Decompression-bomb ceiling, in pixels (frames included). An 8MB PNG can declare
 * billions of pixels; libvips would happily try to allocate them. 64MP is above any
 * phone camera and well under what exhausts a small droplet.
 */
export const MAX_PIXELS = 64_000_000;

/** How an upload is turned into variants. */
export interface ProcessOptions {
  /**
   * Produce a single variant this many pixels wide (never upscaled) instead of the
   * responsive ladder. For things shown at one fixed size, like an icon, where
   * several widths would only be files nobody asks for.
   */
  width?: number;
  /**
   * Responsive rungs to use instead of the default ladder, e.g. `[480, 1920]` for a
   * thumbnail and a full-size image. Never upscaled: a source narrower than a rung
   * gets its own width in place of it. Ignored when `width` is set.
   */
  widths?: readonly number[];
  /** Refuse a source narrower than this many pixels (after rotation). */
  minWidth?: number;
  /**
   * Crop to a square (centred on the busiest part of the picture) instead of keeping
   * the source's shape. `minWidth` then applies to the shorter side, which is what
   * the square is cut from. Stills only.
   */
  square?: boolean;
}

/**
 * Named processing profiles, selected by the `purpose` an upload declares.
 * Anything not listed gets the default responsive ladder.
 */
export const PROFILES: Record<string, ProcessOptions> = {
  default: {},
  "skill/logo": { width: 64 },
  // Just a thumbnail and the full image: a gallery shows a grid, then one picture.
  "project/gallery": { widths: [480, 1920] },
  // An article's headline image: small and large only, and never a small source.
  // A person's picture: a 48px avatar and a 256px full version, cropped square.
  "account/avatar": { widths: [48, 256], minWidth: 256, square: true },
  "article/banner": { widths: [400, MIN_BANNER_WIDTH], minWidth: MIN_BANNER_WIDTH },
};

export type VariantFormat = "avif" | "webp";

export interface Variant {
  format: VariantFormat;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  data: Uint8Array;
}

export interface ProcessedImage {
  /** Dimensions after EXIF rotation — what a viewer sees, not what the sensor wrote. */
  width: number;
  height: number;
  animated: boolean;
  /** Ascending by width. All AVIF, or all WebP for an animation. */
  variants: Variant[];
}

/** The input could not be decoded, or is beyond the size limits. Safe to show the author. */
export class ImageProcessingError extends Error {}

const MIME_TYPES: Record<VariantFormat, string> = {
  avif: "image/avif",
  webp: "image/webp",
};

/** Concurrent encodes. Each holds a decoded copy of the source, so this bounds peak memory. */
const CONCURRENCY = 2;

export async function processImage(
  bytes: Uint8Array,
  options: ProcessOptions = {},
): Promise<ProcessedImage> {
  // `animated` is requested everywhere so a GIF/WebP keeps its frames; for a still
  // image it is a no-op.
  const open = () =>
    sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: true, failOn: "error" });

  let meta: Metadata;
  try {
    meta = await open().metadata();
  } catch (error) {
    throw new ImageProcessingError(`The image could not be read: ${reason(error)}`);
  }

  const frames = meta.pages ?? 1;
  const animated = frames > 1;

  // Header dimensions are pre-rotation; `autoOrient` is the post-rotation size.
  const sourceWidth = meta.autoOrient?.width ?? meta.width;
  const sourceHeight = animated
    ? meta.pageHeight
    : (meta.autoOrient?.height ?? meta.height);
  const square = options.square === true;

  if (square && animated) {
    throw new ImageProcessingError("This image cannot be animated");
  }
  // A square is cut from the shorter side, so that is the size it can honestly have.
  const side = Math.min(sourceWidth ?? 0, sourceHeight ?? 0);
  const width = square ? side : sourceWidth;
  const height = square ? side : sourceHeight;

  if (!width || !height) {
    throw new ImageProcessingError("The image has no readable dimensions");
  }
  if (options.minWidth && width < options.minWidth) {
    throw new ImageProcessingError(
      square
        ? `The image is ${sourceWidth}x${sourceHeight}px; its shorter side needs at least ${options.minWidth}px`
        : `The image is ${width}px wide; this needs at least ${options.minWidth}px`,
    );
  }
  if (width * height * frames > MAX_PIXELS) {
    throw new ImageProcessingError(
      `The image is too large to process (${width}x${height}${animated ? `, ${frames} frames` : ""})`,
    );
  }

  // sharp cannot write animated AVIF, and a still AVIF of an animation would
  // silently drop the motion, so animations are served as animated WebP instead.
  const formats: VariantFormat[] = animated ? ["webp"] : ["avif"];

  // An AVIF source is not transcoded. Its full-size rung can be the uploaded bytes
  // as they are, provided there is nothing to strip or straighten: re-encoding would
  // only lose quality, but EXIF (GPS, camera serials) and a rotation must not survive.
  const reusable =
    meta.format === "heif" &&
    meta.compression === "av1" &&
    !animated &&
    !meta.exif &&
    !meta.xmp &&
    (meta.orientation ?? 1) === 1 &&
    // Already the right shape, or no cropping is asked for.
    (!square || (sourceWidth === sourceHeight));

  const widths = options.width
    ? [Math.min(width, options.width)]
    : widthLadder(width, options.widths);
  const jobs = widths.flatMap((target) =>
    formats.map((format) =>
      reusable && format === "avif" && target === width
        ? async (): Promise<Variant> => ({
            format,
            mimeType: MIME_TYPES[format],
            width,
            height,
            bytes: bytes.byteLength,
            data: bytes,
          })
        : () => encode(open, target, format, animated, square),
    ),
  );

  try {
    const variants = await runLimited(jobs, CONCURRENCY);
    return { width, height, animated, variants };
  } catch (error) {
    throw new ImageProcessingError(`The image could not be converted: ${reason(error)}`);
  }
}

/**
 * Widths to generate for a source `width` pixels wide.
 *
 * Never upscales: a 1000px source gets 480, 800 and 1000, not 1200 blown up from
 * 1000. The source's own width is included (up to MAX_WIDTH) so the largest
 * variant is the sharpest the source can honestly provide.
 */
export function widthLadder(width: number, rungs: readonly number[] = WIDTHS): number[] {
  const top = Math.max(...rungs);
  const ladder = new Set<number>(rungs.filter((candidate) => candidate < width));
  ladder.add(Math.min(width, top));
  return [...ladder].sort((a, b) => a - b);
}

/** The variant a plain `<img src>` should use: the widest within FALLBACK_MAX_WIDTH. */
export function pickFallback<T extends { format: string; width: number }>(variants: T[]): T {
  const webp = [...variants].sort((a, b) => a.width - b.width);
  if (webp.length === 0) throw new Error("no variant to use as the fallback");

  // Ascending, so the last one within the cap is the widest. The ladder always
  // contains a width at or under the cap, so `webp[0]` is only a safety net.
  return webp.findLast((variant) => variant.width <= FALLBACK_MAX_WIDTH) ?? webp[0]!;
}

async function encode(
  open: () => Sharp,
  targetWidth: number,
  format: VariantFormat,
  animated: boolean,
  square = false,
): Promise<Variant> {
  const pipeline = open()
    // Bakes the EXIF orientation into the pixels. Metadata is dropped on output by
    // default, so without this a phone photo would come out sideways.
    .rotate()
    .resize(
      square
        ? { width: targetWidth, height: targetWidth, fit: "cover", position: sharp.strategy.attention }
        : { width: targetWidth, withoutEnlargement: true },
    );

  const { data, info } =
    format === "avif"
      ? await pipeline.avif({ quality: 50, effort: 4 }).toBuffer({ resolveWithObject: true })
      : await pipeline
          // `smartSubsample` keeps colour edges crisp at WebP's 4:2:0; the cost is negligible.
          .webp({ quality: 78, effort: 4, smartSubsample: true, ...(animated ? { loop: 0 } : {}) })
          .toBuffer({ resolveWithObject: true });

  return {
    format,
    mimeType: MIME_TYPES[format],
    width: info.width,
    // For an animation sharp reports the stacked height of every frame.
    height: animated && info.pageHeight ? info.pageHeight : info.height,
    bytes: info.size,
    data,
  };
}

/** Runs `jobs` with at most `limit` in flight, preserving order in the results. */
async function runLimited<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;

  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]!();
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
