// Maintenance Mode REST surface (PCMS-OPS-T118; task brief §30–§33). Reads
// and writes gate on site.maintenance; mutations are audited server-side in
// maintenance-ops.ts. The Admin screen and the `cms maintenance` CLI family
// consume exactly these operations.
import type { FastifyRequest } from "fastify";
import type { ApplicationServices, OperationContext } from "../../context.js";
import { ApiError } from "../../errors.js";
import { getMaintenanceStateOp, updateMaintenanceStateOp } from "../../maintenance-ops.js";
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
  properties: {
    enabled: { type: "boolean" },
    title: { type: "string", minLength: 1, maxLength: 200 },
    message: { type: "string", minLength: 1, maxLength: 4000 },
    promoLabel: { type: "string", minLength: 1, maxLength: 200 },
    promoUrl: { type: "string", maxLength: 500 },
    retryAfterSeconds: { type: "integer", minimum: 60, maximum: 86400 },
  },
} as const;

export function makeMaintenanceRoutes(): ApiRoute[] {
  const routes: ApiRoute[] = [
    {
      spec: {
        method: "GET",
        url: "/maintenance",
        operationId: "get_maintenance_state",
        summary: "Maintenance Mode state and public page settings (site.maintenance).",
        tag: "discovery",
        auth: "authenticated",
        permission: "site.maintenance",
      },
      handle: (app, ctx) => handle(app, ctx, () => getMaintenanceStateOp(app, ctx)),
    },
    {
      spec: {
        method: "PUT",
        url: "/maintenance",
        operationId: "update_maintenance_state",
        summary: "Toggle maintenance mode or edit its public page settings (audited).",
        tag: "discovery",
        auth: "authenticated",
        csrf: true,
        permission: "site.maintenance",
        bodySchema: UPDATE_SCHEMA,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          updateMaintenanceStateOp(
            app,
            ctx,
            jsonBody(request) as {
              enabled?: boolean;
              title?: string;
              message?: string;
              promoLabel?: string;
              promoUrl?: string;
              retryAfterSeconds?: number;
            },
          ),
        ),
    },
  ];
  return routes;
}
