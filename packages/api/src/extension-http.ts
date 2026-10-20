// Extension HTTP dispatch (CORE-SHOP-01 P0-b; ADR-0018).
//
// Core Routing owns extension public URLs: an operator-assigned site-level
// mount (pcms_extension_route_mounts) + the enabled extension's manifest
// http_routes produce the effective router. The built-in technical space
// "/x/<extensionId>/..." always mirrors the same routes for integrations
// and is never canonical. The composed set is stamped with the R3 lifecycle
// revision — a disable in ANY process withdraws routes before the next
// request. Reserved prefixes never dispatch to an extension (mount
// preflight forbids claiming them; the technical space starts with "/x/").
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type ExtensionCatalog,
  type ExtensionHttpCallContext,
  resolveHandler,
} from "@pcms/extensions/internal";
import { localizedRoutePath } from "@pcms/routing";
import type { ApplicationServices, OperationContext } from "./context.js";
import { requirePermission } from "./context.js";
import { buildExtensionCallContext } from "./extension-platform.js";
import type { ExtensionRouteService } from "./extension-routes.js";
import { createIdempotencyService } from "./http/idempotency.js";
import { createRateLimiter } from "./http/routes/search.js";

export interface ExtensionHttpFacts {
  readonly path: string;
  readonly method: string;
  readonly query: Readonly<Record<string, string | string[]>>;
  /** Enabled non-default site locale peeled from the public path prefix. */
  readonly locale?: string;
  /** Parsed request body for POST/PUT routes (JSON or undefined). */
  readonly body?: unknown;
  /** Transport facts for the public mutation contract (PREPUBLIC §5):
   * Origin/Referer checks, server-issued guest cookie and rate-limit key. */
  readonly mutation?: {
    /** Requested host (Host header), lowercased. */
    readonly host: string;
    readonly ip: string;
    /** Selected headers, already lowercased names. */
    readonly headers: Readonly<Record<string, string | undefined>>;
  };
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const GUEST_COOKIE_NAME = "pcms_guest";
const GUEST_SESSION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const GUEST_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

async function guestIdentityFrom(
  app: ApplicationServices,
  mutation: NonNullable<ExtensionHttpFacts["mutation"]>,
  rateLimitCreation: (ip: string) => void,
): Promise<{ readonly id: string; readonly authenticated: boolean; readonly setCookie?: string }> {
  const cookieValues = (mutation.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${GUEST_COOKIE_NAME}=`))
    .map((part) => part.slice(GUEST_COOKIE_NAME.length + 1));
  const presented = cookieValues.length === 1 ? cookieValues[0] : undefined;
  const site = await app.routes.ensureSite(app.defaultSiteKey);
  if (presented !== undefined && GUEST_SESSION_TOKEN_PATTERN.test(presented)) {
    const tokenHash = createHash("sha256").update(presented).digest("hex");
    const found = await app.pool.query<{ id: string }>(
      `SELECT id FROM pcms_guest_sessions
       WHERE site_id = $1 AND token_hash = $2 AND expires_at > now()`,
      [site.id, tokenHash],
    );
    if (found.rows[0] !== undefined) return { id: found.rows[0].id, authenticated: true };
  }

  rateLimitCreation(mutation.ip);
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + GUEST_SESSION_MILLISECONDS);
  await app.pool.query(
    `INSERT INTO pcms_guest_sessions (id, site_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [id, site.id, createHash("sha256").update(token).digest("hex"), expiresAt],
  );
  await app.pool.query(
    `DELETE FROM pcms_guest_sessions
     WHERE id IN (
       SELECT id FROM pcms_guest_sessions WHERE expires_at <= now()
       ORDER BY expires_at LIMIT 100
     )`,
  );
  const secure = app.environmentClassification === "production" ? "; Secure" : "";
  return {
    id,
    authenticated: false,
    setCookie: `${GUEST_COOKIE_NAME}=${token}; Max-Age=${GUEST_SESSION_MILLISECONDS / 1000}; Path=/; HttpOnly; SameSite=Lax${secure}`,
  };
}

/** Origin policy (PREPUBLIC §5): browsers always send Origin/Referer on
 * cross-site writes — when present it MUST match the requested host
 * (same-origin enforcement); absence is a non-browser client, which the
 * rate limit + idempotency anti-replay cover instead. */
function originMatchesHost(mutation: NonNullable<ExtensionHttpFacts["mutation"]>): boolean {
  for (const name of ["origin", "referer"]) {
    const value = mutation.headers[name];
    if (value === undefined || value === "") continue;
    try {
      if (new URL(value).host.toLowerCase() !== mutation.host.toLowerCase()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** A typed view model response (the ONLY html-capable shape; the render
 * itself always goes through the Theme renderer — R2). */
export interface ExtensionViewResponse {
  readonly view_id: string;
  readonly model: unknown;
  readonly head: {
    readonly title?: string;
    readonly canonical?: string | null;
    readonly robots?: string | null;
    readonly json_ld?: readonly unknown[];
  };
  readonly media_ids?: readonly string[];
}

export type ExtensionDispatchResult =
  | { readonly kind: "miss" }
  | {
      readonly kind: "view";
      readonly setCookie?: string;
      readonly extensionId: string;
      readonly response: ExtensionViewResponse;
      /** The registered view metadata (schema version, base template path). */
      readonly view: {
        readonly baseTemplate: string;
        readonly schemaVersion: string;
        readonly extensionsDir: string;
        /** Canonical public path (mount-based, CORE-SHOP-SEO-01). */
        readonly canonicalPath: string;
        readonly canonicalUrl: string | null;
        /** Resolved request locale used by the active theme layout. */
        readonly locale: string;
      };
    }
  | {
      readonly kind: "json";
      readonly status: number;
      readonly body: unknown;
      readonly setCookie?: string;
    }
  | {
      readonly kind: "redirect";
      readonly status: 301 | 302 | 308;
      readonly location: string;
      readonly setCookie?: string;
    }
  | {
      readonly kind: "failure";
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly setCookie?: string;
    };

export interface ExtensionHttpRouter {
  /** Resolves and executes an extension route, or reports a miss (the site
   * continues with normal routing). Handler-level failures come back as
   * `failure` results — the transport decides the HTTP shape. */
  dispatch(
    app: ApplicationServices,
    facts: ExtensionHttpFacts,
    ctx: OperationContext | null,
  ): Promise<ExtensionDispatchResult>;
}

interface CompiledRoute {
  readonly extensionId: string;
  readonly routeId: string;
  readonly method: string;
  readonly segments: readonly string[];
  readonly visibility: "public" | "session" | "admin";
  readonly permission: string | undefined;
  readonly handler: string;
  readonly responseSchema: Record<string, unknown> | undefined;
  readonly view: string | undefined;
}

/** THE extension canonical path builder (PREPUBLIC §3 URL contract): every
 * surface — HTTP canonical/redirect, search document route, sitemap
 * candidates — derives the public path through this ONE function, so all
 * surfaces agree byte-for-byte and the locale dimension slots in without a
 * URL-shape change: a mount is locale-agnostic; a non-default locale
 * prefixes the complete mounted path exactly like entry routes do
 * (localizedRoutePath).
 * Site route policy default: trailing slash on non-root paths (spec §24
 * baseline); policy-aware per site is v2 and does not change the shape. */
export function extensionCanonicalPath(route: {
  readonly mountPath: string | null;
  readonly extensionId: string;
  /** Mount-relative route from the extension (starts with "/"). */
  readonly path: string;
  /** Document locale; default-scope documents pass "default"/"x-default". */
  readonly locale?: string;
  readonly defaultLocale?: string;
}): string {
  const mount = route.mountPath ?? `/x/${route.extensionId}`;
  const mountedPath = mount === "/" ? route.path : `${mount}${route.path}`;
  const localized = localizedRoutePath({
    locale:
      route.locale === undefined || route.locale === route.defaultLocale
        ? "x-default"
        : route.locale,
    path: mountedPath,
  });
  const base = localized === "" ? "/" : localized;
  if (base === "/" || base.endsWith("/")) return base;
  const lastSegment = base.split("/").pop() ?? "";
  if (lastSegment.includes(".")) return base; // file-like paths stay file-like
  return `${base}/`;
}

/** Only declared public GET views may contribute search/sitemap pages.
 * Sources own entity-level availability and noindex; Core owns route eligibility. */
export function isExtensionPublicPage(
  artifact: {
    readonly manifest: {
      readonly registrations: {
        readonly http_routes: readonly {
          readonly method: string;
          readonly path: string;
          readonly visibility: string;
          readonly view?: string;
        }[];
      };
    };
  },
  path: string,
): boolean {
  if (!path.startsWith("/") || /[?#\\]/.test(path) || path.includes("//")) return false;
  const segments = parseSegments(path);
  if (
    segments.some((segment) => {
      try {
        return (
          [".", ".."].includes(decodeURIComponent(segment)) ||
          /[/\\?#]/.test(decodeURIComponent(segment))
        );
      } catch {
        return true;
      }
    })
  )
    return false;
  for (const route of artifact.manifest.registrations.http_routes) {
    // Respect declaration order: a private/json route can shadow a view.
    if (route.method !== "GET") continue;
    const pattern = parseSegments(route.path);
    if (
      pattern.every(
        (part, index) =>
          part.startsWith("*") ||
          (segments[index] !== undefined && (part.startsWith(":") || part === segments[index])),
      ) &&
      (pattern.at(-1)?.startsWith("*") || pattern.length === segments.length)
    ) {
      return route.visibility === "public" && route.view !== undefined;
    }
  }
  return false;
}

function canonicalJoin(mount: string, rest: string, locale?: string): string {
  return extensionCanonicalPath({
    mountPath: mount,
    extensionId: "",
    path: rest,
    ...(locale === undefined ? {} : { locale }),
  });
}

function parseSegments(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function matchRoute(
  route: CompiledRoute,
  method: string,
  restSegments: readonly string[],
): Record<string, string> | null {
  const httpMethod = method === "HEAD" ? "GET" : method.toUpperCase();
  if (route.method !== httpMethod) return null;
  const params: Record<string, string> = {};
  let index = 0;
  for (; index < route.segments.length; index += 1) {
    const pattern = route.segments[index] as string;
    const actual = restSegments[index];
    if (pattern.startsWith("*")) {
      params[pattern.slice(1) || "rest"] = restSegments.slice(index).join("/");
      return params;
    }
    if (actual === undefined) return null;
    if (pattern.startsWith(":")) params[pattern.slice(1)] = decodeURIComponent(actual);
    else if (pattern !== actual) return null;
  }
  if (index < restSegments.length) return null;
  return params;
}

export function createExtensionHttpRouter(deps: {
  readonly catalog: ExtensionCatalog;
  readonly lifecycle: {
    readonly enabledIds: () => Promise<readonly string[]>;
    readonly revision: () => Promise<string>;
  };
  readonly resolveRuntime: (
    extensionId: string,
  ) => Promise<{ readonly id: string; readonly config: Record<string, unknown> } | null>;
  readonly extensionRoutes: ExtensionRouteService;
}): ExtensionHttpRouter {
  // Public mutation contract (PREPUBLIC §5): per-IP token bucket + durable
  // idempotency replay, both shared per web process.
  const rateLimitMutation = createRateLimiter(
    { now: () => new Date() },
    {
      capacity: 30,
      refillPerSecond: 1,
      exceededCode: "EXTENSION_MUTATION_RATE_LIMITED",
      exceededMessage: "public mutation rate limit exceeded, retry shortly",
    },
  );
  const rateLimitGuestSession = createRateLimiter(
    { now: () => new Date() },
    {
      capacity: 20,
      refillPerSecond: 1,
      exceededCode: "EXTENSION_GUEST_SESSION_RATE_LIMITED",
      exceededMessage: "guest session creation rate limit exceeded, retry shortly",
    },
  );
  let idempotency: ReturnType<typeof createIdempotencyService> | null = null;
  let cache: {
    readonly revision: string;
    readonly routes: readonly CompiledRoute[];
  } | null = null;

  const ensureComposed = async (): Promise<readonly CompiledRoute[]> => {
    const revision = await deps.lifecycle.revision();
    if (cache !== null && cache.revision === revision) return cache.routes;
    const enabled = new Set(await deps.lifecycle.enabledIds());
    const routes: CompiledRoute[] = [];
    for (const artifact of deps.catalog.list()) {
      if (!enabled.has(artifact.manifest.id)) continue;
      for (const route of artifact.manifest.registrations.http_routes) {
        routes.push({
          extensionId: artifact.manifest.id,
          routeId: route.route_id,
          method: route.method,
          segments: parseSegments(route.path),
          visibility: route.visibility,
          permission: route.permission,
          handler: route.handler,
          responseSchema: route.response_schema,
          view: route.view,
        });
      }
    }
    cache = { revision, routes };
    return routes;
  };

  return {
    async dispatch(app, facts, ctx) {
      const rawPath = facts.path.split("?")[0] || "/";
      const path = rawPath !== "/" && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
      const routes = await ensureComposed();
      // NOTE: no early return on empty routes — the technical /x/<id> space
      // must still answer 404 (not fall into site routing) after an R3
      // withdrawal removed every route.

      // Candidate (extensionId, rest) pairs: the technical space first, then
      // the operator-assigned mount (longest prefix wins via ORDER BY).
      const candidates: {
        readonly extensionId: string;
        readonly mount: string;
        readonly rest: string;
      }[] = [];
      const technical = /^\/x\/([A-Za-z0-9.-]+)(\/.*)?$/.exec(path);
      if (technical !== null) {
        const extensionId = technical[1] ?? "";
        const rest = technical[2] ?? "/";
        candidates.push({ extensionId, mount: `/x/${extensionId}`, rest });
      }
      const mounted = await deps.extensionRoutes.resolve(path);
      if (mounted !== null) candidates.push(mounted);

      for (const candidate of candidates) {
        const restSegments = parseSegments(candidate.rest === "" ? "/" : candidate.rest);
        for (const route of routes) {
          if (route.extensionId !== candidate.extensionId) continue;
          const params = matchRoute(route, facts.method, restSegments);
          if (params === null) continue;

          // Canonical URL policy (CORE-SHOP-SEO-01): the technical space
          // never renders public HTML. With an ACTIVE mount — one permanent
          // 308 to the canonical URL; without one — the public technical
          // page does not exist (404).
          if (
            candidate.mount.startsWith("/x/") &&
            route.visibility === "public" &&
            route.view !== undefined &&
            (facts.method === "GET" || facts.method === "HEAD")
          ) {
            const activeMount = await deps.extensionRoutes.activeFor(candidate.extensionId);
            if (activeMount === null) {
              return {
                kind: "failure",
                status: 404,
                code: "EXTENSION_ROUTE_NOT_MOUNTED",
                message: `extension "${candidate.extensionId}" has no site-level mount; the technical space serves no public HTML`,
              };
            }
            return {
              kind: "redirect",
              status: 308,
              location: canonicalJoin(activeMount.mountPath, candidate.rest, facts.locale),
            };
          }

          // ---- public mutation contract (PREPUBLIC §5) -----------------
          const mutating = MUTATING_METHODS.has(facts.method.toUpperCase());
          if (mutating && route.visibility === "public") {
            if (facts.mutation === undefined) {
              return {
                kind: "failure",
                status: 500,
                code: "EXTENSION_MUTATION_FACTS_MISSING",
                message:
                  "transport did not provide mutation facts (host/ip/headers); refusing the mutation",
              };
            }
            try {
              rateLimitMutation(facts.mutation.ip);
            } catch {
              return {
                kind: "failure",
                status: 429,
                code: "EXTENSION_MUTATION_RATE_LIMITED",
                message: "public mutation rate limit exceeded, retry shortly",
              };
            }
            if (!originMatchesHost(facts.mutation)) {
              return {
                kind: "failure",
                status: 403,
                code: "EXTENSION_MUTATION_ORIGIN",
                message: "Origin/Referer does not match the requested host",
              };
            }
          }
          // Only a Core-issued, site-bound HttpOnly cookie establishes a
          // guest principal. Client-provided x-pcms-guest-id is ignored.
          let guestIdentity: Awaited<ReturnType<typeof guestIdentityFrom>> | null = null;
          if (route.visibility === "public" && facts.mutation !== undefined) {
            try {
              guestIdentity = await guestIdentityFrom(app, facts.mutation, rateLimitGuestSession);
            } catch (error) {
              const apiError = error as { code?: string; message?: string };
              if (apiError.code === "EXTENSION_GUEST_SESSION_RATE_LIMITED") {
                return {
                  kind: "failure",
                  status: 429,
                  code: apiError.code,
                  message: apiError.message ?? "guest session creation rate limited",
                };
              }
              throw error;
            }
          }
          if (
            mutating &&
            route.visibility === "public" &&
            guestIdentity?.authenticated === true &&
            facts.mutation?.headers.origin === undefined &&
            facts.mutation?.headers.referer === undefined
          ) {
            return {
              kind: "failure",
              status: 403,
              code: "EXTENSION_MUTATION_ORIGIN",
              message: "Origin or Referer is required for a cookie-authenticated mutation",
            };
          }
          const idempotencyKey =
            mutating && route.visibility === "public"
              ? (facts.mutation?.headers["idempotency-key"] ?? null)
              : null;
          if (idempotencyKey !== null && !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
            return {
              kind: "failure",
              status: 400,
              code: "EXTENSION_IDEMPOTENCY_KEY_INVALID",
              message: "Idempotency-Key must be 8..200 chars of [A-Za-z0-9._:-]",
            };
          }

          // ---- visibility gates ----------------------------------------
          if (route.visibility !== "public") {
            if (ctx === null) {
              return {
                kind: "failure",
                status: 401,
                code: "AUTH_REQUIRED",
                message: `route "${candidate.extensionId}/${route.routeId}" requires an authenticated actor`,
              };
            }
            try {
              requirePermission(app, ctx, route.permission as string);
            } catch (error) {
              const apiError = error as { code?: string; status?: number; message?: string };
              return {
                kind: "failure",
                status: apiError.status ?? 403,
                code: apiError.code ?? "AUTH_PERMISSION_DENIED",
                message: apiError.message ?? "permission denied",
              };
            }
          }

          // ---- execute the handler ------------------------------------
          const artifact = deps.catalog.get(candidate.extensionId);
          if (artifact === undefined) return { kind: "miss" };
          const runtime = await deps
            .resolveRuntime(candidate.extensionId)
            .then((r) => r?.config ?? null);
          const callContext = await buildExtensionCallContext(
            app,
            route.visibility === "public" ? null : ctx,
            { extensionId: candidate.extensionId, config: runtime },
            {
              anonymous: route.visibility === "public",
              guestId: guestIdentity?.id ?? null,
              ...(facts.locale === undefined ? {} : { locale: facts.locale }),
            },
          );
          const activeMount = await deps.extensionRoutes.activeFor(candidate.extensionId);
          const canonicalPath =
            activeMount === null
              ? null
              : extensionCanonicalPath({
                  mountPath: activeMount.mountPath,
                  extensionId: candidate.extensionId,
                  path: candidate.rest,
                  locale: callContext.locale,
                  defaultLocale: callContext.site.defaultLocale,
                });
          const origin =
            app.canonical === undefined
              ? null
              : await app.canonical
                  .primaryOrigin((await app.routes.ensureSite(callContext.site.key)).id)
                  .catch(() => null);
          const canonicalUrl =
            canonicalPath === null || origin === null ? null : `${origin}${canonicalPath}`;
          const handler = resolveHandler(artifact, route.handler);
          const executeHandler = () =>
            Promise.resolve(
              (handler as (call: ExtensionHttpCallContext) => unknown)({
                ...callContext,
                method: facts.method.toUpperCase(),
                params,
                query: facts.query,
                body: facts.body,
                mount: candidate.mount,
                canonicalPath,
                canonicalUrl,
                guestId: guestIdentity?.id ?? null,
                idempotencyKey,
              }),
            );
          let response: unknown;
          try {
            if (idempotencyKey !== null) {
              // Durable anti-replay (PREPUBLIC §5): POSTGRES-backed key+scope
              // dedup — retries and crashes replay the stored response; a
              // different payload under the same key is a 409 conflict. The
              // site transport does not catch ApiError, so idempotency
              // conflicts map to the failure contract here.
              idempotency ??= createIdempotencyService(app.pool);
              try {
                response = (
                  await idempotency.run({
                    operation: `${candidate.extensionId}/${route.routeId}`,
                    key: idempotencyKey,
                    scope: `extmut:${app.defaultSiteKey}:${candidate.extensionId}:${guestIdentity?.id ?? "anonymous"}`,
                    fingerprint: {
                      url: facts.path,
                      locale: facts.locale ?? null,
                      body: facts.body ?? null,
                    },
                    run: executeHandler,
                  })
                ).result;
              } catch (error) {
                const apiError = error as { code?: string; status?: number; message?: string };
                if (
                  apiError.code === "IDEMPOTENCY_KEY_CONFLICT" ||
                  apiError.code === "IDEMPOTENCY_IN_PROGRESS"
                ) {
                  return {
                    kind: "failure",
                    status: apiError.status ?? 409,
                    code: apiError.code,
                    message: apiError.message ?? "idempotency conflict",
                  };
                }
                throw error;
              }
            } else {
              response = await executeHandler();
            }
          } catch (error) {
            const apiError = error as { code?: string; status?: number; message?: string };
            return {
              kind: "failure",
              status: apiError.status ?? 500,
              code: apiError.code ?? "EXTENSION_ROUTE_HANDLER_FAILED",
              message: apiError.message ?? "extension route handler failed",
            };
          }

          // ---- response contract --------------------------------------
          const shape = (response ?? {}) as {
            status?: number;
            view?: {
              id?: string;
              model?: unknown;
              head?: ExtensionViewResponse["head"];
              media_ids?: readonly string[];
            };
            json?: unknown;
            location?: string;
          };
          if (shape.view !== undefined) {
            const viewId = typeof shape.view.id === "string" ? shape.view.id : "";
            const registered = artifact.manifest.registrations.views.find(
              (candidateView) => candidateView.view_id === viewId,
            );
            if (registered === undefined) {
              return {
                kind: "failure",
                status: 500,
                code: "EXTENSION_VIEW_UNKNOWN",
                message: `view "${viewId}" is not registered by "${candidate.extensionId}"`,
              };
            }
            if (route.view !== undefined && route.view !== viewId) {
              return {
                kind: "failure",
                status: 500,
                code: "EXTENSION_VIEW_MISMATCH",
                message: `route declares view "${route.view}" but the handler returned "${viewId}"`,
              };
            }
            return {
              kind: "view",
              ...(guestIdentity?.setCookie === undefined
                ? {}
                : { setCookie: guestIdentity.setCookie }),
              extensionId: candidate.extensionId,
              response: {
                view_id: `${candidate.extensionId}/${viewId}`,
                model: shape.view.model ?? {},
                head: shape.view.head ?? {},
                media_ids: shape.view.media_ids ?? [],
              },
              view: {
                baseTemplate: registered.base_template,
                schemaVersion: registered.view_model_schema_version,
                extensionsDir: artifact.extensionsDir ?? `extensions/${candidate.extensionId}`,
                canonicalPath:
                  canonicalPath ?? canonicalJoin(candidate.mount, candidate.rest, facts.locale),
                canonicalUrl,
                locale: callContext.locale,
              },
            };
          }
          if (typeof shape.location === "string") {
            return {
              kind: "redirect",
              status: shape.status === 301 ? 301 : 302,
              location: shape.location,
              ...(guestIdentity?.setCookie === undefined
                ? {}
                : { setCookie: guestIdentity.setCookie }),
            };
          }
          const status = typeof shape.status === "number" ? shape.status : 200;
          if (route.responseSchema !== undefined) {
            const { default: Ajv } = await import("ajv");
            const validate = new Ajv({ allErrors: false }).compile(route.responseSchema);
            if (!validate(shape.json)) {
              return {
                kind: "failure",
                status: 500,
                code: "EXTENSION_ROUTE_INVALID_RESPONSE",
                message: `route "${candidate.extensionId}/${route.routeId}" returned output failing its response schema`,
              };
            }
          }
          return {
            kind: "json",
            status,
            body: shape.json ?? null,
            ...(guestIdentity?.setCookie === undefined
              ? {}
              : { setCookie: guestIdentity.setCookie }),
          };
        }
      }
      // A technical-space path for an unknown/disabled extension is a 404,
      // never a fall-through into site routing.
      if (technical !== null) {
        return {
          kind: "failure",
          status: 404,
          code: "EXTENSION_ROUTE_NOT_FOUND",
          message: `extension "${technical[1]}" has no matching route`,
        };
      }
      return { kind: "miss" };
    },
  };
}
