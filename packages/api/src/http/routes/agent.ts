// Agent REST surface (M16; task brief §20/§39). The bootstrap read requires
// no permission beyond authentication — it reports the CALLING actor's own
// effective permissions and the server's public contract versions, never
// secrets. External-identity surfaces gate on content permissions (their
// ops call requirePermission). MCP/CLI mirror the same operations.
import type { FastifyRequest } from "fastify";
import { getAgentBootstrapOp } from "../../agent-bootstrap-ops.js";
import type { ApplicationServices, OperationContext } from "../../context.js";
import { bindExternalIdentityOp, resolveExternalIdentityOp } from "../../entry-identity-ops.js";
import { ApiError } from "../../errors.js";
import type { ApiRoute, RouteResult } from "../registry.js";
import { jsonBody } from "./helpers.js";

function pathParams(request: FastifyRequest): { namespace: string; externalId: string } {
  const params = request.params as Record<string, unknown>;
  const namespace = params.namespace;
  const externalId = params.externalId;
  if (typeof namespace !== "string" || namespace === "" || namespace.length > 200) {
    throw new ApiError("API_REQUEST_INVALID", "source_namespace path parameter is required", {
      status: 400,
    });
  }
  if (typeof externalId !== "string" || externalId === "" || externalId.length > 500) {
    throw new ApiError("API_REQUEST_INVALID", "external_id path parameter is required", {
      status: 400,
    });
  }
  return { namespace, externalId };
}

const BIND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["entry_id"],
  properties: {
    entry_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
    source_hash: { type: "string", minLength: 1, maxLength: 256 },
    last_agent_generation: { type: "integer", minimum: 0 },
    run_id: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

export function makeAgentRoutes(): ApiRoute[] {
  const routes: ApiRoute[] = [
    {
      spec: {
        method: "GET",
        url: "/agent/bootstrap",
        operationId: "get_agent_bootstrap",
        summary:
          "Agent bootstrap: site, environment, actor/scopes, contracts, capabilities, installed skills, preview/domain readiness.",
        tag: "discovery",
        auth: "authenticated",
      },
      handle: async (app: ApplicationServices, ctx: OperationContext): Promise<RouteResult> => ({
        status: 200,
        body: await getAgentBootstrapOp(app, ctx),
      }),
    },
    {
      spec: {
        method: "GET",
        url: "/external-identities/:namespace/:externalId",
        operationId: "resolve_external_identity",
        summary:
          "Resolve an external source item to its bound entry, with the human-edit reconciliation verdict (content.read).",
        tag: "discovery",
        auth: "authenticated",
        permission: "content.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            source_hash: { type: "string", maxLength: 256 },
          },
        },
      },
      handle: async (app, ctx, request): Promise<RouteResult> => {
        const { namespace, externalId } = pathParams(request);
        const query = (request.query ?? {}) as Record<string, unknown>;
        const body = await resolveExternalIdentityOp(app, ctx, namespace, externalId, {
          ...(typeof query.source_hash === "string" ? { sourceHash: query.source_hash } : {}),
        });
        return { status: 200, body };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/external-identities/:namespace/:externalId",
        operationId: "bind_external_identity",
        summary:
          "Bind an external source item to an entry and/or refresh the agent sync baseline (content.edit).",
        tag: "discovery",
        auth: "authenticated",
        permission: "content.edit",
        bodySchema: BIND_SCHEMA,
      },
      handle: async (app, ctx, request): Promise<RouteResult> => {
        const { namespace, externalId } = pathParams(request);
        const input = jsonBody(request) as {
          entry_id: string;
          source_hash?: string;
          last_agent_generation?: number;
          run_id?: string;
        };
        const body = await bindExternalIdentityOp(app, ctx, namespace, externalId, input);
        return { status: 200, body };
      },
    },
  ];
  return routes;
}
