// IntegrationInstance store (PCMS-INT-T002; Integrations spec §5/§44).
// An instance is one configured connection: non-secret config + NAMED
// references into the process secret channel. Secret values never reach
// this table — a hostile config key or ref value is rejected here.
import { type Clock, type DbPool, newStableId, type StableId } from "@pcms/core";
import { type ConnectorRegistry, connectorAction, validateConnectorPayload } from "./connectors.js";
import { IntegrationError } from "./errors.js";

export interface IntegrationInstance {
  readonly id: StableId;
  readonly connectorType: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
  /** Requirement name → process-secret name (never a value). */
  readonly secretRefs: Record<string, string>;
  readonly siteKey: string | null;
  readonly environment: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IntegrationInstanceInput {
  readonly connectorType: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly config: Record<string, unknown>;
  readonly secretRefs?: Record<string, string>;
  readonly siteKey?: string | null;
  readonly environment?: string | null;
}

/** Resolves a process-secret NAME to its value (M01 secret channel). */
export type SecretResolver = (secretName: string) => string | undefined;

interface InstanceRow {
  [column: string]: unknown;
  id: string;
  connector_type: string;
  name: string;
  enabled: boolean;
  config: unknown;
  secret_refs: unknown;
  site_key: string | null;
  environment: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToInstance(row: InstanceRow): IntegrationInstance {
  return {
    id: row.id as StableId,
    connectorType: row.connector_type,
    name: row.name,
    enabled: row.enabled,
    config: (row.config ?? {}) as Record<string, unknown>,
    secretRefs: (row.secret_refs ?? {}) as Record<string, string>,
    siteKey: row.site_key,
    environment: row.environment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Secret-shaped config keys are rejected (a room_token or session token id
// may be plain config — raw credential material must use secret_refs).
const SECRET_SHAPED_KEY =
  /(^|_)(password|passwd|secret|api_?key|access_?token|auth_?token|private_?key|credential_?s?)$|(^|_)secrets?($|_)/i;

function assertSafeSecretRefs(secretRefs: Record<string, string>): void {
  for (const [key, value] of Object.entries(secretRefs)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 128) {
      throw new IntegrationError(
        "INTEGRATION_SECRET_REF_INVALID",
        `secret ref "${key}" must name a process secret (1–128 chars), not a value`,
      );
    }
  }
}

/** Resolves every requirement a connector action needs, fail-secure.
 * Requirements already present in `preResolved` (Admin-managed runtime
 * secrets, PCMS-OPS-T131) are not required from the env/file refs. */
export function resolveSecrets(
  instance: IntegrationInstance,
  definition: { secrets: readonly { name: string }[] },
  resolver: SecretResolver,
  preResolved: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const resolved: Record<string, string> = { ...preResolved };
  for (const requirement of definition.secrets) {
    if (requirement.name in preResolved) continue;
    const refName = instance.secretRefs[requirement.name];
    if (refName === undefined) {
      throw new IntegrationError(
        "INTEGRATION_SECRET_MISSING",
        `instance "${instance.name}" has no secret ref for "${requirement.name}"`,
      );
    }
    const value = resolver(refName);
    if (value === undefined || value === "") {
      throw new IntegrationError(
        "INTEGRATION_SECRET_MISSING",
        `secret "${refName}" (needed by "${instance.name}") is not loaded in this process`,
      );
    }
    resolved[requirement.name] = value;
  }
  return resolved;
}

export function createIntegrationInstanceService(deps: {
  pool: DbPool;
  clock: Clock;
  registry: ConnectorRegistry;
}) {
  const { pool, clock, registry } = deps;

  function validate(
    connectorType: string,
    config: unknown,
    secretRefs: Record<string, string>,
  ): void {
    const definition = registry.get(connectorType);
    if (definition === undefined) {
      throw new IntegrationError(
        "CONNECTOR_TYPE_UNKNOWN",
        `connector type "${connectorType}" is not registered`,
      );
    }
    const issues = validateConnectorPayload(definition.configSchema, config, "config");
    if (issues.length > 0) {
      throw new IntegrationError(
        "INTEGRATION_CONFIG_INVALID",
        "instance config failed validation",
        {
          details: { issues },
        },
      );
    }
    for (const key of Object.keys(config as Record<string, unknown>)) {
      if (SECRET_SHAPED_KEY.test(key)) {
        throw new IntegrationError(
          "INTEGRATION_SECRET_REF_INVALID",
          `config key "${key}" looks like a secret value — use secret_refs`,
        );
      }
    }
    assertSafeSecretRefs(secretRefs);
  }

  async function insert(
    input: IntegrationInstanceInput,
    id: StableId,
  ): Promise<IntegrationInstance> {
    const result = await pool.query<InstanceRow>(
      `INSERT INTO integration_instance
         (id, connector_type, name, enabled, config, secret_refs, site_key, environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        input.connectorType,
        input.name,
        input.enabled ?? true,
        JSON.stringify(input.config),
        JSON.stringify(input.secretRefs ?? {}),
        input.siteKey ?? null,
        input.environment ?? null,
      ],
    );
    return rowToInstance(result.rows[0]!);
  }

  return {
    async create(input: IntegrationInstanceInput): Promise<IntegrationInstance> {
      validate(input.connectorType, input.config, input.secretRefs ?? {});
      return insert(input, newStableId());
    },

    async update(
      id: string,
      patch: {
        readonly name?: string;
        readonly enabled?: boolean;
        readonly config?: Record<string, unknown>;
        readonly secretRefs?: Record<string, string>;
        readonly siteKey?: string | null;
        readonly environment?: string | null;
      },
    ): Promise<IntegrationInstance> {
      const current = await pool.query<InstanceRow>(
        `SELECT * FROM integration_instance WHERE id = $1`,
        [id],
      );
      if (current.rows.length !== 1) {
        throw new IntegrationError("INTEGRATION_INSTANCE_NOT_FOUND", `instance ${id} not found`);
      }
      const existing = rowToInstance(current.rows[0]!);
      const connectorType = existing.connectorType;
      const name = patch.name ?? existing.name;
      const config = patch.config ?? existing.config;
      const secretRefs = patch.secretRefs ?? existing.secretRefs;
      validate(connectorType, config, secretRefs);
      const result = await pool.query<InstanceRow>(
        `UPDATE integration_instance
         SET name = $2, enabled = $3, config = $4, secret_refs = $5,
             site_key = $6, environment = $7, updated_at = $8
         WHERE id = $1
         RETURNING *`,
        [
          id,
          name,
          patch.enabled ?? existing.enabled,
          JSON.stringify(config),
          JSON.stringify(secretRefs),
          patch.siteKey === undefined ? existing.siteKey : patch.siteKey,
          patch.environment === undefined ? existing.environment : patch.environment,
          clock.now(),
        ],
      );
      return rowToInstance(result.rows[0]!);
    },

    async get(id: string): Promise<IntegrationInstance | null> {
      const result = await pool.query<InstanceRow>(
        `SELECT * FROM integration_instance WHERE id = $1`,
        [id],
      );
      return result.rows.length === 1 ? rowToInstance(result.rows[0]!) : null;
    },

    async list(options?: {
      readonly connectorType?: string;
      readonly enabled?: boolean;
    }): Promise<readonly IntegrationInstance[]> {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (options?.connectorType !== undefined) {
        params.push(options.connectorType);
        conditions.push(`connector_type = $${params.length}`);
      }
      if (options?.enabled !== undefined) {
        params.push(options.enabled);
        conditions.push(`enabled = $${params.length}`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const result = await pool.query<InstanceRow>(
        `SELECT * FROM integration_instance ${where} ORDER BY name`,
        params,
      );
      return result.rows.map(rowToInstance);
    },

    /** Validates an action payload against the connector's declared schema. */
    validateActionPayload(connectorType: string, actionType: string, payload: unknown): void {
      const definition = registry.get(connectorType);
      const action = definition === undefined ? undefined : connectorAction(definition, actionType);
      if (action === undefined) {
        throw new IntegrationError(
          "INTEGRATION_ACTION_UNKNOWN",
          `connector "${connectorType}" does not support action "${actionType}"`,
        );
      }
      const issues = validateConnectorPayload(action.payloadSchema, payload, "payload");
      if (issues.length > 0) {
        throw new IntegrationError(
          "INTEGRATION_CONFIG_INVALID",
          `action payload failed validation for "${actionType}"`,
          { details: { issues } },
        );
      }
    },
  };
}

export type IntegrationInstanceService = ReturnType<typeof createIntegrationInstanceService>;
