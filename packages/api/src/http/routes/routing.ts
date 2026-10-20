// Redirect-import REST surface (site migrations; Navigation spec §33/§60).
// Both endpoints are POST + authenticated + permission-gated; validate is a
// pure dry-run report, apply is atomic (any error aborts the batch).

import type { ApplicationServices, OperationContext } from "../../context.js";
import { ApiError } from "../../errors.js";
import { applyRedirectImportOp, validateRedirectImportOp } from "../../redirect-import-ops.js";
import type { ApiRoute } from "../registry.js";

const IMPORT_ROW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["source"],
  properties: {
    source: { type: "string", minLength: 1, maxLength: 500 },
    target: { type: ["string", "null"], maxLength: 500 },
    status_code: { type: "integer", enum: [301, 302, 307, 308, 410] },
    reason: { type: "string", maxLength: 200 },
  },
} as const;

const IMPORT_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: {
    site: { type: "string", minLength: 1, maxLength: 100 },
    rows: { type: "array", minItems: 1, maxItems: 10000, items: IMPORT_ROW_SCHEMA },
  },
} as const;

function bodyOf(request: { body: unknown }): { site?: string; rows: never[] } {
  if (typeof request.body !== "object" || request.body === null) {
    throw new ApiError("API_REQUEST_INVALID", "a JSON object body is required", { status: 400 });
  }
  return request.body as { site?: string; rows: never[] };
}

export function makeRoutingRoutes(): ApiRoute[] {
  return [
    {
      spec: {
        method: "POST",
        url: "/routing/redirect-imports/validate",
        operationId: "validate_redirect_import",
        summary:
          "Dry-run a legacy-URL redirect batch: per-row report + redirect-graph issues; writes nothing (routing.redirects.import)",
        tag: "discovery",
        auth: "authenticated",
        permission: "routing.redirects.import",
        csrf: true,
        bodySchema: IMPORT_BODY_SCHEMA,
      },
      async handle(app: ApplicationServices, ctx: OperationContext, request) {
        return {
          status: 200,
          body: await validateRedirectImportOp(app, ctx, bodyOf(request)),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/routing/redirect-imports/apply",
        operationId: "apply_redirect_import",
        summary:
          "Validate and apply a legacy-URL redirect batch atomically: any row or graph error aborts the whole import (routing.redirects.import)",
        tag: "discovery",
        auth: "authenticated",
        permission: "routing.redirects.import",
        csrf: true,
        bodySchema: IMPORT_BODY_SCHEMA,
      },
      async handle(app: ApplicationServices, ctx: OperationContext, request) {
        return {
          status: 200,
          body: await applyRedirectImportOp(app, ctx, bodyOf(request)),
        };
      },
    },
  ];
}
