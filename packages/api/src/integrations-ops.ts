// Integrations application operations (PCMS-INT-T015/T016; Integrations
// spec §41–§43). The ONLY place transport-facing callers touch the
// integrations subsystem: every operation authorizes against the M08
// registry (default-deny) and privileged operations audit into the M08
// security-event stream. REST, MCP and CLI all call these functions.
import { recordSecurityEvent } from "@pcms/auth";
import type {
  DeliveryAttempt,
  IntegrationBinding,
  IntegrationDelivery,
  IntegrationInstance,
} from "@pcms/integrations";
import {
  clearInstanceRuntimeSecret,
  listInstanceRuntimeSecretKeys,
  RuntimeSecretError,
  setInstanceRuntimeSecret,
} from "@pcms/integrations";
import type { ApplicationServices, OperationContext } from "./context.js";
import { auditBase, requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

/** Secret-ref changes are separated from ordinary configure access. */
function assertInstancePermission(
  app: ApplicationServices,
  ctx: OperationContext,
  operation: "create" | "update",
  patch?: { readonly secretRefs?: Record<string, string> },
): void {
  requirePermission(app, ctx, "integrations.configure");
  if (patch?.secretRefs !== undefined) {
    requirePermission(app, ctx, "integrations.secrets.manage");
  }
  if (operation === "create") {
    requirePermission(app, ctx, "integrations.read");
  }
}

export function listConnectors(app: ApplicationServices, ctx: OperationContext) {
  requirePermission(app, ctx, "integrations.read");
  return {
    items: app.integrations.registry.list().map((definition) => ({
      connector_type: definition.connectorType,
      title: definition.title,
      description: definition.description,
      config_schema: definition.configSchema,
      secrets: definition.secrets,
      actions: definition.actions,
      testable: definition.testable,
      inbound: definition.inbound ?? null,
    })),
  };
}

export function getConnectorSchema(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly connector_type: string },
) {
  requirePermission(app, ctx, "integrations.read");
  const definition = app.integrations.registry.get(input.connector_type);
  if (definition === undefined) {
    throw new ApiError("CONNECTOR_TYPE_UNKNOWN", `connector "${input.connector_type}" not found`, {
      status: 404,
    });
  }
  return {
    connector_type: definition.connectorType,
    schema: definition.configSchema,
    actions: definition.actions,
    secrets: definition.secrets,
  };
}

/** Public projection of an instance: config + secret NAMES (never values —
 * neither env/file ref values nor Admin-managed runtime secret values). */
function instanceView(instance: IntegrationInstance, runtimeSecrets: readonly string[] = []) {
  return {
    id: instance.id,
    connector_type: instance.connectorType,
    name: instance.name,
    enabled: instance.enabled,
    config: instance.config,
    secret_refs: instance.secretRefs,
    runtime_secrets: runtimeSecrets,
    site_key: instance.siteKey,
    environment: instance.environment,
    created_at: instance.createdAt.toISOString(),
    updated_at: instance.updatedAt.toISOString(),
  };
}

async function instanceViewEnriched(app: ApplicationServices, instance: IntegrationInstance) {
  return instanceView(instance, await listInstanceRuntimeSecretKeys(app.pool, instance.id));
}

export async function listIntegrationInstances(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly connector_type?: string } = {},
) {
  requirePermission(app, ctx, "integrations.read");
  const instances = await app.integrations.instances.list({
    ...(input.connector_type === undefined ? {} : { connectorType: input.connector_type }),
  });
  return {
    items: await Promise.all(instances.map((instance) => instanceViewEnriched(app, instance))),
  };
}

