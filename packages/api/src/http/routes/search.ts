// Search REST operations (PCMS-SEARCH-T015/T016/T017; Search spec §23–§26).
//
// Public query is unauthenticated and rate-bounded (spec §23); admin
// operations ride the shared permission model. All semantics live in the
// application layer — this file is transport only.
import { SEARCH_INDEX_VERSION, SearchError } from "@pcms/search";
import type { ApplicationServices } from "../../context.js";
import type { ApiRoute } from "../registry.js";
import { optionalString } from "./helpers.js";

/**
 * In-process token bucket per client key (spec §23: public endpoint is
 * rate-limited). ponytail: single web process in v1 — per-IP buckets with a
 * bounded map; a multi-node deployment moves this to the shared store.
 */
const RATE_BUCKET_CAPACITY = 10;
const RATE_REFILL_PER_SECOND = 2;
const RATE_BUCKETS_MAX = 10_000;

interface RateBucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiterOptions {
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly exceededCode: string;
  readonly exceededMessage: string;
}

export function createRateLimiter(clock: { now(): Date }, options?: Partial<RateLimiterOptions>) {
  const capacity = options?.capacity ?? RATE_BUCKET_CAPACITY;
  const refillPerSecond = options?.refillPerSecond ?? RATE_REFILL_PER_SECOND;
  const exceededCode = options?.exceededCode ?? "SEARCH_RATE_LIMITED";
  const exceededMessage = options?.exceededMessage ?? "search rate limit exceeded, retry shortly";
  const buckets = new Map<string, RateBucket>();
  return (key: string): void => {
    if (buckets.size > RATE_BUCKETS_MAX) buckets.clear(); // abuse/rotation bound
    const now = clock.now().getTime();
    const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      throw new SearchError(exceededCode as never, exceededMessage);
    }
    bucket.tokens -= 1;
    buckets.set(key, bucket);
  };
}

const SEARCH_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    q: { type: "string", maxLength: 256 },
    site: { type: "string", maxLength: 64 },
    locale: { type: "string", maxLength: 16 },
    content_type: { type: "string", maxLength: 64 },
    date_from: { type: "string", maxLength: 32 },
    date_to: { type: "string", maxLength: 32 },
    sort: { type: "string", maxLength: 16 },
    limit: { type: "string", pattern: "^[0-9]+$" },
    cursor: { type: "string", maxLength: 64 },
  },
  required: ["q"],
} as const;

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function stringParam(query: Record<string, unknown>, key: string): Record<string, string> {
  const value = optionalString(query[key]);
  return value === undefined ? {} : { [key]: value };
}

function numberParam(query: Record<string, unknown>, key: string): Record<string, number> {
  const value = numberOrUndefined(query[key]);
  return value === undefined ? {} : { [key]: value };
}

