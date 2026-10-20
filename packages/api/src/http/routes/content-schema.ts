// Content schema management REST surface (2026-09-29, "schemas via API").
// The propose/apply permissions existed since the registry landed but no
// route exercised them — remote developers had to edit the deployment's
// content-types.json over SSH. Validate is effect-free; apply persists
// additive-only overrides and says plainly that a restart is required.
import type { FastifyRequest } from "fastify";
import {
  applyContentSchemaOp,
  listContentTypeOverridesOp,
  validateContentSchemaOp,
} from "../../content-schema-ops.js";
import type { ApplicationServices, OperationContext } from "../../context.js";
import { ApiError } from "../../errors.js";
import type { ApiRoute, RouteResult } from "../registry.js";

function jsonBody(request: FastifyRequest): Record<string, unknown> {
  if (typeof request.body !== "object" || request.body === null) {
    throw new ApiError("API_REQUEST_INVALID", "a JSON object body is required", { status: 400 });
  }
  return request.body as Record<string, unknown>;
}

async function handle(
  app: ApplicationServices,
  ctx: OperationContext,
  fn: (app: ApplicationServices, ctx: OperationContext) => Promise<unknown>,
): Promise<RouteResult> {
  return { status: 200, body: await fn(app, ctx) };
}

// Definitions arrive in either real-world shape: a bare array (the
// deployment typesFile format) or the {contentTypes:[…]} tooling wrapper.
// Structure itself is parsed by parseDefinitionsInput — the schema only
// bounds the envelope.
const DEFINITIONS_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["definitions"],
  properties: {
    definitions: {
      anyOf: [
        { type: "array", maxItems: 256 },
        {
          type: "object",
          additionalProperties: true,
          required: ["contentTypes"],
          properties: { contentTypes: { type: "array", maxItems: 256 } },
        },
      ],
    },
  },
} as const;

export function makeContentSchemaRoutes(): ApiRoute[] {
  return [
    {
      spec: {
        method: "GET",
        url: "/content/schema/overrides",
        operationId: "list_content_schema_overrides",
        summary:
          "Schema overrides persisted over the deployment typesFile (what a previous apply changed).",
        tag: "content",
        auth: "authenticated",
        permission: "content_schema.read",
      },
      handle: (app, ctx) => handle(app, ctx, () => listContentTypeOverridesOp(app, ctx)),
    },
    {
      spec: {
        method: "POST",
        url: "/content/schema/validate",
        operationId: "validate_content_schema",
        summary:
          "Validate content type definitions against the effective set: registration probe + additive-change report, no effects.",
        tag: "content",
        auth: "authenticated",
        permission: "content_schema.propose",
        bodySchema: DEFINITIONS_BODY,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          validateContentSchemaOp(app, ctx, { definitions: jsonBody(request).definitions }),
        ),
    },
    {
      spec: {
        method: "POST",
        url: "/content/schema/apply",
        operationId: "apply_content_schema",
        summary:
          "Apply additive-only content type changes (new types, new optional fields). Audited; response reports affected entries and restart_required.",
        tag: "content",
        auth: "authenticated",
        csrf: true,
        permission: "content_schema.apply",
        bodySchema: DEFINITIONS_BODY,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          applyContentSchemaOp(app, ctx, { definitions: jsonBody(request).definitions }),
        ),
    },
  ];
}
