// REST authentication pipeline (PCMS-API-T004/T005; spec §15–§18).
//
// Exactly one ActorContext per request, resolved through the M08 services:
//   Authorization: Bearer <service-account token> → actorResolver
//   __Host-pcms_session cookie                    → sessionActor
// REST owns no identity model, no superuser shortcuts; browser sessions must
// additionally present the CSRF synchronizer token on mutations (spec §17) —
// SameSite is defense in depth, never the control.

import {
  type ActorContext,
  assertCsrfToken,
  assertSameOrigin,
  DEFAULT_SESSION_COOKIE,
  parseSessionCookie,
  type SessionCookieConfig,
} from "@pcms/auth";
import type { FastifyRequest } from "fastify";
import type { ApplicationServices, OperationContext } from "../context.js";
import { ApiError } from "../errors.js";

export const API_CSRF_HEADER = "x-pcms-csrf";

/** Cookie name for plain-HTTP development (no __Host- prefix allowed there). */
export function sessionCookieConfig(secure: boolean): SessionCookieConfig {
  if (secure) return DEFAULT_SESSION_COOKIE;
  return { name: "pcms_session", secure: false, sameSite: "Lax" };
}

interface RequestAuth {
  readonly actor: ActorContext;
  /** "bearer" mutations skip CSRF (machine semantics, spec §17). */
  readonly via: "bearer" | "session";
  readonly csrfHash: string | null;
}

/** Resolves bearer token or session cookie into one ActorContext. */
export async function authenticateRequest(
  app: ApplicationServices,
  request: FastifyRequest,
  options: { cookieSecure: boolean },
): Promise<RequestAuth | null> {
  const authorization = request.headers.authorization;
  if (authorization !== undefined && authorization.length > 0) {
    const [scheme, ...rest] = authorization.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || rest.length === 0) {
      throw new ApiError("AUTH_TOKEN_INVALID", "Authorization header must be a Bearer token", {
        status: 401,
      });
    }
    const result = await app.actorResolver.authenticateToken(rest.join(" ").trim(), {
      // Constraints arrive as request context headers; the token's own
      // site/environment binding stays authoritative (fail-secure, spec §18).
      siteKey: headerValue(request.headers["x-pcms-site"]) ?? null,
      environment: headerValue(request.headers["x-pcms-environment"]) ?? null,
    });
    return { actor: result.actor, via: "bearer", csrfHash: null };
  }

  const rawToken = parseSessionCookie(
    request.headers.cookie,
    sessionCookieConfig(options.cookieSecure),
  );
  if (rawToken === null) return null;
  const resolved = await app.sessions.resolveSession(rawToken);
  if (resolved === null) {
    throw new ApiError("AUTH_SESSION_INVALID", "session is invalid or expired", { status: 401 });
  }
  const actor = await app.actorResolver.sessionActor(resolved);
  return { actor, via: "session", csrfHash: resolved.csrfHash };
}

/** Enforces the CSRF synchronizer token for browser-session mutations. */
export function assertSessionCsrf(auth: RequestAuth, request: FastifyRequest): void {
  if (auth.via !== "session") return;
  const provided = request.headers[API_CSRF_HEADER];
  assertCsrfToken(auth.csrfHash, typeof provided === "string" ? provided : undefined);
}

/**
 * Rejects session mutations carrying a cross-site Origin header (spec §17
 * defense in depth around the synchronizer token). Requests without an Origin
 * pass — non-browser clients never send one — and the synchronizer token
 * stays mandatory regardless. The expected origin is the request's own scheme
 * + authority: both resolve through the trusted-proxy configuration, so
 * X-Forwarded-Proto/Host are honored only from trusted proxies and otherwise
 * ignored (spoof-proof). `host` (not `hostname`) keeps the port so requests
 * to non-default ports are not falsely rejected.
 */
export function assertSameOriginRequest(request: FastifyRequest): void {
  const origin = request.headers.origin;
  const expected = `${request.protocol}://${request.host}`;
  try {
    assertSameOrigin(
      typeof origin === "string" && origin.length > 0 ? origin : undefined,
      expected,
    );
  } catch (cause) {
    // Both values are already known to the calling browser (its own Origin
    // and the Host it addressed) — naming them turns the recurring
    // "untrusted reverse proxy" deployment mistake into a self-diagnosing
    // error instead of a support session.
    throw new ApiError("API_ORIGIN_MISMATCH", "cross-site origin rejected", {
      status: 403,
      cause,
      details: [
        {
          code: "ORIGIN_EXPECTED",
          message: "request origin does not match the request authority",
          expected_origin: expected,
          got_origin: typeof origin === "string" ? origin : null,
          hint: "if the site is served through a reverse proxy, its actual peer address (see the web service journal: http.untrusted_proxy_headers peer_ip) must be listed in http.trustedProxies in the instance config; then restart the web service",
        },
      ],
    });
  }
}

/** Fail-secure context for public routes: no identity, zero permissions. */
export function anonymousContext(requestId: string): OperationContext {
  return {
    actor: {
      type: "USER",
      id: "anonymous",
      permissions: new Set(),
      siteKey: null,
      environment: null,
      strength: { factors: [], authenticatedAt: new Date(0), mfaAt: null },
      sessionId: null,
    },
    transport: "rest",
    requestId,
  };
}

function headerValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