export async function createIntegrationInstance(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly connector_type: string;
    readonly name: string;
    readonly enabled?: boolean;
    readonly config: Record<string, unknown>;
    readonly secret_refs?: Record<string, string>;
    readonly site_key?: string | null;
    readonly environment?: string | null;
  },
) {
  assertInstancePermission(
    app,
    ctx,
    "create",
    input.secret_refs === undefined ? {} : { secretRefs: input.secret_refs },
  );
  const instance = await app.integrations.instances.create({
    connectorType: input.connector_type,
    name: input.name,
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    config: input.config,
    ...(input.secret_refs === undefined ? {} : { secretRefs: input.secret_refs }),
    ...(input.site_key === undefined ? {} : { siteKey: input.site_key }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  });
  await recordSecurityEvent(app.pool, null, {
    type: "INTEGRATION_CONFIGURED",
    ...auditBase(ctx),
    subjectType: "integration_instance",
    subjectId: instance.id,
    metadata: { operation: "create", connector_type: instance.connectorType },
  });
  return instanceViewEnriched(app, instance);
}

export async function updateIntegrationInstance(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly instance_id: string;
    readonly name?: string;
    readonly enabled?: boolean;
    readonly config?: Record<string, unknown>;
    readonly secret_refs?: Record<string, string>;
    readonly site_key?: string | null;
    readonly environment?: string | null;
  },
) {
  assertInstancePermission(
    app,
    ctx,
    "update",
    input.secret_refs === undefined ? {} : { secretRefs: input.secret_refs },
  );
  const instance = await app.integrations.instances.update(input.instance_id, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.config === undefined ? {} : { config: input.config }),
    ...(input.secret_refs === undefined ? {} : { secretRefs: input.secret_refs }),
    ...(input.site_key === undefined ? {} : { siteKey: input.site_key }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  });
  await recordSecurityEvent(app.pool, null, {
    type: "INTEGRATION_CONFIGURED",
    ...auditBase(ctx),
    subjectType: "integration_instance",
    subjectId: instance.id,
    metadata: { operation: "update", connector_type: instance.connectorType },
  });
  return instanceViewEnriched(app, instance);
}

export async function testIntegrationInstance(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly instance_id: string },
) {
  requirePermission(app, ctx, "integrations.test");
  const outcome = await app.integrations.dispatcher.testInstance(input.instance_id);
  await recordSecurityEvent(app.pool, null, {
    type: "INTEGRATION_TESTED",
    ...auditBase(ctx),
    subjectType: "integration_instance",
    subjectId: input.instance_id,
    metadata: { ok: outcome.ok, ...(outcome.code === undefined ? {} : { code: outcome.code }) },
  });
  return outcome;
}

export async function listIntegrationBindings(app: ApplicationServices, ctx: OperationContext) {
  requirePermission(app, ctx, "integrations.read");
  const bindings = await app.integrations.bindings.list();
  return { items: bindings.map(bindingWire) };
}

/** Canonical snake_case wire shapes (owner fix): the services speak
 * camelCase internally; every other Admin API projects snake_case, so the
 * REST/MCP surface normalizes here instead of leaking the internal casing. */
function bindingWire(binding: IntegrationBinding) {
  return {
    id: binding.id,
    event_type: binding.eventType,
    source_filter: binding.sourceFilter,
    conditions: binding.conditions,
    actions: binding.actions.map((action) => ({
      instance_id: action.instanceId,
      action_type: action.actionType,
      payload_mapping: action.payloadMapping,
    })),
    enabled: binding.enabled,
    failure_policy: {
      max_attempts: binding.failurePolicy.maxAttempts,
      backoff_base_ms: binding.failurePolicy.backoffBaseMs,
    },
    created_at: binding.createdAt.toISOString(),
    updated_at: binding.updatedAt.toISOString(),
  };
}

function deliveryWire(delivery: IntegrationDelivery) {
  return {
    id: delivery.id,
    outbox_event_id: delivery.outboxEventId,
    event_type: delivery.eventType,
    binding_id: delivery.bindingId,
    action_index: delivery.actionIndex,
    instance_id: delivery.instanceId,
    action_type: delivery.actionType,
    status: delivery.status,
    attempt_count: delivery.attemptCount,
    max_attempts: delivery.maxAttempts,
    ...(delivery.nextAttemptAt === null
      ? {}
      : { next_attempt_at: delivery.nextAttemptAt.toISOString() }),
    ...(delivery.externalId === null ? {} : { external_id: delivery.externalId }),
    ...(delivery.lastErrorCode === null ? {} : { last_error_code: delivery.lastErrorCode }),
    created_at: delivery.createdAt.toISOString(),
    ...(delivery.completedAt === null ? {} : { completed_at: delivery.completedAt.toISOString() }),
  };
}

