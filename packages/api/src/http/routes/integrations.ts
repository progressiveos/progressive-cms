// Integrations REST operations (PCMS-INT-T016; Integrations spec §43).
// Transport only: every handler delegates to integrations-ops.ts, which
// owns authorization and audit. The inbound receiver is the documented
// anonymous allowlist entry point — authentication is the connector's
// per-endpoint verifier, persistence/dedup is the InboundEvent service.
import type { FastifyRequest } from "fastify";
import type { ApplicationServices, OperationContext } from "../../context.js";
import { ApiError } from "../../errors.js";
import {
  cancelIntegrationDelivery,
  clearIntegrationInstanceSecret,
  createIntegrationBinding,
  createIntegrationInstance,
  getConnectorSchema,
  getIntegrationDelivery,
  integrationDeliveryStats,
  listConnectors,
  listInboundEvents,
  listIntegrationBindings,
  listIntegrationDeliveries,
  listIntegrationInstances,
  retryIntegrationDelivery,
  setIntegrationInstanceSecret,
  testIntegrationInstance,
  updateIntegrationBinding,
  updateIntegrationInstance,
} from "../../integrations-ops.js";
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
  fn: (app: ApplicationServices, ctx: OperationContext) => Promise<unknown> | unknown,
): Promise<RouteResult> {
  return { status: 200, body: await fn(app, ctx) };
}

const ID_PARAM = {
  type: "object",
  additionalProperties: false,
  properties: { instanceId: { type: "string", pattern: "^[0-9a-f-]{36}$" } },
  required: ["instanceId"],
} as const;

const BINDING_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    event_type: { type: "string", maxLength: 100 },
    source_filter: { type: ["string", "null"], maxLength: 100 },
    conditions: { type: "array", maxItems: 16 },
    actions: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          instance_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
          action_type: { type: "string", maxLength: 60 },
          payload_mapping: { type: "object" },
        },
        required: ["instance_id", "action_type", "payload_mapping"],
      },
    },
    enabled: { type: "boolean" },
    failure_policy: {
      type: "object",
      additionalProperties: false,
      properties: {
        max_attempts: { type: "integer", minimum: 1, maximum: 10 },
        backoff_base_ms: { type: "integer", minimum: 1000, maximum: 3600000 },
      },
    },
  },
  required: ["event_type", "actions"],
} as const;

function bindingFromWire(body: Record<string, unknown>): Record<string, unknown> {
  const actions = (body["actions"] as readonly Record<string, unknown>[] | undefined) ?? [];
  return {
    eventType: body["event_type"],
    ...(body["source_filter"] === undefined ? {} : { sourceFilter: body["source_filter"] }),
    ...(body["conditions"] === undefined ? {} : { conditions: body["conditions"] }),
    actions: actions.map((action) => ({
      instanceId: action["instance_id"],
      actionType: action["action_type"],
      payloadMapping: action["payload_mapping"],
    })),
    ...(body["enabled"] === undefined ? {} : { enabled: body["enabled"] }),
    ...(body["failure_policy"] === undefined
      ? {}
      : {
          failurePolicy: {
            maxAttempts: (body["failure_policy"] as Record<string, unknown>)["max_attempts"],
            backoffBaseMs: (body["failure_policy"] as Record<string, unknown>)["backoff_base_ms"],
          },
        }),
  };
}

