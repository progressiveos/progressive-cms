// Outbox consumer / action dispatcher (PCMS-INT-T005; Integrations spec
// §1/§21). Reliability model, strictly:
//
//   persisted domain event → binding → logical IntegrationDelivery →
//   DeliveryAttempt → connector network call
//
// The M07 outbox handler ONLY materializes delivery rows inside a plain
// statement batch (no network); execution runs from processDue() on the
// worker cadence. An external outage therefore can never lose an accepted
// business event, and network calls never run inside any domain
// transaction. Replayed events hit the delivery identity constraint and
// cannot create duplicate logical deliveries (spec §11).
import type { Clock } from "@pcms/core";
import type { IntegrationBindingService } from "./bindings.js";
import {
  evaluateConditions,
  type FailurePolicy,
  type PayloadMapping,
  readPath,
  resolvePayloadMapping,
} from "./conditions.js";
import { type ConnectorRegistry, connectorAction, validateConnectorPayload } from "./connectors.js";
import type { DeliveryService, IntegrationDelivery } from "./deliveries.js";
import { IntegrationError } from "./errors.js";
import {
  type IntegrationInstance,
  type IntegrationInstanceService,
  resolveSecrets,
  type SecretResolver,
} from "./instances.js";
import type { ActionExecutionContext, ActionResult, ConnectorRuntimeRegistry } from "./runtime.js";

/**
 * Structural view of an M07 outbox event — the real publication OutboxEvent
 * satisfies this shape (composition wires `handleEvent` into the consumer
 * dispatch table), but this L1 package never imports another L1 package.
 */
export interface IntegrationDomainEvent {
  readonly id: string;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
}

/**
 * Structural injected projection source (owner brief §6): outbound payload
 * mapping may request additional ALLOWED interaction fields; the composition
 * layer adapts the Forms application service to this interface after the
 * M12+M13 merge. Integrations never reads Forms tables.
 */
export interface IntegrationProjectionSource {
  project(request: {
    readonly eventType: string;
    readonly aggregate: string;
    readonly aggregateId: string;
    readonly fields: readonly string[];
  }): Promise<Record<string, unknown> | null>;
  /**
   * Execution-time enrichment (owner Progressive-HQ task): fresh domain
   * fields for a connector action that declares `executionProjection`.
   * Values ride the action context only — they are never persisted into the
   * delivery payload and never logged. Absent when the composition wires no
   * execution-capable boundary.
   */
  projectExecution?(request: {
    readonly aggregate: string;
    readonly id: string;
    readonly fields: readonly string[];
  }): Promise<Record<string, unknown> | null>;
}

function projectPathsOf(mapping: PayloadMapping): readonly string[] {
  const paths = new Set<string>();
  for (const source of Object.values(mapping)) {
    if ("$project" in source) paths.add(source.$project);
  }
  return [...paths];
}

