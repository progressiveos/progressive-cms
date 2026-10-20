// Guarded outbound HTTP executor (PCMS-INT-T011). Wraps node http/https
// directly because global fetch cannot pin a validated DNS address. Every
// hop: resolve → validate → pin → connect (TLS verification forced on) →
// bounded response read. Redirects are followed manually with full
// revalidation per hop; redirect_policy "none" returns a 3xx as-is.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createSsrfGuard, type SsrfGuard, type SsrfPolicy, type ValidatedTarget } from "./ssrf.js";
import type { OutboundHttpRequest, OutboundHttpResponse } from "./transport.js";

function readBodyWithCap(
  response: import("node:http").IncomingMessage,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy();
        rejectBody(new Error(`response exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    response.on("error", rejectBody);
  });
}

function requestPinned(
  target: ValidatedTarget,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly timeoutMs: number;
    readonly maxBytes: number;
  },
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const targetUrl = target.url;
  const isHttps = targetUrl.protocol === "https:";
  const port = targetUrl.port === "" ? (isHttps ? 443 : 80) : Number(targetUrl.port);
  const transport = isHttps ? httpsRequest : httpRequest;
  return new Promise((resolveRequest, rejectRequest) => {
    const request = transport(
      {
        // Host header stays the real hostname; the socket is pinned to the
        // validated address via the custom lookup — rebinding-proof.
        host: targetUrl.hostname.replace(/^\[|\]$/g, ""),
        port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: init.method,
        headers: { ...init.headers, host: targetUrl.host },
        lookup: (hostname, options, callback) => {
          // Node ≥20 (autoSelectFamily) requests `all: true` and expects an
          // ARRAY of {address, family} records; legacy callers expect the
          // (address, family) pair. Answer in the shape the caller asked
          // for — a single-string reply to an `all:true` lookup breaks
          // connection setup with ERR_INVALID_IP_ADDRESS (owner-reported on
          // the first real HQ connection; IP-literal hosts never hit it,
          // which is why the hermetic suite stayed green).
          const respond = (records: readonly { address: string; family: number }[]): void => {
            if (options?.all === true) {
              callback(null, records as never);
              return;
            }
            const first = records[0];
            if (first === undefined) {
              callback(new Error(`no addresses for ${hostname}`) as never, undefined as never);
              return;
            }
            callback(null, first.address as never, first.family as never);
          };
          // Allowlisted hosts pin the HOSTNAME itself (trusted by operator
          // config): resolve it normally at connect time.
          if (!/^[0-9a-f.:]+$/i.test(target.pinnedAddress.address)) {
            import("node:dns").then((dns) =>
              dns.lookup(
                target.pinnedAddress.address,
                { all: true, verbatim: true },
                (error, addresses) => {
                  if (error) {
                    callback(error as never, undefined as never);
                    return;
                  }
                  respond(addresses as never);
                },
              ),
            );
            return;
          }
          respond([{ address: target.pinnedAddress.address, family: target.pinnedAddress.family }]);
        },
        ...(isHttps ? { rejectUnauthorized: true } : {}),
        timeout: init.timeoutMs,
      },
      (response) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === "string") headers[name.toLowerCase()] = value;
        }
        readBodyWithCap(response, init.maxBytes)
          .then((body) => resolveRequest({ status: response.statusCode ?? 0, headers, body }))
          .catch(rejectRequest);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      rejectRequest(new Error("request timed out"));
    });
    request.on("error", rejectRequest);
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function createGuardedHttp(policy: SsrfPolicy = {}): {
  (request: OutboundHttpRequest): Promise<OutboundHttpResponse>;
  readonly guard: SsrfGuard;
} {
  const guard = createSsrfGuard(policy);
  return Object.assign(
    async (request: OutboundHttpRequest): Promise<OutboundHttpResponse> => {
      let target = await guard.resolveValidatedTarget(request.url);
      const followRedirects = request.redirectPolicy !== "none";
      const limit = guard.limits.maxRedirects;
      for (let hop = 0; ; hop += 1) {
        if (hop > limit) {
          throw new Error(`redirect count exceeds ${limit}`);
        }
        const response = await requestPinned(target, {
          method: request.method,
          headers: { ...(request.headers ?? {}) },
          ...(request.body === undefined ? {} : { body: request.body }),
          timeoutMs: request.timeoutMs ?? guard.limits.timeoutMs,
          maxBytes: guard.limits.maxResponseBytes,
        });
        if (
          followRedirects &&
          REDIRECT_STATUSES.has(response.status) &&
          response.headers["location"] !== undefined
        ) {
          const location = new URL(response.headers["location"], target.url).toString();
          // FULL revalidation of every hop (scheme + DNS + ranges + pin).
          target = await guard.resolveValidatedTarget(location);
          continue;
        }
        // Also the "none" path: a 3xx is returned as-is (body/status of the
        // redirect response itself) so payload+HMAC never leave for the
        // redirect target.
        return { status: response.status, body: response.body };
      }
    },
    { guard },
  );
}
