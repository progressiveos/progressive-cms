// REST /api/v1 transport (PCMS-API-T003..T007; API spec §3–§18).
// A thin Fastify adapter over the application operations: one auth pipeline,
// one error envelope, request-id correlation, durable idempotency. No
// business logic lives here.

import { createHash } from "node:crypto";
import type { Logger } from "@pcms/core";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ApplicationServices, OperationContext } from "../context.js";
import { ApiError, httpStatusForError, toErrorEnvelope } from "../errors.js";
import {
  anonymousContext,
  assertSameOriginRequest,
  assertSessionCsrf,
  authenticateRequest,
} from "./auth.js";
import { createIdempotencyService } from "./idempotency.js";
import type { ApiRoute, RouteResult } from "./registry.js";
import { isMutating, requiresCsrf } from "./registry.js";
import { makeCoreRoutes, makeOpenApiRoute } from "./routes/core.js";

export interface ApiPluginOptions {
  readonly application: ApplicationServices;
  readonly logger: Logger;
  /** Secure cookies (__Host- name). false only for plain-HTTP development. */
  readonly cookieSecure: boolean;
}

export const API_BODY_LIMIT_JSON = 1_048_576; // 1 MiB JSON
export const API_BODY_LIMIT_BINARY = 32 * 1_048_576; // 32 MiB default binary
// ponytail: mirrors the default video/audio ingest ceiling; raise together
// with the media.maxVideoUploadBytes config when owners need more.
export const API_BODY_LIMIT_MEDIA_UPLOAD = 256 * 1_048_576; // 256 MiB media upload
export { API_BODY_LIMIT_PCPUB } from "../pcpub-limits.js";

import { API_BODY_LIMIT_PCPUB } from "../pcpub-limits.js";

export interface ApiFastifyOptions {
  /**
   * Reverse-proxy addresses (IP/CIDR) whose X-Forwarded-* headers are trusted
   * (M15, PCMS-OPS-T105; Operations spec §19/§20). Absent/empty = trust
   * nobody: request.protocol then reflects the direct socket, so a spoofed
   * scheme/canonical URL is impossible. Invalid entries fail at bind time.
   */
  readonly trustProxy?: readonly string[];
}

/**
 * Fastify instance preconfigured for the API surface: unknown JSON fields in
 * write schemas are REJECTED, never silently stripped (owner instruction #78;
 * Fastify's default AjV removes them). Composition roots must create their
 * server through this helper — the plugin refuses to mount otherwise.
 */
export function createApiFastify(
  genReqId: () => string,
  options: ApiFastifyOptions = {},
): FastifyInstance {
  const fastify = Fastify({
    genReqId,
    trustProxy: options.trustProxy === undefined ? false : [...options.trustProxy],
    ajv: { customOptions: { removeAdditional: false, allErrors: true } },
  });
  // Baseline security headers on every response (PCMS-OPS-T106; Operations
  // spec §22). Surfaces may override with stricter values (the Admin static
  // plugin sets `no-referrer`; public HTML adds CSP from the theme
  // declaration). CSP itself is surface-owned: an API JSON envelope and an
  // HTML page need different policies, so the framework baseline stops at
  // the always-correct headers.
  fastify.addHook("onRequest", async (_request, reply) => {
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("referrer-policy", "strict-origin-when-cross-origin");
    void reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  });
  return fastify;
}

/**
 * Builds the full /api/v1 route set (core + later domain modules) and the
 * Fastify plugin that mounts it.
 */
