// OpenAPI 3.1 generation from the route registry (PCMS-API-T003; spec §4).
// The document is a deterministic release artifact: operations are emitted in
// sorted order and the JSON is canonicalized (sorted keys) so the snapshot
// diff gate (T026) compares bytes, not vibes.
import type { ApiRoute } from "./registry.js";
import { paramNames } from "./registry.js";

export const OPENAPI_VERSION = "3.1.0";
export const API_CONTRACT_VERSION = "1.0.0";

/** Recursively key-sorted JSON stringify — deterministic contract output. */
export function stableStringify(value: unknown): string {
  const encoder = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(encoder);
    if (current !== null && typeof current === "object") {
      const entries = Object.entries(current as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries.map(([k, v]) => [k, encoder(v)]));
    }
    return current;
  };
  return `${JSON.stringify(encoder(value), null, 2)}\n`;
}

const ERROR_ENVELOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "request_id", "details", "retryable"],
      properties: {
        code: { type: "string", description: "Stable application error code" },
        message: { type: "string" },
        request_id: { type: "string" },
        details: { type: "array", items: {} },
        retryable: { type: "boolean" },
      },
    },
  },
};

const PAGE_ENVELOPE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["items", "has_more"],
  properties: {
    items: { type: "array", items: {} },
    next_cursor: { type: "string", nullable: true },
    has_more: { type: "boolean" },
  },
};

function fastifyPathToOpenApi(url: string): { path: string; parameters: unknown[] } {
  const names = paramNames(url);
  const path = url.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
  const parameters = names.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  return { path, parameters };
}

function operationFor(route: ApiRoute): Record<string, unknown> {
  const { spec } = route;
  const successResponse: Record<string, unknown> = { description: "Success" };
  if (spec.responseSchema !== undefined) {
    successResponse.content = { "application/json": { schema: spec.responseSchema } };
  }
  const operation: Record<string, unknown> = {
    operationId: spec.operationId,
    summary: spec.summary,
    tags: [spec.tag],
    responses: {
      [String(spec.successStatus ?? 200)]: successResponse,
      "400": errorResponse("Invalid request syntax (request schema)"),
      "401": errorResponse("Unauthenticated"),
      "403": errorResponse("Authenticated but forbidden"),
      "404": errorResponse("Not found or not visible"),
      "409": errorResponse("State conflict / CAS / collision"),
      "413": errorResponse("Payload too large"),
      "422": errorResponse("Semantic validation failed"),
      "429": errorResponse("Throttled"),
      "500": errorResponse("Unexpected internal error"),
    },
  };
  const { parameters } = fastifyPathToOpenApi(spec.url);
  if (parameters.length > 0) operation.parameters = parameters;
  if (spec.querySchema !== undefined) {
    const pathParameters = (operation.parameters as unknown[] | undefined) ?? [];
    operation.parameters = [...pathParameters, ...queryStringParameters(spec.querySchema)];
  }
  if (spec.bodySchema !== undefined) {
    operation.requestBody = {
      required: true,
      content: { "application/json": { schema: spec.bodySchema } },
    };
  }
  if (spec.auth === "authenticated") {
    operation.security =
      spec.csrf === true
        ? [{ cookieAuth: [] }, { bearerAuth: [] }]
        : [{ bearerAuth: [] }, { cookieAuth: [] }];
  }
  // The enforced permission key is part of the machine contract: clients gate
  // UI affordances on it instead of probing endpoints.
  if (spec.permission !== undefined) operation["x-permission"] = spec.permission;
  if (spec.idempotency !== undefined) {
    operation.description =
      `Supports the durable Idempotency-Key header (${spec.idempotency}); ` +
      (spec.idempotency === "required"
        ? "requests without a key are rejected."
        : "replays of a key return the stored result.");
  }
  return operation;
}

function queryStringParameters(schema: Record<string, unknown>): unknown[] {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = (schema.required ?? []) as readonly string[];
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: "query",
    required: required.includes(name),
    schema: property,
  }));
}

function errorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } },
  };
}

export interface OpenApiOptions {
  readonly title?: string;
  /** Running CMS build (from build metadata) — agents must be able to tell
   * which build a contract belongs to (spangar frictions report P3-7). */
  readonly cmsVersion?: string;
}

/** Builds the complete OpenAPI 3.1 document for the registered routes. */
export function buildOpenApiDocument(routes: readonly ApiRoute[], options: OpenApiOptions = {}) {
  const paths: Record<string, Record<string, unknown>> = {};
  const sorted = [...routes].sort((a, b) =>
    a.spec.url === b.spec.url
      ? a.spec.method.localeCompare(b.spec.method)
      : a.spec.url.localeCompare(b.spec.url),
  );
  for (const route of sorted) {
    const { path } = fastifyPathToOpenApi(route.spec.url);
    const item = paths[path] ?? {};
    item[route.spec.method.toLowerCase()] = operationFor(route);
    paths[path] = item;
  }
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: options.title ?? "Progressive CMS API",
      version: options.cmsVersion ?? API_CONTRACT_VERSION,
      description:
        "Machine contract of the Progressive CMS application layer (API/MCP/CLI spec v1). " +
        "Errors share one envelope; stable codes are the identity, HTTP status the hint.",
    },
    servers: [{ url: "/api/v1" }],
    tags: [
      { name: "server" },
      { name: "auth" },
      { name: "actor" },
      { name: "discovery" },
      { name: "content" },
      { name: "media" },
      { name: "publication" },
      { name: "themes" },
      { name: "search" },
      { name: "forms" },
      { name: "interactions" },
      { name: "extensions" },
      { name: "bundle" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Service-account access token (M08 resolver; scopes, site/env bound).",
        },
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-pcms_session",
          description:
            "Browser session cookie (Secure/HttpOnly/SameSite=Lax/Path=/). Mutations additionally " +
            "require the X-PCMS-CSRF header issued at login.",
        },
      },
      schemas: {
        ErrorEnvelope: ERROR_ENVELOPE_SCHEMA,
        Page: PAGE_ENVELOPE_SCHEMA,
      },
    },
    paths,
  };
}