export function makeIntegrationsRoutes(): ApiRoute[] {
  return [
    {
      spec: {
        method: "GET",
        url: "/integrations/connectors",
        operationId: "list_connectors",
        summary: "Registered connector catalog with typed contracts (spec §6)",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.read",
      },
      async handle(app, ctx) {
        return handle(app, ctx, (a, c) => listConnectors(a, c));
      },
    },
    {
      spec: {
        method: "GET",
        url: "/integrations/connectors/:connectorType",
        operationId: "get_connector_schema",
        summary: "Connector config schema, secret requirements and actions",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.read",
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          properties: { connectorType: { type: "string", maxLength: 60 } },
          required: ["connectorType"],
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { connectorType: string };
        return handle(app, ctx, (a, c) =>
          getConnectorSchema(a, c, { connector_type: params.connectorType }),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/integrations/instances",
        operationId: "list_integration_instances",
        summary: "Configured connections (config + secret-ref NAMES, never values)",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: { connector_type: { type: "string", maxLength: 60 } },
        },
      },
      async handle(app, ctx, request) {
        const query = request.query as Record<string, unknown>;
        return handle(app, ctx, (a, c) =>
          listIntegrationInstances(
            a,
            c,
            typeof query["connector_type"] === "string"
              ? { connector_type: query["connector_type"] }
              : {},
          ),
        );
      },
    },
    {
      spec: {
        method: "POST",
        url: "/integrations/instances",
        operationId: "create_instance",
        summary: "Configure a connection (secrets via names; integrations.secrets.manage)",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.configure",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            connector_type: { type: "string", maxLength: 60 },
            name: { type: "string", minLength: 1, maxLength: 120 },
            enabled: { type: "boolean" },
            config: { type: "object" },
            secret_refs: { type: "object" },
            site_key: { type: ["string", "null"], maxLength: 64 },
            environment: { type: ["string", "null"], maxLength: 32 },
          },
          required: ["connector_type", "name", "config"],
        },
      },
      async handle(app, ctx, request) {
        return handle(app, ctx, (a, c) =>
          createIntegrationInstance(a, c, jsonBody(request) as never),
        );
      },
    },
    {
      spec: {
        method: "PATCH",
        url: "/integrations/instances/:instanceId",
        operationId: "update_instance",
        summary: "Update a configured connection",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.configure",
        csrf: true,
        paramsSchema: ID_PARAM,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            enabled: { type: "boolean" },
            config: { type: "object" },
            secret_refs: { type: "object" },
            site_key: { type: ["string", "null"], maxLength: 64 },
            environment: { type: ["string", "null"], maxLength: 32 },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = jsonBody(request);
        const params = request.params as { instanceId: string };
        return handle(app, ctx, (a, c) =>
          updateIntegrationInstance(a, c, {
            instance_id: params.instanceId,
            ...body,
          } as never),
        );
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/integrations/instances/:instanceId/secrets/:key",
        operationId: "set_instance_secret",
        summary:
          "Store an Admin-managed runtime secret VALUE for a connector requirement (write-only, encrypted at rest, never returned). Requires integrations.secrets.manage.",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.secrets.manage",
        csrf: true,
        paramsSchema: {
          type: "object",
          required: ["instanceId", "key"],
          properties: {
            instanceId: { type: "string", minLength: 1, maxLength: 64 },
            key: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
        bodySchema: {
          type: "object",
          required: ["value"],
          additionalProperties: false,
          properties: { value: { type: "string", minLength: 1, maxLength: 4096 } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { instanceId: string; key: string };
        const body = jsonBody(request) as { value?: unknown };
        return handle(app, ctx, (a, c) =>
          setIntegrationInstanceSecret(a, c, {
            instance_id: params.instanceId,
            key: params.key,
            value: String(body.value ?? ""),
          }),
        );
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/integrations/instances/:instanceId/secrets/:key",
        operationId: "clear_instance_secret",
        summary:
          "Remove a stored Admin-managed runtime secret (editorial data is kept; the connector falls back to env/file refs). Requires integrations.secrets.manage.",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.secrets.manage",
        csrf: true,
        paramsSchema: {
          type: "object",
          required: ["instanceId", "key"],
          properties: {
            instanceId: { type: "string", minLength: 1, maxLength: 64 },
            key: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { instanceId: string; key: string };
        return handle(app, ctx, (a, c) =>
          clearIntegrationInstanceSecret(a, c, {
            instance_id: params.instanceId,
            key: params.key,
          }),
        );
      },
    },
    {
      spec: {
        method: "POST",
        url: "/integrations/instances/:instanceId/test",
        operationId: "test_instance",
        summary: "Privileged safe connection probe (audited)",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.test",
        csrf: true,
        paramsSchema: ID_PARAM,
      },
      async handle(app, ctx, request) {
        const params = request.params as { instanceId: string };
        return handle(app, ctx, (a, c) =>
          testIntegrationInstance(a, c, { instance_id: params.instanceId }),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/integrations/bindings",
        operationId: "list_bindings",
        summary: "Event→action bindings",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.read",
      },
      async handle(app, ctx) {
        return handle(app, ctx, (a, c) => listIntegrationBindings(a, c));
      },
    },
    {
      spec: {
        method: "POST",
        url: "/integrations/bindings",
        operationId: "create_binding",
        summary: "Bind an event type to configured actions (bounded conditions)",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.configure",
        csrf: true,
        bodySchema: BINDING_INPUT_SCHEMA,
      },
      async handle(app, ctx, request) {
        return handle(app, ctx, (a, c) =>
          createIntegrationBinding(a, c, bindingFromWire(jsonBody(request)) as never),
        );
      },
    },
    {
      spec: {
        method: "PATCH",
        url: "/integrations/bindings/:bindingId",
        operationId: "update_binding",
        summary: "Update a binding (event type, conditions, actions, policy)",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.configure",
        csrf: true,
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          properties: { bindingId: { type: "string", pattern: "^[0-9a-f-]{36}$" } },
          required: ["bindingId"],
        },
        bodySchema: BINDING_INPUT_SCHEMA,
      },
      async handle(app, ctx, request) {
        const params = request.params as { bindingId: string };
        const body = jsonBody(request);
        return handle(app, ctx, (a, c) =>
          updateIntegrationBinding(a, c, {
            binding_id: params.bindingId,
            patch: bindingFromWire(body),
          } as never),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/integrations/deliveries",
        operationId: "list_deliveries",
        summary: "Outbound delivery history with reliability states",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.deliveries.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", maxLength: 24 },
            limit: { type: "string", pattern: "^[0-9]+$" },
          },
        },
      },
      async handle(app, ctx, request) {
        const query = request.query as Record<string, unknown>;
        return handle(app, ctx, (a, c) =>
          listIntegrationDeliveries(a, c, {
            ...(typeof query["status"] === "string" ? { status: query["status"] } : {}),
            ...(typeof query["limit"] === "string" ? { limit: Number(query["limit"]) } : {}),
          }),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/integrations/deliveries/stats",
        operationId: "get_delivery_stats",
        summary: "Delivery counters by state (reliability at a glance)",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.deliveries.read",
      },
      async handle(app, ctx) {
        return handle(app, ctx, (a, c) => integrationDeliveryStats(a, c));
      },
    },
    {
      spec: {
        method: "GET",
        url: "/integrations/deliveries/:deliveryId",
        operationId: "get_delivery",
        summary: "One delivery with its complete attempt history",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.deliveries.read",
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          properties: { deliveryId: { type: "string", pattern: "^[0-9a-f-]{36}$" } },
          required: ["deliveryId"],
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { deliveryId: string };
        return handle(app, ctx, (a, c) =>
          getIntegrationDelivery(a, c, { delivery_id: params.deliveryId }),
        );
      },
    },
    {
      spec: {
        method: "POST",
        url: "/integrations/deliveries/:deliveryId/retry",
        operationId: "retry_delivery",
        summary: "Manual retry of a failed delivery (audited)",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.retry",
        csrf: true,
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          properties: { deliveryId: { type: "string", pattern: "^[0-9a-f-]{36}$" } },
          required: ["deliveryId"],
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { deliveryId: string };
        return handle(app, ctx, (a, c) =>
          retryIntegrationDelivery(a, c, { delivery_id: params.deliveryId }),
        );
      },
    },
    {
      spec: {
        method: "POST",
        url: "/integrations/deliveries/:deliveryId/cancel",
        operationId: "cancel_delivery",
        summary: "Cancel a pending/failed delivery (audited)",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.retry",
        csrf: true,
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          properties: { deliveryId: { type: "string", pattern: "^[0-9a-f-]{36}$" } },
          required: ["deliveryId"],
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { deliveryId: string };
        return handle(app, ctx, (a, c) =>
          cancelIntegrationDelivery(a, c, { delivery_id: params.deliveryId }),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/integrations/inbound-events",
        operationId: "list_inbound_events",
        summary: "Inbound provider events (metadata only — raw payloads protected)",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.inbound.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            source_id: { type: "string", maxLength: 64 },
            status: { type: "string", maxLength: 16 },
            limit: { type: "string", pattern: "^[0-9]+$" },
          },
        },
      },
      async handle(app, ctx, request) {
        const query = request.query as Record<string, unknown>;
        return handle(app, ctx, (a, c) =>
          listInboundEvents(a, c, {
            ...(typeof query["source_id"] === "string" ? { source_id: query["source_id"] } : {}),
            ...(typeof query["status"] === "string" ? { status: query["status"] } : {}),
            ...(typeof query["limit"] === "string" ? { limit: Number(query["limit"]) } : {}),
          }),
        );
      },
    },
    {
      spec: {
        method: "POST",
        url: "/integrations/inbound/:instanceId",
        operationId: "receive_inbound",
        summary:
          "Provider callback receiver (anonymous allowlist; auth via the endpoint verifier, dedup via InboundEvent)",
        tag: "integrations",
        auth: "public",
        bodyLimit: 262144,
      },
      async handle(app, _ctx, request) {
        const params = request.params as { instanceId: string };
        const instance = await app.integrations.instances.get(params.instanceId);
        if (instance === null) {
          throw new ApiError("INTEGRATION_INSTANCE_NOT_FOUND", "inbound endpoint not found", {
            status: 404,
          });
        }
        const definition = app.integrations.registry.get(instance.connectorType);
        if (definition?.inbound === undefined) {
          throw new ApiError("INTEGRATION_INBOUND_INVALID", "connector has no inbound capability", {
            status: 404,
          });
        }
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers[name.toLowerCase()] = value;
        }
        const rawBody =
          typeof request.body === "string"
            ? request.body
            : Buffer.isBuffer(request.body)
              ? (request.body as Buffer).toString("utf8")
              : JSON.stringify(request.body ?? null);
        const outcome = await app.integrations.inbound.receive({
          sourceType: "integration_instance",
          sourceId: instance.id,
          contractKey: `integration_instance:${instance.connectorType}`,
          headers,
          rawBody,
        });
        if (!outcome.duplicate && outcome.record.status === "RECEIVED") {
          await app.integrations.inbound.markProcessed(outcome.record.id);
        }
        return {
          status: 200,
          body: {
            received: true,
            duplicate: outcome.duplicate,
            event_id: outcome.record.id,
          },
        };
      },
    },
  ];
}
