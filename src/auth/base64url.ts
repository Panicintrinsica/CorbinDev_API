/**
 * base64url helpers (RFC 4648 §5, unpadded).
 *
 * PORTABILITY: only uses `Buffer`, available in Bun, Node and Deno's node compat.
 * A browser/edge port swaps these two bodies for `atob`/`btoa` and nothing else changes.
 */

export function b64uDecode(input: string): Uint8Array {
  // Buffer's base64 decoder accepts the url alphabet and missing padding.
  return new Uint8Array(Buffer.from(input, "base64url"));
}

export function b64uEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function hexDecode(input: string): Uint8Array {
  const clean = input.trim().toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
    throw new Error("invalid hex string");
  }
  return new Uint8Array(Buffer.from(clean, "hex"));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
