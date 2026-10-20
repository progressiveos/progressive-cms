// Remote media import with SSRF protection
// (PCMS-MEDIA-T021/T022; Media spec §43).
//
// `media_import_url` is an SSRF surface. The fetcher enforces, per hop:
//   - http/https only; TLS verification is the platform default (never
//     disabled here);
//   - DNS resolution is validated against blocked IP ranges: loopback,
//     link-local (incl. cloud metadata endpoints), private, unspecified,
//     multicast/reserved — fail-secure unless the deployment explicitly
//     declares a trusted-policy override;
//   - redirects are bounded and re-validated from scratch (a redirect to a
//     private address fails exactly like a direct one);
//   - wall-clock timeout and a hard byte cap on the response body.
// `ponytail:` DNS rebinding (TOCTOU between validate and fetch) is narrowed
// by validating every resolved address; a rebinding-proof client would pin
// the connection to the validated IP (custom dialer) — add it if a threat
// model demands it, the seam is `deps.lookup`.
import { isIP } from "node:net";
import { MediaError } from "./errors.js";

export interface RemoteImportLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  /**
   * Deployment trust policy (Media spec §43 "unless explicit trusted
   * policy"). Fail-secure default: private/loopback targets are blocked.
   */
  readonly allowPrivateAddresses?: boolean;
}

export const DEFAULT_REMOTE_IMPORT_LIMITS: RemoteImportLimits = {
  maxBytes: 52_428_800, // 50 MiB
  timeoutMs: 30_000,
  maxRedirects: 3,
  allowPrivateAddresses: false,
};

export interface RemoteFetchResult {
  readonly body: Buffer;
  readonly contentType: string | null;
  readonly finalUrl: string;
  readonly redirectCount: number;
}

export interface RemoteFetchDependencies {
  /** Injectable DNS lookup (tests); default is node:dns lookup {all:true}. */
  readonly lookup?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
  /** Injectable fetch (tests); default is the platform fetch. */
  readonly fetchImpl?: typeof fetch;
}

type IpCheck = "ok" | "blocked";

function classifyIp(address: string): IpCheck {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map((p) => Number.parseInt(p, 10));
    const [a, b] = parts as [number, number];
    if (a === 127 || a === 10 || a === 0) return "blocked";
    if (a === 169 && b === 254) return "blocked"; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return "blocked";
    if (a === 192 && b === 168) return "blocked";
    if (a === 100 && b >= 64 && b <= 127) return "blocked"; // CGNAT
    if (a >= 224) return "blocked"; // multicast/reserved
    return "ok";
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    const first = normalized.split(":")[0] ?? "";
    if (normalized === "::" || normalized === "::1") return "blocked";
    if (first.startsWith("fe") || first.startsWith("fd") || first.startsWith("fc")) {
      return "blocked"; // link-local + unique local
    }
    if (first.startsWith("ff")) return "blocked"; // multicast
    // IPv4-mapped (::ffff:10.0.0.1) — classify the embedded address.
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return classifyIp(mapped[1]!);
    return "ok";
  }
  return "blocked";
}

async function defaultLookup(
  hostname: string,
): Promise<readonly { address: string; family: number }[]> {
  const { lookup } = await import("node:dns/promises");
  return lookup(hostname, { all: true, verbatim: true });
}

async function resolveAndValidateHost(
  hostname: string,
  limits: RemoteImportLimits,
  deps: RemoteFetchDependencies,
): Promise<void> {
  if (limits.allowPrivateAddresses === true) {
    return; // explicit trusted policy (documented deployment decision)
  }
  const addresses = await (deps.lookup ?? defaultLookup)(hostname);
  if (addresses.length === 0) {
    throw new MediaError("MEDIA_IMPORT_SSRF_BLOCKED", `host "${hostname}" did not resolve`);
  }
  for (const { address } of addresses) {
    if (classifyIp(address) === "blocked") {
      throw new MediaError(
        "MEDIA_IMPORT_SSRF_BLOCKED",
        `host "${hostname}" resolves to a blocked address (${address})`,
      );
    }
  }
}

