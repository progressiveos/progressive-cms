// Extension outbound network policy (ADR-0014, Extensions spec §52.7).
//
// One shared, deliberately non-media-named transport for extension/provider
// calls to EXTERNAL hosts: direct, SOCKS5 (with proxy-side DNS — socks5h
// semantics — and optional username/password auth), or direct-then-SOCKS5
// fallback restricted to transport/connectivity failures. This module never
// decides WHAT is reachable: provider host allowlists stay in the adapters,
// and core-internal traffic (DB, update engine, previews) never routes
// through here. Proxy credentials are structured values resolved from the
// extension runtime secret store — they must never appear in URLs, logs or
// error messages.

import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { SocksClient } from "socks";
import { Agent, type Dispatcher, fetch as undiciFetch } from "undici";

export type ExtensionOutboundMode = "direct" | "socks5" | "direct_then_socks5";

export interface Socks5ProxyConfig {
  readonly host: string;
  readonly port: number;
  /** socks5h semantics: the PROXY resolves hostnames (recommended default). */
  readonly remoteDns: boolean;
  readonly username?: string;
  readonly password?: string;
}

export interface ExtensionOutboundPolicy {
  readonly mode: ExtensionOutboundMode;
  readonly proxy?: Socks5ProxyConfig;
}

/** Fetch-compatible client honoring the policy (transport swap only). */
export type ExtensionFetchClient = (url: string, init?: RequestInit) => Promise<Response>;

const OUTBOUND_MODES: ReadonlySet<string> = new Set(["direct", "socks5", "direct_then_socks5"]);

function policyError(message: string): Error {
  return Object.assign(new Error(message), {
    code: "EXTENSION_OUTBOUND_POLICY_INVALID",
  });
}

/**
 * Reads the conventional `network` section of an extension config object
 * (as declared by the extension manifest `config_schema`) into a validated
 * policy. Absent section/`mode` ⇒ direct. Never throws on secret VALUES —
 * only on shapes; and never includes values in error messages.
 */
export function parseOutboundPolicy(config: Record<string, unknown>): ExtensionOutboundPolicy {
  const section = config["network"];
  if (section === undefined || section === null) return { mode: "direct" };
  if (typeof section !== "object") {
    throw policyError("network configuration must be an object");
  }
  const raw = section as Record<string, unknown>;
  const mode = raw["mode"] ?? "direct";
  if (
    typeof mode !== "string" ||
    (mode !== "direct" && mode !== "socks5" && mode !== "direct_then_socks5")
  ) {
    throw policyError("network.mode must be direct, socks5 or direct_then_socks5");
  }
  if (mode === "direct") return { mode: "direct" };
  const host = raw["proxy_host"];
  const port = raw["proxy_port"];
  if (typeof host !== "string" || host.length === 0 || host.length > 255) {
    throw policyError("network.proxy_host is required when a proxy mode is selected");
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw policyError("network.proxy_port must be an integer between 1 and 65535");
  }
  const username = raw["proxy_username"];
  const password = raw["proxy_password"];
  if (username !== undefined && (typeof username !== "string" || username.length > 255)) {
    throw policyError("network.proxy_username must be a string of at most 255 characters");
  }
  if (password !== undefined && (typeof password !== "string" || password.length > 1023)) {
    throw policyError("network.proxy_password must be a string of at most 1023 characters");
  }
  const remoteDns = raw["remote_dns"] === undefined ? true : raw["remote_dns"];
  if (typeof remoteDns !== "boolean") {
    throw policyError("network.remote_dns must be a boolean");
  }
  return {
    mode,
    proxy: {
      host,
      port,
      remoteDns,
      ...(typeof username === "string" && username.length > 0 ? { username } : {}),
      ...(typeof password === "string" && password.length > 0 ? { password } : {}),
    },
  };
}

/** Convenience for provider factories: parse config and build the client. */
export function createExtensionFetchClientFromConfig(
  config: Record<string, unknown>,
): ExtensionFetchClient {
  return createExtensionFetchClient(parseOutboundPolicy(config));
}

