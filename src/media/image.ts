/**
 * Image identification, done from the bytes rather than from what the client
 * claimed.
 *
 * A browser's `Content-Type` on a multipart part is attacker-controlled, and the
 * filename extension doubly so, so neither is trusted: the format is decided by
 * the magic bytes and the stored extension is derived from that decision. A file
 * whose signature is not in FORMATS never reaches disk.
 *
 * Dimensions are read from the same headers because the block renderer needs the
 * intrinsic size to reserve layout space, and pulling in an image library for
 * four integers would be a poor trade for a low-traffic site.
 */

export interface ImageInfo {
  mimeType: string;
  extension: string;
  /** Absent for formats whose header this module does not decode (AVIF). */
  width?: number;
  height?: number;
}

interface Format {
  mimeType: string;
  extension: string;
  matches: (bytes: Uint8Array) => boolean;
  dimensions: (bytes: Uint8Array) => { width: number; height: number } | null;
}

const FORMATS: Format[] = [
  {
    mimeType: "image/png",
    extension: "png",
    matches: (b) => hasBytes(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    dimensions: pngDimensions,
  },
  {
    mimeType: "image/jpeg",
    extension: "jpg",
    matches: (b) => hasBytes(b, 0, [0xff, 0xd8, 0xff]),
    dimensions: jpegDimensions,
  },
  {
    mimeType: "image/gif",
    extension: "gif",
    matches: (b) => hasAscii(b, 0, "GIF87a") || hasAscii(b, 0, "GIF89a"),
    dimensions: gifDimensions,
  },
  {
    mimeType: "image/webp",
    extension: "webp",
    matches: (b) => hasAscii(b, 0, "RIFF") && hasAscii(b, 8, "WEBP"),
    dimensions: webpDimensions,
  },
  {
    mimeType: "image/avif",
    extension: "avif",
    matches: (b) => hasAscii(b, 4, "ftyp") && (hasAscii(b, 8, "avif") || hasAscii(b, 8, "avis")),
    // AVIF hides its size in a nested ISOBMFF `ispe` box. Not worth decoding here;
    // the renderer falls back to an intrinsic-size-free layout.
    dimensions: () => null,
  },
];

/**
 * Identifies `bytes`, or returns null when they are not an image format the site
 * accepts. A truncated or corrupt header is treated as "not an image".
 */
export function identifyImage(bytes: Uint8Array): ImageInfo | null {
  const format = FORMATS.find((candidate) => candidate.matches(bytes));
  if (!format) return null;

  let size: { width: number; height: number } | null = null;
  try {
    size = format.dimensions(bytes);
  } catch {
    // A header we cannot walk is not fatal — the file is still a valid image of a
    // known type, we just do not learn its size.
    size = null;
  }

  return {
    mimeType: format.mimeType,
    extension: format.extension,
    ...(size ? { width: size.width, height: size.height } : {}),
  };
}

/** Extensions the media route will serve, mapped back to a content type. */
export const EXTENSION_MIME_TYPES: Record<string, string> = Object.fromEntries(
  FORMATS.map((format) => [format.extension, format.mimeType]),
);

// --- Per-format header readers ------------------------------------------------

function pngDimensions(bytes: Uint8Array) {
  // The IHDR chunk is mandated to be first, so width/height sit at fixed offsets.
  if (bytes.length < 24) return null;
  return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
}

function jpegDimensions(bytes: Uint8Array) {
  // Walk the segment chain to the first Start-Of-Frame, which carries the size.
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1; // Resynchronize past fill bytes.
      continue;
    }
    const marker = bytes[offset + 1]!;

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan: pixel data begins, so there is no frame header left to find.
    if (marker === 0xda) return null;

    const length = readU16BE(bytes, offset + 2);
    if (length < 2) return null;

    if (isStartOfFrame(marker)) {
      return { height: readU16BE(bytes, offset + 5), width: readU16BE(bytes, offset + 7) };
    }
    offset += 2 + length;
  }

  return null;
}

/** SOF0-SOF15, minus the huffman/arithmetic table markers interleaved in the range. */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function gifDimensions(bytes: Uint8Array) {
  if (bytes.length < 10) return null;
  return { width: readU16LE(bytes, 6), height: readU16LE(bytes, 8) };
}

function webpDimensions(bytes: Uint8Array) {
  if (bytes.length < 30) return null;

  // Lossy: a VP8 keyframe header, sizes masked to 14 bits.
  if (hasAscii(bytes, 12, "VP8 ")) {
    if (!hasBytes(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
    return {
      width: readU16LE(bytes, 26) & 0x3fff,
      height: readU16LE(bytes, 28) & 0x3fff,
    };
  }
  // Lossless: 14 bits each, packed into one little-endian word, stored minus one.
  if (hasAscii(bytes, 12, "VP8L")) {
    if (bytes[20] !== 0x2f) return null;
    const packed = readU32LE(bytes, 21);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }
  // Extended (animation, alpha, ICC): 24-bit canvas size, also stored minus one.
  if (hasAscii(bytes, 12, "VP8X")) {
    return {
      width: readU24LE(bytes, 24) + 1,
      height: readU24LE(bytes, 27) + 1,
    };
  }

  return null;
}

// --- Byte helpers -------------------------------------------------------------

function hasBytes(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function hasAscii(bytes: Uint8Array, offset: number, expected: string): boolean {
  return hasBytes(
    bytes,
    offset,
    [...expected].map((char) => char.charCodeAt(0)),
  );
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
  );
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}