export function createApiV1(domainRoutes: readonly ApiRoute[]) {
  return async function apiV1(fastify: FastifyInstance, options: ApiPluginOptions): Promise<void> {
    const { application, logger, cookieSecure } = options;
    let warnedUntrustedForwarded = false;
    const coreRoutes = makeCoreRoutes({ cookieSecure });
    const routes: ApiRoute[] = [
      ...coreRoutes,
      ...domainRoutes,
      makeOpenApiRoute(routesOf(coreRoutes, domainRoutes)),
    ];
    const idempotency = createIdempotencyService(application.pool);

    // Every response carries the correlation id (spec §9), and every request
    // leaves one structured line — method/url/status/duration only, never
    // headers or bodies (spec §85).
    fastify.addHook("onRequest", async (request, reply) => {
      void reply.header("x-request-id", request.id);
      // Deployment-trap detector (one warning per process): a request
      // carrying forwarded headers from a NON-trusted peer means a reverse
      // proxy exists but http.trustedProxies does not list it. Everything
      // still works for anonymous traffic, then the first authenticated
      // mutation dies on API_ORIGIN_MISMATCH (scheme/host resolve to the
      // socket, not the public site) — exactly the p-cms.ru 2026-10-01
      // login incident. Name the fix at the first sight instead.
      const forwarded = request.headers["x-forwarded-for"] ?? request.headers["x-forwarded-proto"];
      // Untrusted = the peer's forwarded headers were ignored, i.e. request.ip
      // still resolves to the socket address while X-Forwarded-* travel with
      // the request.
      if (
        !warnedUntrustedForwarded &&
        forwarded !== undefined &&
        request.ip === request.socket?.remoteAddress
      ) {
        warnedUntrustedForwarded = true;
        logger.warn("http.untrusted_proxy_headers", {
          operation: "http.untrusted_proxy_headers",
          peer_ip: request.ip,
          hint: "a reverse proxy forwards this traffic but is not listed in http.trustedProxies; X-Forwarded-* are ignored, so scheme/host (origin checks, secure cookies, client IP) resolve wrong. Add the proxy address to http.trustedProxies and restart.",
        });
      }
    });
    fastify.addHook("onResponse", async (request, reply) => {
      logger.info("http.request", {
        operation: "http.request",
        request_id: request.id,
        // Transport-resolved peer (trustProxy-aware): for RP traffic this is
        // the real client once the RP is listed in http.trustedProxies;
        // untrusted peers cannot spoof it (XFF from them is ignored).
        client_ip: request.ip,
        method: request.method,
        url: request.url.split("?")[0],
        status_code: reply.statusCode,
        duration_ms: Number(reply.elapsedTime.toFixed(1)),
      });
    });

    // Direct binary media uploads (spec §35): bounded octet-stream bodies.
    fastify.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: API_BODY_LIMIT_BINARY },
      (_request, body, done) => {
        done(null, body);
      },
    );

    // .pcpub ingest (ADR-0014 §8): bounded raw ZIP bodies. The route-level
    // bodyLimit overrides per request; the cap here mirrors the default.
    fastify.addContentTypeParser(
      "application/vnd.progressive-cms.pcpub+zip",
      { parseAs: "buffer", bodyLimit: API_BODY_LIMIT_PCPUB },
      (_request, body, done) => {
        done(null, body);
      },
    );

    const specByMethodUrl = new Map<string, ApiRoute>();
    for (const route of routes) {
      specByMethodUrl.set(`${route.spec.method} ${route.spec.url}`, route);
    }

    fastify.setErrorHandler((error, request, reply) => {
      const status = httpStatusForError(error);
      if (status >= 500) {
        logger.error("api.request_failed", {
          operation: "api.request_failed",
          request_id: request.id,
          method: request.method,
          url: request.url,
          status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      void reply.status(status).send(toErrorEnvelope(error, request.id));
    });

    fastify.setNotFoundHandler((request, reply) => {
      void reply.status(404).send(
        toErrorEnvelope(
          new ApiError("API_NOT_FOUND", `no route ${request.method} ${request.url}`, {
            status: 404,
          }),
          request.id,
        ),
      );
    });

    async function resolveContext(
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<OperationContext | null> {
      const spec = currentSpec(request);
      if (spec?.spec.operationId === "auth_login") {
        // Login establishes a new identity; an expired cookie must not block it.
        assertSameOriginRequest(request);
        return anonymousContext(request.id);
      }
      const auth = await authenticateRequest(application, request, { cookieSecure });
      if (auth === null) {
        if (spec?.spec.auth === "public") return anonymousContext(request.id);
        void reply.status(401).send(
          toErrorEnvelope(
            new ApiError("AUTH_UNAUTHENTICATED", "authentication required", {
              status: 401,
            }),
            request.id,
          ),
        );
        return null;
      }
      if (spec !== undefined && auth.via === "session" && isMutating(spec.spec)) {
        // Origin assertion guards every browser-session mutation (spec §17),
        // including csrf:false routes — it must not be bypassable via the
        // synchronizer opt-out.
        assertSameOriginRequest(request);
        if (requiresCsrf(spec.spec)) assertSessionCsrf(auth, request);
      }
      return { actor: auth.actor, transport: "rest", requestId: request.id };
    }

    function currentSpec(request: FastifyRequest): ApiRoute | undefined {
      const pattern = request.routeOptions?.url;
      if (typeof pattern === "string") {
        return specByMethodUrl.get(`${request.method} ${pattern.slice("/api/v1".length)}`);
      }
      return undefined;
    }

    async function execute(route: ApiRoute, request: FastifyRequest): Promise<RouteResult> {
      // resolveContext is invoked through the preValidation hook below; the
      // context travels on the request for the handler.
      const ctx = (request as RequestWithCtx).pcmsContext;
      let result: RouteResult;
      if (route.spec.idempotency !== undefined) {
        result = await runIdempotent(route, request, ctx);
      } else {
        result = await route.handle(application, ctx, request);
      }
      return result;
    }

    interface RequestWithCtx extends FastifyRequest {
      pcmsContext: OperationContext;
    }

    async function runIdempotent(
      route: ApiRoute,
      request: FastifyRequest,
      ctx: OperationContext,
    ): Promise<RouteResult> {
      if (route.spec.permission !== undefined)
        application.authorize(ctx.actor, route.spec.permission);
      const key = request.headers["idempotency-key"];
      if (route.spec.idempotency === "required" && typeof key !== "string") {
        throw new ApiError("API_REQUEST_INVALID", "Idempotency-Key header is required", {
          status: 400,
        });
      }
      if (typeof key !== "string") {
        return route.handle(application, ctx, request);
      }
      const outcome = await idempotency.run({
        operation: route.spec.operationId,
        key,
        scope: JSON.stringify([
          ctx.actor.type,
          ctx.actor.id,
          ctx.actor.siteKey,
          ctx.actor.environment,
        ]),
        fingerprint: {
          url: request.url.split("?")[0],
          body: Buffer.isBuffer(request.body)
            ? { sha256: createHash("sha256").update(request.body).digest("hex") }
            : (request.body ?? null),
          ...(Buffer.isBuffer(request.body)
            ? {
                filename: request.headers["x-pcms-filename"],
                mime: request.headers["x-pcms-mime-type"],
                folder: request.headers["x-pcms-folder-id"],
              }
            : {}),
        },
        run: () => route.handle(application, ctx, request),
      });
      return outcome.result;
    }

    for (const route of routes) {
      const url = `/api/v1${route.spec.url}`;
      fastify.route({
        method: route.spec.method,
        url,
        bodyLimit: route.spec.bodyLimit ?? API_BODY_LIMIT_JSON,
        // Real runtime validation from the same schemas the contract
        // documents — documented and served behavior cannot drift (spec §4).
        schema: {
          ...(route.spec.bodySchema === undefined ? {} : { body: route.spec.bodySchema }),
          ...(route.spec.querySchema === undefined ? {} : { querystring: route.spec.querySchema }),
          ...(route.spec.paramsSchema === undefined ? {} : { params: route.spec.paramsSchema }),
        },
        preValidation: async (request, reply) => {
          // POST/PUT/PATCH with no body on a route that DECLARES a body schema:
          // an absent body validates as {} so `{}`-shaped contracts (optional
          // fields only) do not force clients to guess about empty payloads
          // (2026-09-29 site-developer report). Schemas with required fields
          // still reject, as they should.
          if (
            request.method !== "GET" &&
            request.method !== "HEAD" &&
            request.body === undefined &&
            route.spec.bodySchema !== undefined &&
            (route.spec.bodySchema as { required?: unknown }).required === undefined
          ) {
            request.body = {};
          }
          const ctx = await resolveContext(request, reply);
          if (ctx === null) return reply;
          (request as RequestWithCtx).pcmsContext = ctx;
          return undefined;
        },
        async handler(request, reply) {
          const result = await execute(route, request);
          void reply
            .status(result.status)
            .headers({ ...(result.headers ?? {}) })
            .send(result.body);
          return reply;
        },
      });
    }
  };
}

function routesOf(...groups: readonly (readonly ApiRoute[])[]): readonly ApiRoute[] {
  return groups.flat();
}
