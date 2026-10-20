// Site localization (multilingual) REST surface. Reads/writes gate on
// site.configure (Settings screen); enabling is theme-capability-validated
// and audited server-side in localization-ops.ts.
import type { FastifyRequest } from "fastify";
import type { ApplicationServices, OperationContext } from "../../context.js";
import { ApiError } from "../../errors.js";
import {
  addTranslationOp,
  getSiteLocalizationOp,
  updateSiteLocalizationOp,
} from "../../localization-ops.js";
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

const UPDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "default_locale", "locales"],
  properties: {
    enabled: { type: "boolean" },
    default_locale: { type: "string", minLength: 2, maxLength: 35 },
    locales: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: { type: "string", minLength: 2, maxLength: 35 },
    },
  },
} as const;

const TRANSLATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["locale"],
  properties: {
    locale: { type: "string", minLength: 2, maxLength: 35 },
    copy_from_source: { type: "boolean" },
  },
} as const;

export function makeLocalizationRoutes(): ApiRoute[] {
  const routes: ApiRoute[] = [
    {
      spec: {
        method: "GET",
        url: "/localization",
        operationId: "get_site_localization",
        summary: "Site localization state: enabled locales, default, routing strategy.",
        tag: "discovery",
        auth: "authenticated",
        permission: "site.configure",
      },
      handle: (app, ctx) => handle(app, ctx, () => getSiteLocalizationOp(app, ctx)),
    },
    {
      spec: {
        method: "PUT",
        url: "/localization",
        operationId: "update_site_localization",
        summary:
          "Enable/disable multilingual and edit the locale list (audited; theme capability validated on enable).",
        tag: "discovery",
        auth: "authenticated",
        csrf: true,
        permission: "site.configure",
        bodySchema: UPDATE_SCHEMA,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () => updateSiteLocalizationOp(app, ctx, jsonBody(request) as never)),
    },
    {
      spec: {
        method: "POST",
        url: "/entries/:entryId/translations",
        operationId: "add_entry_translation",
        summary: "Create the translation of an entry in a target locale (entry + first draft).",
        tag: "content",
        auth: "authenticated",
        csrf: true,
        permission: "content.create",
        bodySchema: TRANSLATION_SCHEMA,
      },
      handle: (app, ctx, request) => {
        const params = request.params as { entryId?: unknown };
        const entryId = typeof params.entryId === "string" ? params.entryId : "";
        return handle(app, ctx, () =>
          addTranslationOp(app, ctx, entryId, jsonBody(request) as never),
        );
      },
    },
  ];
  return routes;
}
