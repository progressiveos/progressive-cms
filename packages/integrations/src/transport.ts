// Outbound HTTP transport boundary. Production wires the SSRF-guarded
// fetch (ssrf.ts); connectors and tests inject deterministic fakes — no
// first-party test ever touches a public network (Integrations spec §35).
export interface OutboundHttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
  /** Redirect behavior of guarded transports; default (and every other
   * value) is "follow". "none" returns a 3xx response as-is. */
  readonly redirectPolicy?: "follow" | "none";
}

export interface OutboundHttpResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * Attaches standard network-error classification to a transport failure:
 * everything thrown by a transport is a TRANSIENT (retryable) condition —
 * permanent classification is the connector's job based on response codes.
 */
export function networkFailure(error: unknown, hostLabel: string): ActionResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    retryable: true,
    providerErrorCode: "NETWORK_UNREACHABLE",
    // Safe summary: host label + error class only. URLs can carry
    // credentials in hostile configs and are never echoed into history.
    errorMessage: `${hostLabel}: ${message.slice(0, 200)}`,
  };
}

import type { ActionResult } from "./runtime.js";
export type OutboundHttp = (request: OutboundHttpRequest) => Promise<OutboundHttpResponse>;