export function createIntegrationDispatcher(deps: {
  clock: Clock;
  registry: ConnectorRegistry;
  runtimes: ConnectorRuntimeRegistry;
  bindings: IntegrationBindingService;
  instances: IntegrationInstanceService;
  deliveries: DeliveryService;
  secretResolver: SecretResolver;
  /**
   * Admin-managed runtime secret overlay (PCMS-OPS-T131): decrypted values
   * per instance, taking precedence over env/file secret refs. Absent when
   * the deployment configures no runtime-secrets encryption key.
   */
  runtimeSecretSource?: (instanceId: string) => Promise<Record<string, string>>;
  projectionSource?: IntegrationProjectionSource;
}) {
  const { clock, registry, runtimes, bindings, instances, deliveries, secretResolver } = deps;

  /** Env/file refs first, then the runtime overlay wins per requirement. */
  const resolveWithRuntimeSecrets = async (
    instance: IntegrationInstance,
    definition: { secrets: readonly { name: string }[] },
  ): Promise<Record<string, string>> => {
    const runtimeSecrets =
      deps.runtimeSecretSource === undefined ? {} : await deps.runtimeSecretSource(instance.id);
    const fromRefs = resolveSecrets(instance, definition, secretResolver, runtimeSecrets);
    return { ...fromRefs, ...runtimeSecrets };
  };

  async function executeDelivery(delivery: IntegrationDelivery): Promise<void> {
    const binding = await bindings.get(delivery.bindingId);
    const policy: FailurePolicy = binding?.failurePolicy ?? {
      maxAttempts: delivery.maxAttempts,
      backoffBaseMs: 30_000,
    };

    const fail = async (error: {
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly httpStatus?: number;
    }) =>
      deliveries.recordAttempt(delivery, {
        ok: false,
        retryable: error.retryable,
        backoffBaseMs: policy.backoffBaseMs,
        providerErrorCode: error.code,
        errorMessage: error.message,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      });

    try {
      const instance = await instances.get(delivery.instanceId);
      if (instance === null) {
        await fail({
          code: "INTEGRATION_INSTANCE_NOT_FOUND",
          message: "instance deleted",
          retryable: false,
        });
        return;
      }
      const definition = registry.get(instance.connectorType);
      const runtime = runtimes.get(instance.connectorType);
      const action =
        definition === undefined ? undefined : connectorAction(definition, delivery.actionType);
      if (definition === undefined || runtime === undefined || action === undefined) {
        await fail({
          code: "INTEGRATION_ACTION_UNKNOWN",
          message: `no runtime for connector "${instance.connectorType}" action "${delivery.actionType}"`,
          retryable: false,
        });
        return;
      }
      const payloadIssues = validateConnectorPayload(
        action.payloadSchema,
        delivery.payload,
        "payload",
      );
      if (payloadIssues.length > 0) {
        await fail({
          code: "INTEGRATION_CONFIG_INVALID",
          message: `mapped payload failed schema: ${payloadIssues.join("; ")}`,
          retryable: false,
        });
        return;
      }
      let secrets: Record<string, string>;
      try {
        secrets = await resolveWithRuntimeSecrets(instance, definition);
        // Dynamic refs: connectors may address additional process secrets by
        // name from config (e.g. webhook secret_headers). Missing names are
        // not fatal here — the runtime reports the specific missing secret.
        for (const [requirement, secretName] of Object.entries(instance.secretRefs)) {
          if (!(requirement in secrets)) {
            const value = secretResolver(secretName);
            if (value !== undefined) secrets[requirement] = value;
          }
        }
      } catch (error) {
        if (error instanceof IntegrationError) {
          await fail({ code: error.code, message: error.message, retryable: false });
          return;
        }
        throw error;
      }
      // Execution-time projection (owner Progressive-HQ task): fetched fresh
      // for THIS attempt by aggregate id from the mapped payload, passed on
      // the context only. A vanished aggregate is a permanent failure — the
      // business event can no longer be honored truthfully.
      let executionProjection: Record<string, unknown> | undefined;
      const execRequest = action.executionProjection;
      if (execRequest !== undefined) {
        const source = deps.projectionSource;
        if (source?.projectExecution === undefined) {
          await fail({
            code: "INTEGRATION_PROJECTION_UNAVAILABLE",
            message: "action needs an execution projection but none is wired",
            retryable: false,
          });
          return;
        }
        const aggregateId = readPath(delivery.payload, execRequest.idFromPayload);
        if (typeof aggregateId !== "string" || aggregateId === "") {
          await fail({
            code: "INTEGRATION_PROJECTION_UNAVAILABLE",
            message: `payload lacks "${execRequest.idFromPayload}" for the execution projection`,
            retryable: false,
          });
          return;
        }
        const projected = await source.projectExecution({
          aggregate: execRequest.aggregate,
          id: aggregateId,
          fields: execRequest.fields,
        });
        if (projected === null) {
          await fail({
            code: "INTEGRATION_PROJECTION_UNAVAILABLE",
            message: `aggregate "${execRequest.aggregate}" is gone`,
            retryable: false,
          });
          return;
        }
        executionProjection = projected;
      }
      const ctx: ActionExecutionContext = {
        instance,
        ...(delivery.bodyRevision === 2 ? { bodyRevision: 2 } : {}),
        secrets,
        ...(executionProjection === undefined ? {} : { projection: executionProjection }),
      };
      await deliveries.withExecution(delivery, async (executor) => {
        let outcome: ActionResult;
        try {
          outcome = await runtime.execute(delivery.actionType, delivery.payload as never, ctx);
        } catch {
          outcome = {
            ok: false,
            retryable: true,
            providerErrorCode: "INTEGRATION_DELIVERY_FAILED",
            errorMessage: "outbound runtime failed",
          };
        }
        await deliveries.recordAttempt(
          delivery,
          {
            ok: outcome.ok,
            retryable: outcome.retryable,
            backoffBaseMs: policy.backoffBaseMs,
            ...(outcome.ok
              ? {}
              : { providerErrorCode: outcome.providerErrorCode ?? "INTEGRATION_DELIVERY_FAILED" }),
            ...(outcome.ok ? {} : { errorMessage: outcome.errorMessage ?? "delivery failed" }),
            ...(outcome.externalId === undefined ? {} : { externalId: outcome.externalId }),
            ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
          },
          executor,
        );
      });
    } catch (error) {
      // Unexpected runtime fault: safe summary only (message can carry paths,
      // but never secrets — resolvers are the only secret handlers and they
      // never embed values in errors).
      await fail({
        code: "INTEGRATION_DELIVERY_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  }

  return {
    /** Outbox consumer side: event → matching bindings → delivery rows. */
    async handleEvent(event: IntegrationDomainEvent): Promise<void> {
      const candidates = await bindings.list({ eventType: event.eventType, enabled: true });
      for (const binding of candidates) {
        if (
          binding.sourceFilter !== null &&
          binding.sourceFilter !== undefined &&
          binding.sourceFilter !== event.aggregate
        ) {
          continue;
        }
        if (!evaluateConditions(binding.conditions, event.payload)) continue;
        for (const [actionIndex, action] of binding.actions.entries()) {
          // MKT-010: pin the outbound body format at materialization so a
          // later retry of this delivery replays byte-identical bytes even
          // after the connection flag flips.
          const instanceForRevision = await instances.get(action.instanceId);
          const bodyRevision = instanceForRevision?.config["send_attribution"] === true ? 2 : 1;
          // The projection is consulted only when the mapping needs it —
          // pure-metadata events never touch the injected boundary.
          let projection: Record<string, unknown> | null = null;
          const requestedPaths = projectPathsOf(action.payloadMapping);
          if (requestedPaths.length > 0) {
            const source = deps.projectionSource;
            if (source === undefined) {
              projection = null;
            } else {
              projection = await source.project({
                eventType: event.eventType,
                aggregate: event.aggregate,
                aggregateId: event.aggregateId,
                fields: requestedPaths,
              });
            }
          }
          let payload: Record<string, unknown>;
          try {
            payload = resolvePayloadMapping(action.payloadMapping, event.payload, projection);
          } catch (error) {
            if (error instanceof IntegrationError) {
              const { delivery } = await deliveries.materialize({
                identity: { outboxEventId: event.id, bindingId: binding.id, actionIndex },
                eventType: event.eventType,
                instanceId: action.instanceId,
                actionType: action.actionType,
                payload: {},
                maxAttempts: binding.failurePolicy.maxAttempts,
                bodyRevision,
              });
              await deliveries.recordAttempt(delivery, {
                ok: false,
                retryable: false,
                backoffBaseMs: binding.failurePolicy.backoffBaseMs,
                providerErrorCode: error.code,
                errorMessage: error.message,
              });
              continue;
            }
            throw error;
          }
          await deliveries.materialize({
            identity: { outboxEventId: event.id, bindingId: binding.id, actionIndex },
            eventType: event.eventType,
            instanceId: action.instanceId,
            actionType: action.actionType,
            payload,
            maxAttempts: binding.failurePolicy.maxAttempts,
            bodyRevision,
          });
        }
      }
    },

    /** Worker-cadence execution of due deliveries. Returns processed count. */
    async processDue(limit: number): Promise<number> {
      const due = await deliveries.claimDue(limit);
      for (const delivery of due) {
        await executeDelivery(delivery);
      }
      return due.length;
    },

    /** Manual retry from Admin/API (permission-gated upstream). */
    async retryDelivery(deliveryId: string): Promise<void> {
      const rearmed = await deliveries.retry(deliveryId);
      const claimed = await deliveries.claimOne(rearmed.id);
      if (claimed !== null) await executeDelivery(claimed);
    },

    /** Privileged connection test (spec §40) — persists nothing. */
    async testInstance(instanceId: string): Promise<{
      readonly ok: boolean;
      readonly code?: string;
      readonly message?: string;
    }> {
      const instance = await instances.get(instanceId);
      if (instance === null) {
        throw new IntegrationError(
          "INTEGRATION_INSTANCE_NOT_FOUND",
          `instance ${instanceId} not found`,
        );
      }
      const definition = registry.get(instance.connectorType);
      const runtime = runtimes.get(instance.connectorType);
      if (definition === undefined || runtime === undefined) {
        return {
          ok: false,
          code: "INTEGRATION_ACTION_UNKNOWN",
          message: "connector runtime not registered",
        };
      }
      if (!definition.testable) {
        return {
          ok: false,
          code: "INTEGRATION_ACTION_UNKNOWN",
          message: "connector has no test capability",
        };
      }
      try {
        const secrets = await resolveWithRuntimeSecrets(instance, definition);
        const outcome = await runtime.test({ instance, secrets });
        return outcome.ok
          ? { ok: true }
          : {
              ok: false,
              ...(outcome.providerErrorCode === undefined
                ? {}
                : { code: outcome.providerErrorCode }),
              ...(outcome.errorMessage === undefined ? {} : { message: outcome.errorMessage }),
            };
      } catch (error) {
        if (error instanceof IntegrationError)
          return { ok: false, code: error.code, message: error.message };
        return {
          ok: false,
          code: "INTEGRATION_DELIVERY_FAILED",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export type IntegrationDispatcher = ReturnType<typeof createIntegrationDispatcher>;
