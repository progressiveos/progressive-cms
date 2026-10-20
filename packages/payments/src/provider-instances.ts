// PaymentProviderInstance store (PCMS-PAY-T003; Payments spec §32).
// Secret-safe configuration like IntegrationInstance: names only, schema-
// validated config, no credential values ever persisted.
import { type Clock, type DbPool, newStableId, type StableId } from "@pcms/core";
import { PaymentError } from "./errors.js";
import { validateAgainstSchema } from "./schema.js";

export interface PaymentProviderInstance {
  readonly id: StableId;
  readonly providerType: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
  readonly secretRefs: Record<string, string>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ProviderInstanceRow {
  [column: string]: unknown;
  id: string;
  provider_type: string;
  name: string;
  enabled: boolean;
  config: unknown;
  secret_refs: unknown;
  created_at: Date;
  updated_at: Date;
}

function rowToInstance(row: ProviderInstanceRow): PaymentProviderInstance {
  return {
    id: row.id as StableId,
    providerType: row.provider_type,
    name: row.name,
    enabled: row.enabled,
    config: (row.config ?? {}) as Record<string, unknown>,
    secretRefs: (row.secret_refs ?? {}) as Record<string, string>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SECRET_SHAPED_KEY =
  /(^|_)(password|passwd|secret|api_?key|access_?token|credential_?s?)$|(^|_)secrets?($|_)/i;

export function createPaymentProviderInstanceService(deps: {
  pool: DbPool;
  clock: Clock;
  /** provider_type → configSchema (from the provider registry). */
  configSchemaFor: (providerType: string) => Record<string, unknown> | undefined;
}) {
  const { pool, clock, configSchemaFor } = deps;

  function validate(providerType: string, config: Record<string, unknown>): void {
    const schema = configSchemaFor(providerType);
    if (schema === undefined) {
      throw new PaymentError(
        "PAYMENT_PROVIDER_UNKNOWN",
        `provider type "${providerType}" is not registered`,
      );
    }
    const issues = validateAgainstSchema(schema, config, "config");
    if (issues.length > 0) {
      throw new PaymentError("PAYMENT_REQUEST_INVALID", "provider config failed validation", {
        details: { issues },
      });
    }
    for (const key of Object.keys(config)) {
      if (SECRET_SHAPED_KEY.test(key)) {
        throw new PaymentError(
          "PAYMENT_REQUEST_INVALID",
          `config key "${key}" looks like a credential — use secret_refs`,
        );
      }
    }
  }

  return {
    async create(input: {
      readonly providerType: string;
      readonly name: string;
      readonly enabled?: boolean;
      readonly config: Record<string, unknown>;
      readonly secretRefs?: Record<string, string>;
    }): Promise<PaymentProviderInstance> {
      const config = input.config ?? {};
      validate(input.providerType, config);
      for (const [key, value] of Object.entries(input.secretRefs ?? {})) {
        if (typeof value !== "string" || value.length === 0 || value.length > 128) {
          throw new PaymentError(
            "PAYMENT_REQUEST_INVALID",
            `secret ref "${key}" must name a process secret`,
          );
        }
      }
      const result = await pool.query<ProviderInstanceRow>(
        `INSERT INTO payment_provider_instance (id, provider_type, name, enabled, config, secret_refs)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          newStableId(),
          input.providerType,
          input.name,
          input.enabled ?? true,
          JSON.stringify(config),
          JSON.stringify(input.secretRefs ?? {}),
        ],
      );
      return rowToInstance(result.rows[0]!);
    },

    async update(
      id: string,
      patch: {
        readonly name?: string;
        readonly enabled?: boolean;
        readonly config?: Record<string, unknown>;
        readonly secretRefs?: Record<string, string>;
      },
    ): Promise<PaymentProviderInstance> {
      const current = await pool.query<ProviderInstanceRow>(
        `SELECT * FROM payment_provider_instance WHERE id = $1`,
        [id],
      );
      if (current.rows.length !== 1) {
        throw new PaymentError(
          "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND",
          `provider instance ${id} not found`,
        );
      }
      const existing = rowToInstance(current.rows[0]!);
      const config = patch.config ?? existing.config;
      validate(existing.providerType, config);
      const result = await pool.query<ProviderInstanceRow>(
        `UPDATE payment_provider_instance
         SET name = $2, enabled = $3, config = $4, secret_refs = $5, updated_at = $6
         WHERE id = $1 RETURNING *`,
        [
          id,
          patch.name ?? existing.name,
          patch.enabled ?? existing.enabled,
          JSON.stringify(config),
          JSON.stringify(patch.secretRefs ?? existing.secretRefs),
          clock.now(),
        ],
      );
      return rowToInstance(result.rows[0]!);
    },

    async get(id: string): Promise<PaymentProviderInstance | null> {
      const result = await pool.query<ProviderInstanceRow>(
        `SELECT * FROM payment_provider_instance WHERE id = $1`,
        [id],
      );
      return result.rows.length === 1 ? rowToInstance(result.rows[0]!) : null;
    },

    /** Decommission (S6 lifecycle): refused while payments reference the
     * instance (FK) — history is never orphaned. */
    async delete(id: string): Promise<void> {
      const result = await pool.query(`DELETE FROM payment_provider_instance WHERE id = $1`, [id]);
      if (result.rowCount === 0) {
        throw new PaymentError(
          "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND",
          `provider instance ${id} not found`,
        );
      }
    },

    async list(options?: {
      readonly enabled?: boolean;
    }): Promise<readonly PaymentProviderInstance[]> {
      const where = options?.enabled === undefined ? "" : `WHERE enabled = $1`;
      const params = options?.enabled === undefined ? [] : [options.enabled];
      const result = await pool.query<ProviderInstanceRow>(
        `SELECT * FROM payment_provider_instance ${where} ORDER BY name`,
        params,
      );
      return result.rows.map(rowToInstance);
    },
  };
}

export type PaymentProviderInstanceService = ReturnType<
  typeof createPaymentProviderInstanceService
>;
