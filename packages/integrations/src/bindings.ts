// IntegrationBinding store (PCMS-INT-T003; Integrations spec §13/§15).
// A binding wires one event type (+ optional aggregate/source filter and
// typed conditions) to one or more configured actions. Actions are stored
// inline — they are owned 1:1 by the binding and have no independent
// lifecycle, so a second table would be ceremony.
import { type Clock, type DbPool, newStableId, type StableId } from "@pcms/core";
import {
  type BindingCondition,
  type FailurePolicy,
  type PayloadMapping,
  validateConditions,
  validatePayloadMapping,
} from "./conditions.js";
import { type ConnectorRegistry, connectorAction } from "./connectors.js";
import { IntegrationError } from "./errors.js";
import type { IntegrationInstanceService } from "./instances.js";

export interface BindingAction {
  readonly instanceId: string;
  readonly actionType: string;
  readonly payloadMapping: PayloadMapping;
}

export interface IntegrationBinding {
  readonly id: StableId;
  readonly eventType: string;
  readonly sourceFilter: string | null;
  readonly conditions: readonly BindingCondition[];
  readonly actions: readonly BindingAction[];
  readonly enabled: boolean;
  readonly failurePolicy: FailurePolicy;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IntegrationBindingInput {
  readonly eventType: string;
  readonly sourceFilter?: string | null;
  readonly conditions?: unknown;
  readonly actions: readonly {
    readonly instanceId: string;
    readonly actionType: string;
    readonly payloadMapping: unknown;
  }[];
  readonly enabled?: boolean;
  readonly failurePolicy?: { readonly maxAttempts?: number; readonly backoffBaseMs?: number };
}

const MAX_ACTIONS = 8;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 30_000;

function normalizeFailurePolicy(policy: IntegrationBindingInput["failurePolicy"]): FailurePolicy {
  const maxAttempts = policy?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffBaseMs = policy?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new IntegrationError("INTEGRATION_BINDING_INVALID", "max_attempts must be 1–10");
  }
  if (!Number.isInteger(backoffBaseMs) || backoffBaseMs < 1_000 || backoffBaseMs > 3_600_000) {
    throw new IntegrationError(
      "INTEGRATION_BINDING_INVALID",
      "backoff_base_ms must be 1000–3600000",
    );
  }
  return { maxAttempts, backoffBaseMs };
}

interface BindingRow {
  [column: string]: unknown;
  id: string;
  event_type: string;
  source_filter: string | null;
  conditions: unknown;
  actions: unknown;
  enabled: boolean;
  failure_policy: unknown;
  created_at: Date;
  updated_at: Date;
}

