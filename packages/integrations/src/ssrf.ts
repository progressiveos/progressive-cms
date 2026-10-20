// SSRF gate (PCMS-INT-T011; Integrations spec §12) — security-critical P0.
//
// Defense model, in order:
//   1. scheme allowlist (http/https only, credentials stripped);
//   2. privileged escapes: explicit host allowlist or an explicit
//      allow-private toggle (operator config, never per-request input);
//   3. DNS resolution of the hostname with EVERY resolved address checked
//      against blocked ranges (one public + one private answer = blocked);
//   4. address pinning: the socket connects ONLY to a validated address
//      (custom lookup), closing the DNS-rebinding TOCTOU window;
//   5. redirects: bounded count, every hop fully re-validated and re-pinned;
//   6. transport hardening: TLS verification forced on, per-hop timeout,
//      response size cap.
//
// A URL-string regex is explicitly NOT treated as protection: decision
// inputs are resolved addresses, not spellings.
import { IntegrationError } from "./errors.js";
import type { UrlGuard } from "./webhook.js";

export interface SsrfPolicy {
  /** Privileged explicit internal allowlist (exact hostnames). */
  readonly allowedHosts?: readonly string[];
  /** Privileged toggle for self-hosted-internal deployments (default false). */
  readonly allowPrivateAddresses?: boolean;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Injectable for deterministic tests; default dns.promises.lookup(all). */
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export class SsrfBlockedError extends IntegrationError {
  constructor(message: string) {
    super("INTEGRATION_URL_BLOCKED", message);
    this.name = "SsrfBlockedError";
  }
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** IPv4 blocked range check (CIDR style, decoded to int comparisons). */
function isBlockedIPv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return true; // unparseable = fail-secure
  const inRange = (network: number, bits: number) =>
    value >>> (32 - bits) === network >>> (32 - bits);
  // Unsigned math: (a<<24)|… is negative in int32 for a >= 128.
  const net = (a: number, b: number, c: number, d: number) =>
    ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  return (
    inRange(net(0, 0, 0, 0), 8) || // "this network"
    inRange(net(10, 0, 0, 0), 8) || // RFC1918 private
    inRange(net(100, 64, 0, 0), 10) || // CGNAT
    inRange(net(127, 0, 0, 0), 8) || // loopback
    inRange(net(169, 254, 0, 0), 16) || // link-local (incl. 169.254.169.254 metadata)
    inRange(net(172, 16, 0, 0), 12) || // RFC1918 private
    inRange(net(192, 168, 0, 0), 16) || // RFC1918 private
    inRange(net(192, 0, 0, 0), 24) || // IETF protocol assignments
    inRange(net(192, 0, 2, 0), 24) || // TEST-NET-1
    inRange(net(198, 18, 0, 0), 15) || // benchmarking
    inRange(net(198, 51, 100, 0), 24) || // TEST-NET-2
    inRange(net(203, 0, 113, 0), 24) || // TEST-NET-3
    inRange(net(224, 0, 0, 0), 4) || // multicast
    value >= net(240, 0, 0, 0) // reserved + broadcast
  );
}

function isBlockedIPv6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) → check embedded v4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped !== null && mapped[1] !== undefined) return isBlockedIPv4(mapped[1]);
  if (lower.startsWith("::ffff:")) {
    const embedded = lower.slice(7).split(":").slice(-2);
    if (embedded.length === 2) {
      const hi = Number.parseInt(embedded[0] ?? "0", 16);
      const lo = Number.parseInt(embedded[1] ?? "0", 16);
      return isBlockedIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
  }
  if (lower.startsWith("64:ff9b:")) return true; // NAT64 → RFC6052 transit, fail-secure
  if (lower === "::" || lower === "::1") return true;
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique local
  if (lower.startsWith("ff")) return true; // multicast
  if (lower.startsWith("2001:db8:")) return true; // documentation range
  return false;
}

/** True when an address must not be reachable from the CMS (default policy). */
export function isBlockedAddress(address: string, family: number): boolean {
  return family === 6 ? isBlockedIPv6(address) : isBlockedIPv4(address);
}

const DEFAULT_DNS_RESOLVE = async (hostname: string): Promise<readonly ResolvedAddress[]> => {
  const { lookup } = await import("node:dns/promises");
  return lookup(hostname, { all: true, verbatim: true }) as unknown as Promise<
    readonly ResolvedAddress[]
  >;
};

export interface ValidatedTarget {
  readonly url: URL;
  /** The one socket address the request may connect to. */
  readonly pinnedAddress: ResolvedAddress;
}

export function createSsrfGuard(policy: SsrfPolicy = {}) {
  const maxRedirects = policy.maxRedirects ?? 3;
  const timeoutMs = policy.timeoutMs ?? 10_000;
  const maxResponseBytes = policy.maxResponseBytes ?? 1_048_576;
  const resolve = policy.resolve ?? DEFAULT_DNS_RESOLVE;

  function parseScheme(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new SsrfBlockedError("malformed URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new SsrfBlockedError(`scheme "${parsed.protocol}" is not allowed`);
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new SsrfBlockedError("embedded credentials are not allowed");
    }
    if (parsed.port === "0") throw new SsrfBlockedError("port 0 is not allowed");
    return parsed;
  }

  /**
   * Resolves the target host and validates EVERY answer; returns the one
   * address the request may be pinned to.
   */
  async function resolveValidatedTarget(rawUrl: string): Promise<ValidatedTarget> {
    const parsed = parseScheme(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (policy.allowedHosts?.includes(hostname) === true) {
      // Privileged allowlist: exact host entry, no address checks (internal
      // networks are reachable BY NAME only through explicit operator config).
      return {
        url: parsed,
        pinnedAddress: { address: hostname, family: hostname.includes(":") ? 6 : 4 },
      };
    }
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await resolve(hostname);
    } catch (error) {
      throw new SsrfBlockedError(
        `dns resolution failed for host: ${error instanceof Error ? error.message.slice(0, 80) : "error"}`,
      );
    }
    if (addresses.length === 0) throw new SsrfBlockedError("host resolved to no addresses");
    if (policy.allowPrivateAddresses === true) {
      return { url: parsed, pinnedAddress: addresses[0]! };
    }
    for (const candidate of addresses) {
      if (isBlockedAddress(candidate.address, candidate.family)) {
        throw new SsrfBlockedError(`host resolves to a blocked address (${candidate.address})`);
      }
    }
    const pinned = addresses.find((candidate) => candidate.family === 4) ?? addresses[0]!;
    return { url: parsed, pinnedAddress: pinned };
  }

  const guard: UrlGuard & {
    resolveValidatedTarget(rawUrl: string): Promise<ValidatedTarget>;
    readonly limits: { timeoutMs: number; maxResponseBytes: number; maxRedirects: number };
  } = {
    limits: { timeoutMs, maxResponseBytes, maxRedirects },
    resolveValidatedTarget,
    async assertAllowed(rawUrl, redirectPolicy) {
      await resolveValidatedTarget(rawUrl);
      if (redirectPolicy === "none") return;
      // "follow" mode still bounds hops; the transport revalidates each one
      // through resolveValidatedTarget — enforced in guardedFetch.
    },
  };
  return guard;
}

export type SsrfGuard = ReturnType<typeof createSsrfGuard>;
