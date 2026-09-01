import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { b64uDecode, concatBytes, hexDecode } from "./base64url.ts";

/**
 * PASETO v4.public verification.
 *
 * Hades mints access tokens as PASETO v4.public (Ed25519) — see
 * `.claude/skills/hades/docs/agent/architecture.md`. Verification is ~40 lines of
 * framing plus one Ed25519 check, so this is implemented directly rather than
 * pulling in a paseto library (Hades' own posture: "no dependency for what a short
 * standalone function can do").
 *
 * PORTABILITY: the only runtime coupling is `node:crypto`. Any port needs a function
 * `ed25519Verify(message, signature, publicKey) -> boolean`; everything above it is
 * byte manipulation. WebCrypto (`crypto.subtle.verify({name:"Ed25519"}, ...)`) is a
 * drop-in async replacement if node:crypto is unavailable.
 */

const HEADER = "v4.public.";
const SIGNATURE_BYTES = 64;

/** DER SPKI prefix for a raw Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/**
 * Accepts the hex form Hades' `PASETO_PUBLIC_KEY` uses, or a PEM SPKI block.
 * Parsed once at startup — never per request.
 */
export function loadEd25519PublicKey(material: string): KeyObject {
  const trimmed = material.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return createPublicKey(trimmed);
  }
  const raw = hexDecode(trimmed);
  if (raw.length !== 32) {
    throw new Error(`expected a 32-byte Ed25519 public key, got ${raw.length} bytes`);
  }
  return createPublicKey({
    key: Buffer.from(concatBytes(ED25519_SPKI_PREFIX, raw)),
    format: "der",
    type: "spki",
  });
}

/** PASETO Pre-Authentication Encoding: le64(n) || (le64(len) || piece)* */
function pae(pieces: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [le64(pieces.length)];
  for (const piece of pieces) {
    parts.push(le64(piece.length), piece);
  }
  return concatBytes(...parts);
}

function le64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  // The high bit of the last byte must be cleared per the PASETO spec. JS numbers
  // cannot reach it via a byte length anyway, but mask to 63 bits regardless.
  new DataView(out.buffer).setBigUint64(0, BigInt(n) & 0x7fffffffffffffffn, true);
  return out;
}

const encoder = new TextEncoder();

export interface PasetoToken {
  /** The decoded payload, still a raw string — claim parsing is a separate concern. */
  payload: string;
  footer: string;
}

/**
 * Verifies the signature and framing of a `v4.public` token. Says nothing about
 * claims — `exp`, `iat`, `rid` and friends are checked in claims.ts.
 *
 * @throws Error with a terse reason; callers translate to an AuthError.
 */
export function verifyPasetoV4Public(
  token: string,
  publicKey: KeyObject,
  implicitAssertion = "",
): PasetoToken {
  if (!token.startsWith(HEADER)) throw new Error("not a v4.public token");

  const rest = token.slice(HEADER.length);
  const dot = rest.indexOf(".");
  const bodyPart = dot === -1 ? rest : rest.slice(0, dot);
  const footerPart = dot === -1 ? "" : rest.slice(dot + 1);
  if (bodyPart.length === 0) throw new Error("empty token body");

  const decoded = b64uDecode(bodyPart);
  if (decoded.length <= SIGNATURE_BYTES) throw new Error("token body too short");

  const message = decoded.subarray(0, decoded.length - SIGNATURE_BYTES);
  const signature = decoded.subarray(decoded.length - SIGNATURE_BYTES);
  const footer = footerPart ? b64uDecode(footerPart) : new Uint8Array(0);

  const preAuth = pae([
    encoder.encode(HEADER),
    message,
    footer,
    encoder.encode(implicitAssertion),
  ]);

  // `null` algorithm == pure EdDSA, which is what Ed25519 keys require.
  const ok = cryptoVerify(null, preAuth, publicKey, signature);
  if (!ok) throw new Error("signature verification failed");

  const decoder = new TextDecoder();
  return { payload: decoder.decode(message), footer: decoder.decode(footer) };
}