function rowToBinding(row: BindingRow): IntegrationBinding {
  return {
    id: row.id as StableId,
    eventType: row.event_type,
    sourceFilter: row.source_filter,
    conditions: (row.conditions ?? []) as readonly BindingCondition[],
    actions: (row.actions ?? []) as readonly BindingAction[],
    enabled: row.enabled,
    failurePolicy: (row.failure_policy ?? {}) as FailurePolicy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createIntegrationBindingService(deps: {
  pool: DbPool;
  clock: Clock;
  instances: IntegrationInstanceService;
  registry: ConnectorRegistry;
}) {
  const { pool, clock, instances, registry } = deps;

  /** Validates actions against the CURRENT instance/connector contracts. */
  async function validateActions(input: IntegrationBindingInput): Promise<BindingAction[]> {
    if (!Array.isArray(input.actions) || input.actions.length === 0) {
      throw new IntegrationError("INTEGRATION_BINDING_INVALID", "at least one action is required");
    }
    if (input.actions.length > MAX_ACTIONS) {
      throw new IntegrationError("INTEGRATION_BINDING_INVALID", `at most ${MAX_ACTIONS} actions`);
    }
    const out: BindingAction[] = [];
    for (const [index, action] of input.actions.entries()) {
      const instance = await instances.get(action.instanceId);
      if (instance === null) {
        throw new IntegrationError(
          "INTEGRATION_INSTANCE_NOT_FOUND",
          `actions/${index}: instance ${action.instanceId} does not exist`,
        );
      }
      const definition = registry.get(instance.connectorType);
      if (
        definition === undefined ||
        connectorAction(definition, action.actionType) === undefined
      ) {
        throw new IntegrationError(
          "INTEGRATION_ACTION_UNKNOWN",
          `actions/${index}: connector "${instance.connectorType}" does not support action "${action.actionType}"`,
        );
      }
      out.push({
        instanceId: action.instanceId,
        actionType: action.actionType,
        payloadMapping: validatePayloadMapping(action.payloadMapping),
      });
    }
    // A disabled instance is allowed in a binding (configure first, enable
    // later) — the dispatcher skips it, it is not a validation error.
    return out;
  }

  return {
    async create(input: IntegrationBindingInput): Promise<IntegrationBinding> {
      if (
        typeof input.eventType !== "string" ||
        input.eventType.length === 0 ||
        input.eventType.length > 100
      ) {
        throw new IntegrationError("INTEGRATION_BINDING_INVALID", "event_type is required");
      }
      const actions = await validateActions(input);
      const conditions = validateConditions(input.conditions);
      const failurePolicy = normalizeFailurePolicy(input.failurePolicy);
      const result = await pool.query<BindingRow>(
        `INSERT INTO integration_binding
           (id, event_type, source_filter, conditions, actions, enabled, failure_policy)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          newStableId(),
          input.eventType,
          input.sourceFilter ?? null,
          JSON.stringify(conditions),
          JSON.stringify(actions),
          input.enabled ?? true,
          JSON.stringify(failurePolicy),
        ],
      );
      return rowToBinding(result.rows[0]!);
    },

    async update(
      id: string,
      patch: {
        readonly eventType?: string;
        readonly sourceFilter?: string | null;
        readonly conditions?: unknown;
        readonly actions?: IntegrationBindingInput["actions"];
        readonly enabled?: boolean;
        readonly failurePolicy?: IntegrationBindingInput["failurePolicy"];
      },
    ): Promise<IntegrationBinding> {
      const current = await pool.query<BindingRow>(
        `SELECT * FROM integration_binding WHERE id = $1`,
        [id],
      );
      if (current.rows.length !== 1) {
        throw new IntegrationError("INTEGRATION_BINDING_NOT_FOUND", `binding ${id} not found`);
      }
      const existing = rowToBinding(current.rows[0]!);
      const actions =
        patch.actions === undefined
          ? existing.actions
          : await validateActions({ eventType: existing.eventType, actions: patch.actions });
      const conditions =
        patch.conditions === undefined ? existing.conditions : validateConditions(patch.conditions);
      const failurePolicy =
        patch.failurePolicy === undefined
          ? existing.failurePolicy
          : normalizeFailurePolicy(patch.failurePolicy);
      const result = await pool.query<BindingRow>(
        `UPDATE integration_binding
         SET event_type = $2, source_filter = $3, conditions = $4, actions = $5,
             enabled = $6, failure_policy = $7, updated_at = $8
         WHERE id = $1
         RETURNING *`,
        [
          id,
          patch.eventType ?? existing.eventType,
          patch.sourceFilter === undefined ? existing.sourceFilter : patch.sourceFilter,
          JSON.stringify(conditions),
          JSON.stringify(actions),
          patch.enabled ?? existing.enabled,
          JSON.stringify(failurePolicy),
          clock.now(),
        ],
      );
      return rowToBinding(result.rows[0]!);
    },

    async get(id: string): Promise<IntegrationBinding | null> {
      const result = await pool.query<BindingRow>(
        `SELECT * FROM integration_binding WHERE id = $1`,
        [id],
      );
      return result.rows.length === 1 ? rowToBinding(result.rows[0]!) : null;
    },

    async list(options?: {
      readonly eventType?: string;
      readonly enabled?: boolean;
    }): Promise<readonly IntegrationBinding[]> {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (options?.eventType !== undefined) {
        params.push(options.eventType);
        conditions.push(`event_type = $${params.length}`);
      }
      if (options?.enabled !== undefined) {
        params.push(options.enabled);
        conditions.push(`enabled = $${params.length}`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const result = await pool.query<BindingRow>(
        `SELECT * FROM integration_binding ${where} ORDER BY created_at, id`,
        params,
      );
      return result.rows.map(rowToBinding);
    },
  };
}

export type IntegrationBindingService = ReturnType<typeof createIntegrationBindingService>;