export function makeSearchRoutes(): ApiRoute[] {
  const rateLimit = createRateLimiter({ now: () => new Date() });
  return [
    {
      spec: {
        method: "GET",
        url: "/search",
        operationId: "search_query",
        summary: "Bounded public site search (PostgreSQL full-text, spec §23)",
        tag: "search",
        auth: "public",
        querySchema: SEARCH_QUERY_SCHEMA,
      },
      async handle(app, _ctx, request) {
        const query = request.query as Record<string, unknown>;
        // The bucket key is the transport-resolved peer (trustProxy-aware).
        // Raw X-Forwarded-For is client-controlled: keying on its first hop
        // let any caller rotate fresh rate-limit buckets at will (and direct
        // clients shared one "local" bucket).
        rateLimit(request.ip);
        return {
          status: 200,
          body: await app.searchQuery({
            q: String(query.q ?? ""),
            locale: String(query.locale ?? "default"),
            ...stringParam(query, "site"),
            ...stringParam(query, "content_type"),
            ...stringParam(query, "date_from"),
            ...stringParam(query, "date_to"),
            ...stringParam(query, "sort"),
            ...numberParam(query, "limit"),
            ...stringParam(query, "cursor"),
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/search/admin",
        operationId: "search_admin",
        summary: "Authorized admin search across published, drafts, media, navigation (§24)",
        tag: "search",
        auth: "authenticated",
        permission: "search.admin",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            q: { type: "string", maxLength: 256 },
            site: { type: "string", maxLength: 64 },
            locale: { type: "string", maxLength: 16 },
            limit: { type: "string", pattern: "^[0-9]+$" },
          },
          required: ["q", "locale"],
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "search.admin");
        const query = request.query as Record<string, unknown>;
        const result = await app.searchAdmin({
          q: String(query.q ?? ""),
          locale: String(query.locale ?? "default"),
          ...stringParam(query, "site"),
          ...numberParam(query, "limit"),
        });
        return { status: 200, body: result };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/search/status",
        operationId: "get_search_status",
        summary: "Search index health, version and reindex progress (§26/§31)",
        tag: "search",
        auth: "authenticated",
        permission: "search.diagnostics",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "search.diagnostics");
        return { status: 200, body: await searchStatus(app) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/search/reindex",
        operationId: "reindex_search",
        summary: "Start or resume a full shadow-epoch reindex (§19/§20)",
        tag: "search",
        auth: "authenticated",
        permission: "search.reindex",
        idempotency: "supported",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: { resume: { type: "boolean" } },
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "search.reindex");
        const body = (request.body ?? {}) as { resume?: boolean };
        const run = await app.searchReindex.start({ resume: body.resume === true });
        return {
          status: 202,
          body: {
            run_id: run.runId,
            epoch: run.epoch,
            total_documents: run.totalDocuments,
            chunks_total: run.chunksTotal,
            resumed: run.resumed,
          },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/search/reindex",
        operationId: "list_search_reindex_runs",
        summary: "Reindex run history and progress (§26)",
        tag: "search",
        auth: "authenticated",
        permission: "search.diagnostics",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "search.diagnostics");
        return { status: 200, body: { runs: await app.searchReindex.listRuns() } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/search/capabilities",
        operationId: "get_search_capabilities",
        summary: "Machine-readable search capabilities (entity types, filters, sorts, limits)",
        tag: "search",
        auth: "authenticated",
      },
      async handle() {
        return { status: 200, body: searchCapabilities() };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/search/validate-document",
        operationId: "validate_search_document",
        summary: "Re-derive and validate one entity's search document (§31)",
        tag: "search",
        auth: "authenticated",
        permission: "search.admin",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            entity_type: { type: "string", maxLength: 64 },
            entity_id: { type: "string", maxLength: 64 },
          },
          required: ["entity_type", "entity_id"],
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "search.admin");
        const body = (request.body ?? {}) as { entity_type?: string; entity_id?: string };
        const entityType = typeof body.entity_type === "string" ? body.entity_type : "";
        const entityId = typeof body.entity_id === "string" ? body.entity_id : "";
        const document = await app.searchSource.buildDocument(entityType, entityId);
        if (document === null) {
          return {
            status: 200,
            body: { entity_type: entityType, entity_id: entityId, indexable: false, issues: [] },
          };
        }
        const { validateSearchDocument } = await import("@pcms/search");
        return {
          status: 200,
          body: {
            entity_type: entityType,
            entity_id: entityId,
            indexable: true,
            issues: validateSearchDocument(document),
          },
        };
      },
    },
  ];
}

/** Search status payload shared by REST/MCP/CLI (T014/T016). */
export async function searchStatus(app: ApplicationServices): Promise<{
  readonly health: Awaited<ReturnType<ApplicationServices["searchProvider"]["health"]>>;
  readonly reindex_runs: readonly unknown[];
}> {
  const health = await app.searchProvider.health();
  return { health, reindex_runs: await app.searchReindex.listRuns() };
}

/** Machine-readable discovery payload (Search spec §17/§30). */
export function searchCapabilities() {
  return {
    engine: "postgresql-fts",
    entity_types: ["entry"],
    filters: ["content_type", "date_from", "date_to"],
    sorts: ["relevance", "date"],
    locales: ["ru", "en", "simple-fallback"],
    limits: {
      query_length: 256,
      page_size: 50,
      result_window: 500,
      filters: 4,
      default_page_size: 20,
    },
    index_version: SEARCH_INDEX_VERSION,
  };
}
