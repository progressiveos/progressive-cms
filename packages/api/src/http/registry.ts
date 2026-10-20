// REST route registry (PCMS-API-T003). One declarative table drives BOTH the
// Fastify registration and the OpenAPI 3.1 document — documented and served
// behavior cannot drift (spec §4 "OpenAPI is contract, not decoration").
import type { FastifyRequest } from "fastify";
import type { ApplicationServices, OperationContext } from "../context.js";

export interface RouteSpec {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Fastify path, e.g. "/entries/:entryId" (colons converted at mount). */
  readonly url: string;
  /** Stable operation name; intentionally traceable to the application op. */
  readonly operationId: string;
  readonly summary: string;
  readonly tag:
    | "server"
    | "auth"
    | "actor"
    | "discovery"
    | "content"
    | "media"
    | "publication"
    | "themes"
    | "search"
    | "forms"
    | "interactions"
    | "integrations"
    | "payments"
    | "extensions"
    | "bundle";
  /** "public" endpoints are the documented anonymous allowlist (spec §135). */
  readonly auth: "public" | "authenticated";
  /**
   * CSRF synchronizer override (spec §17). Session-authenticated mutations
   * REQUIRE the X-PCMS-CSRF token by default (see requiresCsrf); `false`
   * opts out — a conscious decision reserved for bearer-only surfaces
   * (machine callers carry no session to protect).
   */
  readonly csrf?: boolean;
  /** Permission key documented for this operation (enforced inside the op). */
  readonly permission?: string;
  /** Mutation accepts the durable Idempotency-Key contract (spec §10). */
  readonly idempotency?: "required" | "supported";
  /** Per-route body cap override (uploads); default is the JSON limit. */
  readonly bodyLimit?: number;
  readonly bodySchema?: Record<string, unknown>;
  readonly querySchema?: Record<string, unknown>;
  readonly paramsSchema?: Record<string, unknown>;
  readonly responseSchema?: Record<string, unknown>;
}

export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type RouteHandler = (
  app: ApplicationServices,
  ctx: OperationContext,
  request: FastifyRequest,
) => Promise<RouteResult>;

export interface ApiRoute {
  readonly spec: RouteSpec;
  readonly handle: RouteHandler;
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function isMutating(spec: RouteSpec): boolean {
  return MUTATING.has(spec.method);
}

/**
 * True when the route must present the CSRF synchronizer token. Default-on
 * (spec §17): every session-authenticated mutating route requires the token —
 * the synchronizer is mandatory for all session mutations, not only routes
 * that remember to declare it. The Admin SPA sends X-PCMS-CSRF globally and
 * bearer requests are machine semantics (exempt in auth.ts), so `csrf: false`
 * is the only opt-out: a deliberate, reviewable decision for bearer-only
 * surfaces.
 */
export function requiresCsrf(spec: RouteSpec): boolean {
  return spec.auth === "authenticated" && spec.csrf !== false && isMutating(spec);
}

export function paramNames(url: string): readonly string[] {
  return [...url.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}
