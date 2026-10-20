// Core REST routes (PCMS-API-T003..T005): server contract info, current
// actor, browser session lifecycle. The auth flows delegate entirely to the
// M08 services — the transport never re-implements login/throttle/CSRF
// (owner instructions #15/#18/#19).
import {
  createProvisioningService,
  createRoleService,
  DEFAULT_SESSION_TIMEOUTS,
  parseSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "@pcms/auth";
import { BLOCK_DOCUMENT_SCHEMA_VERSION } from "@pcms/blocks";
import { THEME_CONTRACT_VERSION } from "@pcms/themes";
import type { OperationContext } from "../../context.js";
import { readCmsVersionFromRelease } from "../../context.js";
import { getDiagnosticsOp } from "../../diagnostics-ops.js";
import { ApiError } from "../../errors.js";
import { sessionCookieConfig } from "../auth.js";
import { API_CONTRACT_VERSION, buildOpenApiDocument, stableStringify } from "../openapi.js";
import type { ApiRoute } from "../registry.js";

export interface CoreRouteOptions {
  readonly cookieSecure: boolean;
}

function maxAgeSeconds(): number {
  return DEFAULT_SESSION_TIMEOUTS.absoluteTimeoutMilliseconds / 1000;
}

function requireUserId(ctx: OperationContext): string {
  if (ctx.actor.type !== "USER" || ctx.actor.sessionId === null) {
    throw new ApiError("AUTH_SESSION_INVALID", "this endpoint requires a browser session", {
      status: 403,
    });
  }
  return ctx.actor.sessionId;
}

/** Session lifecycle + server contract + current actor. */
export function makeCoreRoutes(options: CoreRouteOptions): ApiRoute[] {
  const cookieConfig = sessionCookieConfig(options.cookieSecure);

  const authRoutes: ApiRoute[] = [
    {
      spec: {
        method: "POST",
        url: "/auth/login",
        operationId: "auth_login",
        summary: "Browser login: password (+ MFA stage), issues session cookie + CSRF token",
        tag: "auth",
        auth: "public",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: { type: "string", maxLength: 320 },
            password: { type: "string", maxLength: 1024 },
          },
        },
      },
      async handle(app, _ctx, request) {
        const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
        if (typeof body.email !== "string" || typeof body.password !== "string") {
          throw new ApiError("API_REQUEST_INVALID", "email and password are required", {
            status: 400,
          });
        }
        const result = await app.authentication.login({
          email: body.email,
          password: body.password,
          ip: request.ip,
          transport: "api",
          metadata: { clientClass: "browser" },
        });
        const headers = {
          "set-cookie": serializeSessionCookie(
            cookieConfig,
            result.session.rawToken,
            maxAgeSeconds(),
          ),
          "cache-control": "no-store",
        };
        return {
          status: 200,
          headers,
          body: {
            stage: result.stage,
            user_id: result.user.id,
            mfa_required: result.mfaRequired,
            csrf_token: result.session.csrfToken,
          },
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/auth/invite/accept",
        operationId: "auth_invite_accept",
        summary: "Accept a single-use invite: sets the first password (token IS the credential)",
        tag: "auth",
        auth: "public",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["invite_token", "password"],
          properties: {
            invite_token: { type: "string", minLength: 10, maxLength: 200 },
            password: { type: "string", maxLength: 1024 },
          },
        },
      },
      async handle(app, _ctx, request) {
        const body = (request.body ?? {}) as { invite_token?: unknown; password?: unknown };
        if (typeof body.invite_token !== "string" || typeof body.password !== "string") {
          throw new ApiError("API_REQUEST_INVALID", "invite_token and password are required", {
            status: 400,
          });
        }
        const { createProvisioningService, createRoleService } = await import("@pcms/auth");
        const provisioning = createProvisioningService(app.pool, {
          users: app.users,
          passwords: app.passwords,
          policy: app.passwordPolicy,
          roles: createRoleService(app.pool),
          onPasswordChanged: async (userId) => {
            await app.sessions.revokeAllForUser(userId as never, "invite accepted");
          },
        });
        const user = await provisioning.acceptInvite({
          inviteToken: body.invite_token,
          password: body.password,
        });
        return {
          status: 200,
          headers: { "cache-control": "no-store" },
          body: { user_id: user.id },
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/auth/mfa",
        operationId: "auth_mfa_complete",
        summary: "Complete MFA for the pending session with a TOTP code",
        tag: "auth",
        auth: "authenticated",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["code"],
          properties: { code: { type: "string", minLength: 6, maxLength: 10 } },
        },
      },
      async handle(app, ctx, request) {
        const sessionId = requireUserId(ctx);
        const body = (request.body ?? {}) as { code?: unknown };
        if (typeof body.code !== "string") {
          throw new ApiError("API_REQUEST_INVALID", "code is required", { status: 400 });
        }
        const valid = await app.totp.verifyCode(ctx.actor.id, body.code);
        if (!valid) {
          throw new ApiError("AUTH_MFA_INVALID_CODE", "invalid MFA code", { status: 401 });
        }
        await app.sessions.markMfaSatisfied(sessionId);
        return { status: 200, body: { stage: "OK" } };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/auth/logout",
        operationId: "auth_logout",
        summary: "Revoke the current session and clear the cookie",
        tag: "auth",
        auth: "authenticated",
        csrf: true,
      },
      async handle(app, _ctx, request) {
        const rawToken = parseSessionCookie(request.headers.cookie, cookieConfig);
        if (rawToken !== null) {
          const resolved = await app.sessions.resolveSession(rawToken);
          if (resolved !== null) {
            await app.sessions.revokeSession(resolved.session.id, "logout via REST");
          }
        }
        return {
          status: 200,
          headers: { "set-cookie": serializeClearedSessionCookie(cookieConfig) },
          body: { ok: true },
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/auth/session/rotate",
        operationId: "auth_rotate_session",
        summary:
          "Rotate the current session (new cookie + CSRF token); lets an already-authenticated Admin tab re-acquire its synchronizer token after a reload (M10)",
        tag: "auth",
        auth: "authenticated",
        // csrf:false is the reload-recovery exception (spec §17 review): the
        // cold SPA has no synchronizer token yet — this route exists to mint
        // one. Still a session-authenticated mutation, so the plugin's origin
        // assertion applies, and the cookie is SameSite=Lax HttpOnly: a
        // cross-site request can neither carry nor benefit from it.
        csrf: false,
      },
      async handle(app, ctx, request) {
        const sessionId = requireUserId(ctx);
        const rawToken = parseSessionCookie(request.headers.cookie, cookieConfig);
        if (rawToken === null) {
          throw new ApiError("AUTH_SESSION_INVALID", "no session cookie", { status: 401 });
        }
        // M08 rotation semantics (spec §31): the old session row is revoked
        // atomically and the fresh one carries the same authentication
        // strength — a stale cookie can never rotate.
        const rotated = await app.sessions.rotateSession(rawToken);
        return {
          status: 200,
          headers: {
            "set-cookie": serializeSessionCookie(cookieConfig, rotated.rawToken, maxAgeSeconds()),
            "cache-control": "no-store",
          },
          body: { user_id: rotated.userId, csrf_token: rotated.csrfToken },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/auth/sessions",
        operationId: "auth_list_sessions",
        summary: "List the current user's active sessions",
        tag: "auth",
        auth: "authenticated",
      },
      async handle(app, ctx) {
        const sessionId = requireUserId(ctx);
        const sessions = await app.sessions.listActiveSessions(ctx.actor.id);
        return {
          status: 200,
          body: {
            items: sessions.map((session) => ({
              session_id: session.id,
              current: session.id === sessionId,
              created_at: session.createdAt.toISOString(),
              last_seen_at: session.lastSeenAt.toISOString(),
              expires_at: session.expiresAt.toISOString(),
            })),
          },
        };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/auth/sessions/:sessionId",
        operationId: "auth_revoke_session",
        summary: "Revoke one of the current user's sessions",
        tag: "auth",
        auth: "authenticated",
        csrf: true,
        paramsSchema: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string" } },
        },
      },
      async handle(app, ctx, request) {
        requireUserId(ctx);
        const params = request.params as { sessionId: string };
        const sessions = await app.sessions.listActiveSessions(ctx.actor.id);
        if (!sessions.some((session) => session.id === params.sessionId)) {
          throw new ApiError("AUTH_SESSION_INVALID", "no such active session", { status: 404 });
        }
        await app.sessions.revokeSession(params.sessionId, "revoked via REST");
        return { status: 200, body: { ok: true } };
      },
    },
  ];

  const coreRoutes: ApiRoute[] = [
    {
      spec: {
        method: "GET",
        url: "/server",
        operationId: "get_server_info",
        summary: "Server identity + subsystem contract versions (spec §20)",
        tag: "server",
        auth: "authenticated",
      },
      async handle(app) {
        return {
          status: 200,
          body: {
            name: "progressive-cms",
            api_version: "v1",
            contract_versions: {
              api: API_CONTRACT_VERSION,
              theme: THEME_CONTRACT_VERSION,
              block_document: BLOCK_DOCUMENT_SCHEMA_VERSION,
              bundle: 1,
            },
            server_time: app.clock.now().toISOString(),
          },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/diagnostics",
        operationId: "get_diagnostics",
        summary:
          "Remote diagnostics: release version, DB, worker queue/heartbeat + recent job errors, media providers, registry binding, maintenance (site.validate).",
        tag: "server",
        auth: "authenticated",
        permission: "site.validate",
      },
      async handle(app, ctx) {
        return { status: 200, body: await getDiagnosticsOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/actor",
        operationId: "get_current_actor",
        summary: "Non-secret projection of the resolved ActorContext (spec §53)",
        tag: "actor",
        auth: "authenticated",
      },
      async handle(_app, ctx) {
        return {
          status: 200,
          body: {
            actor_type: ctx.actor.type,
            actor_id: ctx.actor.id,
            permissions: [...ctx.actor.permissions].sort(),
            site_key: ctx.actor.siteKey,
            environment: ctx.actor.environment,
            factors: [...ctx.actor.strength.factors],
            authenticated_at: ctx.actor.strength.authenticatedAt.toISOString(),
            transport: ctx.transport,
          },
        };
      },
    },
  ];

  return [...coreRoutes, ...authRoutes];
}

/** The machine contract document itself, served under /api/v1/openapi.json.
 * Access policy: authenticated (default-deny; owner instruction #136). */
export function makeOpenApiRoute(routes: readonly ApiRoute[]): ApiRoute {
  let cached: string | null = null;
  const self: ApiRoute = {
    spec: {
      method: "GET",
      url: "/openapi.json",
      operationId: "get_openapi_document",
      summary: "OpenAPI 3.1 contract of this API (deterministic release artifact)",
      tag: "server",
      auth: "authenticated",
    },
    async handle(app) {
      if (cached === null) {
        // The served contract names the running build (spangar frictions
        // report P3-7: a static "1.0.0" told agents nothing).
        cached = stableStringify(
          buildOpenApiDocument([...routes, self], { cmsVersion: readCmsVersionFromRelease() }),
        );
      }
      const doc = JSON.parse(cached) as { paths?: Record<string, unknown> };
      // Extension-contributed operations are first-class API surface too
      // (2026-09-29 site-developer report: research search/fetch were found
      // by brute force — the documented contract must include them). Live
      // merge: extension lifecycle changes reflect without a restart of the
      // cached first-party half.
      doc.paths ??= {};
      const paths = doc.paths;
      for (const operation of await app.extensionOperations.list()) {
        const path = `/extensions/${operation.extension_id}/operations/${operation.operation_id}`;
        paths[path] = {
          post: {
            operationId: `ext_${operation.extension_id}_${operation.operation_id}`,
            summary: operation.title,
            description: `Contributed by extension "${operation.extension_id}" (deployed, enabled).`,
            tags: ["extensions"],
            "x-permission": operation.permission,
            "x-extension": operation.extension_id,
            requestBody: {
              required: true,
              content: { "application/json": { schema: operation.input_schema } },
            },
            responses: {
              "200": {
                description: "Success",
                content: { "application/json": { schema: operation.output_schema } },
              },
              "400": { description: "Invalid request syntax (request schema)" },
              "401": { description: "Unauthenticated" },
              "403": { description: "Authenticated but forbidden" },
              "422": { description: "Semantic validation failed" },
              "500": { description: "Unexpected internal error" },
            },
          },
        };
      }
      return {
        status: 200,
        headers: { "cache-control": "private, max-age=60" },
        body: doc,
      };
    },
  };
  return self;
}