function attemptWire(attempt: DeliveryAttempt) {
  return {
    attempt_no: attempt.attemptNo,
    result: attempt.result,
    started_at: attempt.startedAt.toISOString(),
    ...(attempt.finishedAt === null ? {} : { finished_at: attempt.finishedAt.toISOString() }),
    ...(attempt.httpStatus === null ? {} : { http_status: attempt.httpStatus }),
    ...(attempt.providerErrorCode === null
      ? {}
      : { provider_error_code: attempt.providerErrorCode }),
    ...(attempt.errorSummary === null ? {} : { error_summary: attempt.errorSummary }),
  };
}

export async function createIntegrationBinding(
  app: ApplicationServices,
  ctx: OperationContext,
  input: Parameters<ApplicationServices["integrations"]["bindings"]["create"]>[0],
) {
  requirePermission(app, ctx, "integrations.configure");
  const binding = await app.integrations.bindings.create(input);
  await recordSecurityEvent(app.pool, null, {
    type: "INTEGRATION_CONFIGURED",
    ...auditBase(ctx),
    subjectType: "integration_binding",
    subjectId: binding.id,
    metadata: { operation: "create", event_type: binding.eventType },
  });
  return bindingWire(binding);
}

export async function updateIntegrationBinding(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly binding_id: string;
    readonly patch: Parameters<ApplicationServices["integrations"]["bindings"]["update"]>[1];
  },
) {
  requirePermission(app, ctx, "integrations.configure");
  const binding = await app.integrations.bindings.update(input.binding_id, input.patch);
  await recordSecurityEvent(app.pool, null, {
    type: "INTEGRATION_CONFIGURED",
    ...auditBase(ctx),
    subjectType: "integration_binding",
    subjectId: binding.id,
    metadata: { operation: "update", event_type: binding.eventType },
  });
  return bindingWire(binding);
}

export async function listIntegrationDeliveries(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly status?: string; readonly limit?: number } = {},
) {
  requirePermission(app, ctx, "integrations.deliveries.read");
  const validStatuses = [
    "PENDING",
    "PROCESSING",
    "SUCCEEDED",
    "FAILED_RETRYABLE",
    "FAILED_PERMANENT",
    "CANCELLED",
  ] as const;
  const status = input.status as (typeof validStatuses)[number] | undefined;
  if (status !== undefined && !validStatuses.includes(status)) {
    throw new ApiError("INTEGRATION_DELIVERY_STATE", `unknown delivery status "${input.status}"`, {
      status: 422,
    });
  }
  const items = await app.integrations.deliveries.list({
    ...(status === undefined ? {} : { status }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return { items: items.map(deliveryWire) };
}

export async function getIntegrationDelivery(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly delivery_id: string },
) {
  requirePermission(app, ctx, "integrations.deliveries.read");
  const found = await app.integrations.deliveries.get(input.delivery_id);
  if (found === null) {
    throw new ApiError("INTEGRATION_DELIVERY_NOT_FOUND", "delivery not found", { status: 404 });
  }
  return { ...deliveryWire(found.delivery), attempts: found.attempts.map(attemptWire) };
}

export async function retryIntegrationDelivery(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly delivery_id: string },
) {
  requirePermission(app, ctx, "integrations.retry");
  await app.integrations.dispatcher.retryDelivery(input.delivery_id);
  await recordSecurityEvent(app.pool, null, {
    type: "INTEGRATION_RETRY",
    ...auditBase(ctx),
    subjectType: "integration_delivery",
    subjectId: input.delivery_id,
  });
  const found = await app.integrations.deliveries.get(input.delivery_id);
  return found === null
    ? null
    : { ...deliveryWire(found.delivery), attempts: found.attempts.map(attemptWire) };
}

export async function cancelIntegrationDelivery(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly delivery_id: string },
) {
  requirePermission(app, ctx, "integrations.retry");
  const delivery = await app.integrations.deliveries.cancel(input.delivery_id);
  await recordSecurityEvent(app.pool, null, {
    type: "INTEGRATION_RETRY",
    ...auditBase(ctx),
    subjectType: "integration_delivery",
    subjectId: input.delivery_id,
    metadata: { operation: "cancel" },
  });
  return deliveryWire(delivery);
}