function assertSafeUrlParts(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MediaError(
      "MEDIA_IMPORT_URL_INVALID",
      `only http/https imports are allowed, got "${url.protocol}"`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new MediaError("MEDIA_IMPORT_URL_INVALID", "credentials in import URLs are not allowed");
  }
}

/**
 * Validates a URL without fetching it: scheme, credentials and every address
 * the host resolves to must pass the same checks `fetchRemoteMedia` applies
 * per hop (Media spec §43). Shared by egress paths that cannot ride
 * `fetchRemoteMedia` itself (e.g. provider JSON calls that must keep auth
 * headers) — pair it with `redirect: "manual"` so unvalidated hops never
 * happen silently.
 */
export async function validateRemoteUrl(
  rawUrl: string,
  limits: RemoteImportLimits = DEFAULT_REMOTE_IMPORT_LIMITS,
  deps: RemoteFetchDependencies = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MediaError("MEDIA_IMPORT_URL_INVALID", `not a valid URL: "${rawUrl}"`);
  }
  assertSafeUrlParts(url);
  await resolveAndValidateHost(url.hostname, limits, deps);
  return url;
}

/**
 * Fetches remote media bytes with SSRF-safe hop validation. Every redirect
 * target is validated exactly like a fresh URL; the response body is
 * stream-capped at maxBytes.
 */
export async function fetchRemoteMedia(
  rawUrl: string,
  limits: RemoteImportLimits = DEFAULT_REMOTE_IMPORT_LIMITS,
  deps: RemoteFetchDependencies = {},
): Promise<RemoteFetchResult> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new MediaError("MEDIA_IMPORT_URL_INVALID", `not a valid URL: "${rawUrl}"`);
  }
  const doFetch = deps.fetchImpl ?? fetch;
  let redirectCount = 0;

  for (;;) {
    assertSafeUrlParts(current);
    await resolveAndValidateHost(current.hostname, limits, deps);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    let response: Response;
    try {
      response = await doFetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "image/*,application/pdf,application/vnd.*,*/*" },
      });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === "AbortError") {
        throw new MediaError(
          "MEDIA_IMPORT_TIMEOUT",
          `import timed out after ${limits.timeoutMs}ms`,
          {
            cause: error,
          },
        );
      }
      throw new MediaError("MEDIA_IMPORT_FETCH_FAILED", "remote import fetch failed", {
        cause: error,
      });
    }
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= limits.maxRedirects) {
        throw new MediaError(
          "MEDIA_IMPORT_REDIRECT_LIMIT",
          `more than ${limits.maxRedirects} redirects`,
        );
      }
      const location = response.headers.get("location");
      if (location === null) {
        throw new MediaError("MEDIA_IMPORT_FETCH_FAILED", "redirect without a location header");
      }
      redirectCount += 1;
      // Relative locations resolve against the current URL; the next loop
      // iteration revalidates scheme/host/address from scratch (T022).
      current = new URL(location, current);
      void response.body?.cancel();
      continue;
    }

    if (!response.ok) {
      void response.body?.cancel();
      throw new MediaError(
        "MEDIA_IMPORT_FETCH_FAILED",
        `remote server answered ${response.status}`,
      );
    }

    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isInteger(declaredLength) && declaredLength > limits.maxBytes) {
      void response.body?.cancel();
      throw new MediaError("MEDIA_TOO_LARGE", `remote body exceeds ${limits.maxBytes} bytes`);
    }
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new MediaError("MEDIA_IMPORT_FETCH_FAILED", "remote response has no body");
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limits.maxBytes) {
        await reader.cancel();
        throw new MediaError("MEDIA_TOO_LARGE", `remote body exceeds ${limits.maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return {
      body: Buffer.concat(chunks),
      contentType: response.headers.get("content-type"),
      finalUrl: current.toString(),
      redirectCount,
    };
  }
}