export function createExtensionFetchClient(policy: ExtensionOutboundPolicy): ExtensionFetchClient {
  if (policy.mode === "direct") return (url, init) => fetch(url, init);
  // undici ships its own fetch types that clash with the Node globals when
  // spread together — the runtime objects are compatible, so bridge via a cast.
  const dispatcherFetch = undiciFetch as unknown as ExtensionFetchClient;
  const spread = (init: RequestInit | undefined, dispatcher: Dispatcher): RequestInit =>
    ({ ...init, dispatcher }) as unknown as RequestInit;
  if (policy.mode === "socks5") {
    const dispatcher = socksDispatcher(requireProxy(policy));
    return (url, init) => dispatcherFetch(url, spread(init, dispatcher));
  }
  // direct_then_socks5: exactly one fallback, and only when the direct
  // attempt failed at the transport layer (no HTTP response was ever
  // received). Any valid HTTP response — including 4xx/5xx — means the
  // endpoint was reached and its error stays a provider-level semantic.
  // The direct attempt runs through a dedicated Agent with a bounded
  // CONNECT phase: a silently hanging direct path (observed on prod for
  // runware.ai — TCP connects, TLS never completes) must time out fast and
  // count as a transport failure, otherwise the caller's own abort signal
  // fires first, lands as AbortError ("gave up on purpose") and the SOCKS5
  // fallback never happens (2026-09-29: every runware schema fetch died
  // this way and model sync broke).
  const dispatcher = socksDispatcher(requireProxy(policy));
  const directAgent = new Agent({
    connect: { timeout: DIRECT_CONNECT_TIMEOUT_MS },
    headersTimeout: DIRECT_CONNECT_TIMEOUT_MS,
    bodyTimeout: DIRECT_CONNECT_TIMEOUT_MS,
  });
  return async (url, init) => {
    try {
      return await dispatcherFetch(url, spread(init, directAgent));
    } catch (cause) {
      if (!isTransportFailure(cause)) throw cause;
      return dispatcherFetch(url, spread(init, dispatcher));
    }
  };
}

/** Bound on the direct attempt's CONNECT phase in direct_then_socks5 mode. */
export const DIRECT_CONNECT_TIMEOUT_MS = 5_000;

function requireProxy(policy: ExtensionOutboundPolicy): Socks5ProxyConfig {
  if (policy.proxy === undefined) {
    throw policyError("proxy mode selected without proxy configuration");
  }
  return policy.proxy;
}

/**
 * Transport-failure classifier for direct_then_socks5. True only when the
 * request never got a response: DNS failure, connect timeout/refused,
 * network unreachable, TLS handshake failure, socket reset. Caller aborts
 * are NOT fallback-worthy (the caller gave up on purpose).
 *
 * ponytail: AbortError covers both caller give-up and a caller timeout that
 * happened to land in the connect window; telling them apart needs phase
 * tracking we don't need yet — add when a provider shows the symptom.
 */
export function isTransportFailure(cause: unknown): boolean {
  if (cause instanceof Error && cause.name === "AbortError") return false;
  if (cause instanceof TypeError && /invalid url/i.test(cause.message)) return false;
  for (
    let error: unknown = cause;
    error !== null && error !== undefined;
    error = (error as Error).cause
  ) {
    if (!(error instanceof Error)) break;
    const code = (error as Error & { code?: string }).code;
    if (typeof code === "string" && TRANSPORT_ERROR_CODES.has(code)) return true;
    if (/certificate|handshake|ssl|tls/i.test(error.message)) return true;
  }
  return false;
}

const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

/**
 * undici dispatcher whose TCP connections are established through the
 * SOCKS5 proxy. With `remoteDns` the hostname is sent to the proxy
 * (ATYP=domain — socks5h); otherwise it is resolved locally first. TLS for
 * https targets terminates END-TO-END here: the custom connector wraps the
 * tunnel socket itself, so the proxy never sees cleartext.
 */
function socksDispatcher(proxy: Socks5ProxyConfig): Dispatcher {
  return new Agent({
    connect: async ({ hostname, port, protocol }, callback) => {
      try {
        // undici passes port "" when the URL implies the default port.
        const destPort = Number(port) || (protocol === "https:" ? 443 : 80);
        const destination =
          proxy.remoteDns && !net.isIP(hostname)
            ? { host: hostname, port: destPort }
            : {
                host: net.isIP(hostname) ? hostname : (await dns.promises.lookup(hostname)).address,
                port: destPort,
              };
        const { socket } = await SocksClient.createConnection({
          proxy: {
            host: proxy.host,
            port: proxy.port,
            type: 5,
            ...(proxy.username !== undefined
              ? { userId: proxy.username, password: proxy.password ?? "" }
              : {}),
          },
          command: "connect",
          destination,
          timeout: 15_000,
        });
        if (protocol === "https:") {
          const tlsSocket = tls.connect({ socket, servername: hostname });
          await new Promise<void>((resolve, reject) => {
            const onSecure = (): void => {
              cleanup();
              resolve();
            };
            const onError = (cause: unknown): void => {
              cleanup();
              reject(cause);
            };
            const cleanup = (): void => {
              tlsSocket.off("secureConnect", onSecure);
              tlsSocket.off("error", onError);
            };
            tlsSocket.once("secureConnect", onSecure);
            tlsSocket.once("error", onError);
          });
          callback(null, tlsSocket);
        } else {
          callback(null, socket);
        }
      } catch (cause) {
        callback(cause instanceof Error ? cause : new Error(String(cause)), null);
      }
    },
  });
}
