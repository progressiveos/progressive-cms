// Server-derived opaque network-source identifier (CORE-SHOP-SECURITY-SOURCE-01).
//
// Extensions that need anti-abuse bucketing (rate limits, quotas) cannot use
// the raw client address: it is PII, it must not reach extension code, and a
// spoofable identity would let one caller rotate fresh buckets at will. The
// resolver derives an opaque, installation-stable key from the
// transport-resolved peer (Fastify `request.ip` — X-Forwarded-* are honored
// only from `http.trustedProxies`, never from an arbitrary client) with
// HMAC-SHA-256 over a configured installation secret (`http.sourceKeySecretRef`
// → the M01 secrets channel). The raw address, the secret and proxy headers
// never leave this seam.
//
// Normalization policy: IPv4 keys on the full address; IPv6 keys on the /64
// prefix (low 64 bits zeroed) — RFC 4941/8981 privacy addresses rotate the
// interface identifier inside one /64, so a rotating host keeps one key while
// distinct subnets stay distinct. IPv4-mapped IPv6 (`::ffff:a.b.c.d` and the
// fully-expanded `0:…:ffff:a.b.c.d` form) unwraps to the IPv4 address; an
// IPv6 zone index is stripped. The derivation is version-prefixed, so a
// future aggregation-policy change never silently aliases old buckets.
//
// Absence is explicit: without a configured secret (or for a peer that cannot
// be parsed) the resolver returns undefined — handlers must treat that as
// "no trustworthy source identity", never as a shared bucket. Rotating the
// secret changes every key at once (rate-limit windows effectively reset);
// the composition root refuses to boot with a too-short secret (fail-secure,
// same philosophy as the M01 secret channel).
import { createHmac } from "node:crypto";
import { isIP } from "node:net";

/** Version prefix of the derivation; bump when the normalization policy
 * changes so keys of different policies cannot alias. */
const DERIVATION_VERSION = "pcms.source-key.v1";

/** Minimum accepted length of the configured HMAC secret (characters). */
export const SOURCE_KEY_SECRET_MIN_LENGTH = 16;

/** Returns the derived key for the transport-resolved peer, or undefined
 * when the installation has no secret or the address is unusable. */
export type SourceKeyResolver = (ip: string | undefined) => string | undefined;

/**
 * Canonical aggregation key for the trusted client address:
 * dotted-quad IPv4 as-is (leading-zero octets rejected), IPv6 reduced to its
 * /64 prefix, IPv4-mapped forms unwrapped. Null = no trustworthy address.
 */
export function normalizeSourceAddress(ip: string | undefined): string | null {
  if (ip === undefined) return null;
  let value = ip.trim().toLowerCase();
  if (isIP(value) === 0) return null;
  const zone = value.indexOf("%"); // IPv6 zone index is link-local metadata
  if (zone >= 0) value = value.slice(0, zone);
  if (value.startsWith("::ffff:") && isDottedQuad(value.slice("::ffff:".length))) {
    return value.slice("::ffff:".length);
  }
  if (value.includes(":")) return aggregateIpv6To64(value);
  return isDottedQuad(value) ? value : null;
}

/**
 * HMAC-SHA-256 over the version-prefixed normalized address, truncated to
 * 128 bits — opaque, stable per installation secret, irreversible without
 * the secret. Undefined for an unusable address (explicit absence).
 */
export function deriveSourceKey(secret: string, ip: string | undefined): string | undefined {
  const normalized = normalizeSourceAddress(ip);
  if (normalized === null) return undefined;
  return createHmac("sha256", secret)
    .update(`${DERIVATION_VERSION}\u001f${normalized}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Builds the per-process resolver from the resolved installation secret.
 * No secret configured → every request yields undefined (the feature is
 * off, CMS behavior unchanged). A configured secret shorter than
 * {@link SOURCE_KEY_SECRET_MIN_LENGTH} aborts composition — fail-secure.
 */
export function createSourceKeyResolver(secret: string | undefined): SourceKeyResolver {
  if (secret === undefined) return () => undefined;
  if (secret.length < SOURCE_KEY_SECRET_MIN_LENGTH) {
    throw new Error(
      `http.sourceKeySecretRef: the source-key secret must be at least ${SOURCE_KEY_SECRET_MIN_LENGTH} characters long`,
    );
  }
  return (ip) => deriveSourceKey(secret, ip);
}

function isDottedQuad(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every(
    (part) =>
      /^\d{1,3}$/.test(part) && Number(part) <= 255 && (part.length === 1 || !part.startsWith("0")),
  );
}

/** Reduces a textual IPv6 address to its /64 prefix (`h1:h2:h3:h4::`), or
 * unwraps an IPv4-mapped encoding. Null for anything unparseable. */
function aggregateIpv6To64(value: string): string | null {
  const groups = parseIpv6Groups(value);
  if (groups === null || groups.length !== 8) return null;
  // Fully-written IPv4-mapped form (0:0:0:0:0:ffff:a.b.c.d) unwraps like
  // the shorthand, so both spellings key identically.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const v4 = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    return isDottedQuad(v4) ? v4 : null;
  }
  const prefix = groups.slice(0, 4);
  if (prefix.every((group) => group === 0)) return "::";
  return `${prefix.map((group) => group.toString(16)).join(":")}::`;
}

/** Expands a textual IPv6 address into exactly 8 numeric groups, honoring
 * one `::` compression and an embedded trailing IPv4 tail. */
function parseIpv6Groups(value: string): readonly number[] | null {
  if (!/^[0-9a-f:.]+$/.test(value)) return null;
  const doubleColon = value.indexOf("::");
  if (value.indexOf("::", Math.max(0, doubleColon + 1)) >= 0) return null; // at most one "::"
  if (doubleColon < 0) {
    const full = parseGroups(value);
    return full !== null && full.length === 8 ? full : null;
  }
  const head = parseGroups(doubleColon === 0 ? "" : value.slice(0, doubleColon));
  if (head === null) return null;
  const tail = parseGroups(value.slice(doubleColon + 2));
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null; // "::" must stand for at least one group
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function parseGroups(part: string): number[] | null {
  if (part === "") return [];
  const tokens = part.split(":");
  const groups: number[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.includes(".")) {
      // An embedded IPv4 tail spans the final two groups only.
      if (index !== tokens.length - 1) return null;
      if (!isDottedQuad(token)) return null;
      const octets = token.split(".").map((octet) => Number(octet));
      groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
    groups.push(Number.parseInt(token, 16));
  }
  return groups;
}