export async function listInboundEvents(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly source_id?: string; readonly status?: string; readonly limit?: number } = {},
) {
  requirePermission(app, ctx, "integrations.inbound.read");
  const validStatuses = ["RECEIVED", "PROCESSED", "FAILED"] as const;
  const status = input.status as (typeof validStatuses)[number] | undefined;
  if (status !== undefined && !validStatuses.includes(status)) {
    throw new ApiError("INTEGRATION_INBOUND_INVALID", `unknown inbound status "${input.status}"`, {
      status: 422,
    });
  }
  const items = await app.integrations.inbound.list({
    ...(input.source_id === undefined ? {} : { sourceId: input.source_id }),
    ...(status === undefined ? {} : { status }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return { items };
}

export async function integrationDeliveryStats(app: ApplicationServices, ctx: OperationContext) {
  requirePermission(app, ctx, "integrations.deliveries.read");
  return app.integrations.deliveries.stats();
}

/* --- Admin-managed runtime secrets per instance (PCMS-OPS-T131) --- */

export async function setIntegrationInstanceSecret(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly instance_id: string; readonly key: string; readonly value: string },
): Promise<Record<string, unknown>> {
  requirePermission(app, ctx, "integrations.configure");
  requirePermission(app, ctx, "integrations.secrets.manage");
  const instance = await app.integrations.instances.get(input.instance_id);
  if (instance === null) {
    throw new ApiError(
      "INTEGRATION_INSTANCE_NOT_FOUND",
      `instance ${input.instance_id} not found`,
      {
        status: 404,
      },
    );
  }
  const definition = app.integrations.registry.get(instance.connectorType);
  const declared = definition?.secrets.some((requirement) => requirement.name === input.key);
  if (declared !== true) {
    throw new ApiError(
      "INTEGRATION_SECRET_KEY_UNKNOWN",
      `connector "${instance.connectorType}" does not declare secret "${input.key}"`,
      { status: 422 },
    );
  }
  try {
    await setInstanceRuntimeSecret(app.pool, app.runtimeSecretBox, {
      instanceId: instance.id,
      key: input.key,
      value: input.value,
      actor: `user:${ctx.actor.id}`,
    });
  } catch (error) {
    if (error instanceof RuntimeSecretError) {
      throw new ApiError(error.code, error.message, { status: 409 });
    }
    throw error;
  }
  await recordSecurityEvent(app.pool, null, {
    type: "INTEGRATION_SECRET_SET",
    ...auditBase(ctx),
    subjectType: "integration_instance",
    subjectId: instance.id,
    // The VALUE is never recorded — only which requirement key was set.
    metadata: { connector_type: instance.connectorType, key: input.key },
  });
  return instanceViewEnriched(app, instance);
}

export async function clearIntegrationInstanceSecret(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly instance_id: string; readonly key: string },
): Promise<Record<string, unknown>> {
  requirePermission(app, ctx, "integrations.configure");
  requirePermission(app, ctx, "integrations.secrets.manage");
  const instance = await app.integrations.instances.get(input.instance_id);
  if (instance === null) {
    throw new ApiError(
      "INTEGRATION_INSTANCE_NOT_FOUND",
      `instance ${input.instance_id} not found`,
      {
        status: 404,
      },
    );
  }
  await clearInstanceRuntimeSecret(app.pool, {
    instanceId: instance.id,
    key: input.key,
    actor: `user:${ctx.actor.id}`,
  });
  await recordSecurityEvent(app.pool, null, {
    type: "INTEGRATION_SECRET_CLEARED",
    ...auditBase(ctx),
    subjectType: "integration_instance",
    subjectId: instance.id,
    metadata: { connector_type: instance.connectorType, key: input.key },
  });
  return instanceViewEnriched(app, instance);
}
