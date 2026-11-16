import { isIP } from "node:net";

/**
 * The address of the person making a request, worked out from the socket peer and
 * `X-Forwarded-For`, for the gateway to pass on to Hades (which does the same on its
 * side and rate-limits by it).
 *
 * `X-Forwarded-For` is believed only when the peer is on the trusted-proxy list
 * (`AUTH_TRUSTED_PROXIES`: addresses or CIDR ranges), and then only the entries a
 * trusted hop added: the list is read from the right and the first address that is not
 * a trusted proxy is the caller. With no list the header is never read and the peer
 * address is used as it is.
 *
 * Keep this in step with `hades/src/client_ip.rs` and `charon/src/client_ip.rs`.
 * Pure: no I/O.
 */

export interface TrustedNet {
  version: 4 | 6;
  /** Network address as a 128-bit integer (IPv4 occupies the low 32 bits). */
  network: bigint;
  prefix: number;
}

interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

function parseIp(input: string): ParsedIp | null {
  const text = input.trim();
  const version = isIP(text);
  if (version === 4) {
    const value = text.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
    return { version: 4, value };
  }
  if (version === 6) {
    const value = parseV6(text);
    if (value === null) return null;
    // IPv4-mapped (::ffff:a.b.c.d) is the same host as the plain IPv4 address.
    if (value >> 32n === 0xffffn) return { version: 4, value: value & 0xffffffffn };
    return { version: 6, value };
  }
  return null;
}

function parseV6(text: string): bigint | null {
  let address = text;
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);

  // Embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets.
  const tail = address.lastIndexOf(":");
  if (address.slice(tail + 1).includes(".")) {
    const v4 = parseIp(address.slice(tail + 1));
    if (!v4 || v4.version !== 4) return null;
    const hi = ((v4.value >> 16n) & 0xffffn).toString(16);
    const lo = (v4.value & 0xffffn).toString(16);
    address = `${address.slice(0, tail + 1)}${hi}:${lo}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const hextets = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (hextets.length !== 8) return null;

  let value = 0n;
  for (const hextet of hextets) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(hextet)) return null;
    value = (value << 16n) | BigInt(parseInt(hextet, 16));
  }
  return value;
}

/** Parses addresses and CIDR ranges (`10.0.0.0/8`, `172.18.0.5`). Throws on a bad entry. */
export function parseTrusted(entries: string[]): TrustedNet[] {
  return entries.map((entry) => {
    const [addr, bits, ...extra] = entry.split("/");
    const ip = addr === undefined ? null : parseIp(addr);
    const max = ip?.version === 6 ? 128 : 32;
    const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
    if (!ip || extra.length > 0 || !Number.isInteger(prefix) || prefix > max) {
      throw new Error(`AUTH_TRUSTED_PROXIES: '${entry}' is not an address or CIDR range`);
    }
    const width = BigInt(ip.version === 4 ? 32 : 128);
    const shift = width - BigInt(prefix);
    return { version: ip.version, network: (ip.value >> shift) << shift, prefix };
  });
}

function isTrusted(ip: ParsedIp, trusted: TrustedNet[]): boolean {
  return trusted.some((net) => {
    if (net.version !== ip.version) return false;
    const width = BigInt(net.version === 4 ? 32 : 128);
    const shift = width - BigInt(net.prefix);
    return (ip.value >> shift) << shift === net.network;
  });
}

function format(ip: ParsedIp, original: string): string {
  // The canonical form is only needed for IPv4-mapped input, which parseIp unwrapped.
  if (ip.version === 4) {
    return [24n, 16n, 8n, 0n].map((s) => Number((ip.value >> s) & 0xffn)).join(".");
  }
  return original.trim();
}

/**
 * The caller's address, given the socket peer and the `X-Forwarded-For` header (all its
 * values joined with commas). `undefined` when the peer itself is unknown.
 */
export function resolveClientIp(
  peer: string | undefined,
  forwardedFor: string | undefined,
  trusted: TrustedNet[],
): string | undefined {
  const peerIp = peer ? parseIp(peer) : null;
  if (!peer || !peerIp) return undefined;
  const peerText = format(peerIp, peer);
  if (!isTrusted(peerIp, trusted)) return peerText;
  if (!forwardedFor) return peerText;

  // What the nearest trusted hop saw. If the whole chain is internal this is the caller
  // (an internal client), and it beats the proxy's own address, which would put every
  // caller in one rate-limit bucket.
  let nearest: string | undefined;
  for (const part of forwardedFor.split(",").reverse()) {
    const ip = parseIp(part);
    // A hop wrote something that is not an address; nothing to its left can be believed.
    if (!ip) return nearest ?? peerText;
    if (!isTrusted(ip, trusted)) return format(ip, part);
    nearest ??= format(ip, part);
  }
  return nearest ?? peerText;
}

/** Reads `AUTH_TRUSTED_PROXIES`-style CSV into parsed ranges. */
export function trustedFromList(list: string[]): TrustedNet[] {
  return parseTrusted(list);
}
