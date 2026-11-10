// Atomic provider-instance settings (CORE-PAYMENTS-ADMIN-CONFIG-01).
//
// One human "Save" = one transaction: name/config/enabled, explicit credential
// set/clear operations, the settings generation and the audit trail commit
// together or not at all. No provider network call ever runs inside that
// transaction. Every mutation is guarded by the instance row lock, so two
// editors serialize, and by an optional expected generation, so a stale
// editor gets a typed conflict instead of silently overwriting a newer key.
//
// Business fields stay in payment_provider_instance.config; credential VALUES
// are encrypted in payment_provider_runtime_secret (runtime-secrets.ts). The
// generic extension secret store is NOT reused: its namespace is the extension
// id, and one extension serves several merchant connections.
import type { Clock, DbClient, DbPool } from "@pcms/core";
import {
  assertTrustedEndpointValue,
  ENDPOINT_CONFIG_KEYS,
  endpointPolicyIssues,
} from "./endpoint-policy.js";
import { PaymentError } from "./errors.js";
import { CREATE_CLAIM_KEY, PROVIDER_ATTEMPT_KEY } from "./payments.js";
import {
  credentialValueIssues,
  evaluateInstanceReadiness,
  type InstanceReadiness,
} from "./readiness.js";
import {
  decryptInstanceCredentials,
  deleteInstanceCredential,
  listInstanceCredentialSlots,
  loadInstanceCredentials,
  putInstanceCredential,
} from "./runtime-secrets.js";
import type { PaymentProvider } from "./providers.js";
import {
  type PaymentProviderInstance,
  type PaymentProviderInstanceService,
  rowToInstance,
} from "./provider-instances.js";

/** Config keys that select the provider ENVIRONMENT (production/sandbox).
 * Changing one on a connection that already has payment history would send a
 * later refund/cancel to the other environment — refused, not silently
 * migrated. */
export const ENVIRONMENT_BEARING_CONFIG_KEYS: readonly string[] = ["apiBase", "gatewayUrl"];
/** Payments/refund states that still need this connection's credentials. */
const OPEN_PAYMENT_STATUSES = ["CREATED", "PENDING"] as const;
const OPEN_REFUND_STATUSES = ["REQUESTED", "SUBMITTED", "NEEDS_REVIEW"] as const;

export interface SecretSlotView {
  readonly slot: string;
  readonly configured: boolean;
  /** Where the value comes from; "legacy" = import still pending. */
  readonly source: "runtime" | "legacy" | null;
  readonly updated_at: string | null;
}

export interface InstanceSettingsView {
  readonly instance: {
    readonly id: string;
    readonly provider_type: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly config: Record<string, unknown>;
    readonly settings_generation: number;
    readonly updated_at: string;
  };
  readonly provider_type: string;
  /** Adapter schema/requirements (UI metadata — never values). */
  readonly config_schema: Record<string, unknown> | null;
  readonly secret_requirements: readonly string[];
  readonly slots: readonly SecretSlotView[];
  readonly readiness: InstanceReadiness;
  readonly secret_box: { readonly available: boolean; readonly code?: string };
  /** Explicit "this adapter cannot receive settings" signal for the UI. */
  readonly config_supported: boolean;
}

export type SecretUpdate =
  | { readonly action: "set"; readonly value: string }
  | { readonly action: "clear" };

export interface SettingsUpdateInput {
  readonly expectedGeneration?: number;
  readonly name?: string;
  readonly config?: Record<string, unknown>;
  readonly enabled?: boolean;
  /** Slot → operation. Absent map = credentials untouched; a slot absent from
   * the map is untouched too. Unknown slots are rejected, never ignored. */
  readonly secretUpdates?: Readonly<Record<string, SecretUpdate>>;
}

/** Safe, value-free description of what one save changed. */
export interface SettingsAuditSummary {
  readonly name: string;
  readonly enabled: boolean;
  readonly settings_generation: number;
  readonly changed_slots: readonly string[];
  readonly cleared_slots: readonly string[];
}

export interface SettingsUpdateResult {
  readonly view: InstanceSettingsView;
  /** Slots whose runtime value changed in this save (names only). */
  readonly changedSlots: readonly string[];
  readonly clearedSlots: readonly string[];
}

const SETTINGS_KEYS = new Set([
  "expected_generation",
  "name",
  "config",
  "secret_updates",
  "enabled",
]);

export function createPaymentSettingsService(deps: {
  pool: DbPool;
  clock: Clock;
  instances: PaymentProviderInstanceService;
  providerFor: (providerType: string) => PaymentProvider | undefined;
  /** Deployment master key box; undefined = key absent. */
  box: () => import("./runtime-secrets.js").PaymentSecretBox | undefined;
}) {
  const { pool, clock, instances, providerFor, box } = deps;

  function requireProvider(providerType: string): PaymentProvider {
    const provider = providerFor(providerType);
    if (provider === undefined) {
      throw new PaymentError(
        "PAYMENT_PROVIDER_UNKNOWN",
        "provider type is not composed (extension disabled or absent)",
      );
    }
    return provider;
  }

  async function readInstance(executor: DbClient | DbPool, id: string, forUpdate: boolean) {
    const result = await executor.query(
      `SELECT * FROM payment_provider_instance WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new PaymentError(
        "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND",
        `provider instance ${id} not found`,
      );
    }
    return rowToInstance(row as never);
  }

  async function buildView(
    executor: DbClient | DbPool,
    instance: PaymentProviderInstance,
  ): Promise<InstanceSettingsView> {
    const provider = providerFor(instance.providerType);
    const readiness = await evaluateInstanceReadiness(executor, box(), {
      instance,
      provider,
    });
    const stored = await listInstanceCredentialSlots(executor, instance.id);
    const storedBySlot = new Map(stored.map((row) => [row.slot, row.updatedAt]));
    const slots: SecretSlotView[] = [...(provider?.secretRequirements ?? [])].map((slot) => {
      const runtime = storedBySlot.get(slot);
      const legacy = instance.secretRefs[slot] !== undefined;
      return {
        slot,
        configured: runtime !== undefined || legacy,
        source: runtime !== undefined ? "runtime" : legacy ? "legacy" : null,
        updated_at: runtime === undefined ? null : runtime.toISOString(),
      };
    });
    for (const row of stored) {
      if (slots.some((slot) => slot.slot === row.slot)) continue;
      // A slot stored by an older adapter version is still reported (never
      // its value) so the operator can see and clear it.
      slots.push({
        slot: row.slot,
        configured: true,
        source: "runtime",
        updated_at: row.updatedAt.toISOString(),
      });
    }
    return {
      instance: {
        id: instance.id,
        provider_type: instance.providerType,
        name: instance.name,
        enabled: instance.enabled,
        config: instance.config,
        settings_generation: instance.settingsGeneration,
        updated_at: instance.updatedAt.toISOString(),
      },
      provider_type: instance.providerType,
      config_schema: provider?.configSchema ?? null,
      secret_requirements: provider?.secretRequirements ?? [],
      slots,
      readiness,
      secret_box:
        box() === undefined
          ? { available: false, code: "PAYMENT_CREDENTIALS_KEY_MISSING" }
          : { available: true },
      config_supported: provider === undefined ? false : provider.withConfig !== undefined,
    };
  }

  /** Strict wire-shape validation: unknown keys are refused (never silently
   * dropped), so a client cannot smuggle fields the server would ignore. */
  function assertUpdateShape(raw: unknown): SettingsUpdateInput {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new PaymentError("PAYMENT_REQUEST_INVALID", "settings body must be a JSON object");
    }
    const record = raw as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!SETTINGS_KEYS.has(key)) {
        throw new PaymentError("PAYMENT_REQUEST_INVALID", `unknown settings field "${key}"`);
      }
    }
    const out: {
      expectedGeneration?: number;
      name?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
      secretUpdates?: Record<string, SecretUpdate>;
    } = {};
    if (record["expected_generation"] !== undefined) {
      const value = record["expected_generation"];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new PaymentError(
          "PAYMENT_REQUEST_INVALID",
          "expected_generation must be a non-negative integer",
        );
      }
      out.expectedGeneration = value;
    }
    if (record["name"] !== undefined) {
      const value = record["name"];
      if (typeof value !== "string" || value.trim() === "" || value.length > 120) {
        throw new PaymentError("PAYMENT_REQUEST_INVALID", "name must be 1–120 characters");
      }
      out.name = value.trim();
    }
    if (record["config"] !== undefined) {
      const value = record["config"];
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PaymentError("PAYMENT_REQUEST_INVALID", "config must be a JSON object");
      }
      out.config = value as Record<string, unknown>;
    }
    if (record["enabled"] !== undefined) {
      if (typeof record["enabled"] !== "boolean") {
        throw new PaymentError("PAYMENT_REQUEST_INVALID", "enabled must be a boolean");
      }
      out.enabled = record["enabled"];
    }
    if (record["secret_updates"] !== undefined) {
      const value = record["secret_updates"];
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PaymentError("PAYMENT_REQUEST_INVALID", "secret_updates must be a JSON object");
      }
      const updates: Record<string, SecretUpdate> = {};
      for (const [slot, operation] of Object.entries(value as Record<string, unknown>)) {
        if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
          throw new PaymentError(
            "PAYMENT_REQUEST_INVALID",
            `secret_updates.${slot} must be an object with an "action"`,
          );
        }
        const op = operation as Record<string, unknown>;
        for (const key of Object.keys(op)) {
          if (key !== "action" && key !== "value") {
            throw new PaymentError(
              "PAYMENT_REQUEST_INVALID",
              `unknown field "${key}" in secret_updates.${slot}`,
            );
          }
        }
        if (op["action"] === "clear") {
          if (op["value"] !== undefined) {
            throw new PaymentError(
              "PAYMENT_REQUEST_INVALID",
              `secret_updates.${slot}: "clear" does not take a value`,
            );
          }
          updates[slot] = { action: "clear" };
        } else if (op["action"] === "set") {
          const issues = credentialValueIssues(slot, op["value"]);
          if (issues.length > 0) {
            // Issues name the slot and the rule, never the value.
            throw new PaymentError("PAYMENT_REQUEST_INVALID", issues.join("; "));
          }
          updates[slot] = { action: "set", value: op["value"] as string };
        } else {
          throw new PaymentError(
            "PAYMENT_REQUEST_INVALID",
            `secret_updates.${slot}: action must be "set" or "clear"`,
          );
        }
      }
      out.secretUpdates = updates;
    }
    return out;
  }
  async function hasPaymentHistory(
    executor: DbClient | DbPool,
    instanceId: string,
  ): Promise<boolean> {
    const result = await executor.query(
      `SELECT 1 FROM payment WHERE provider_instance_id = $1 LIMIT 1`,
      [instanceId],
    );
    return result.rows.length > 0;
  }

  /**
   * Did ANY provider call possibly leave this connection? Conservative by
   * construction: an external id, any status other than CREATED, the
   * pre-create claim marker (an attempt whose outcome may be unknown) or any
   * refund row all count. Only "nothing was ever submitted" answers false.
   */
  async function providerContact(
    executor: DbClient | DbPool,
    instanceId: string,
  ): Promise<{ readonly any: boolean; readonly reason: string | null }> {
    const payments = await executor.query<{
      total: string;
      external: string;
      non_created: string;
      attempted: string;
    }>(
      // Independent signals of an external attempt:
      //  - the durable first-attempt timestamp (written with the claim, never
      //    removed — review M1: a released claim is not proof of "unsent");
      //  - a claim token still held (an attempt in flight right now);
      //  - NO claim key at all: the older release deleted the whole key after a
      //    retryable failure and left no marker, so such a row is an unknown
      //    outcome, not a fresh payment (review B4). A fresh intent always
      //    carries {ready:true}.
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE external_payment_id IS NOT NULL)::text AS external,
              count(*) FILTER (WHERE status <> 'CREATED')::text AS non_created,
              count(*) FILTER (
                WHERE metadata ? $3
                   OR metadata #>> ARRAY[$2, 'token'] IS NOT NULL
                   OR NOT (metadata ? $2)
              )::text AS attempted
       FROM payment WHERE provider_instance_id = $1`,
      [instanceId, CREATE_CLAIM_KEY, PROVIDER_ATTEMPT_KEY],
    );
    const row = payments.rows[0];
    if (row !== undefined) {
      if (Number(row.external) > 0) return { any: true, reason: "an external payment id" };
      if (Number(row.non_created) > 0) return { any: true, reason: "a provider-answered payment" };
      if (Number(row.attempted) > 0)
        return { any: true, reason: "a create attempt with unknown outcome" };
    }
    const refunds = await executor.query(
      "SELECT 1 FROM payment_refund WHERE provider_instance_id = $1 LIMIT 1",
      [instanceId],
    );
    if (refunds.rows.length > 0) return { any: true, reason: "a refund intent" };
    return { any: false, reason: null };
  }

  async function hasOpenMoneyOperations(
    executor: DbClient | DbPool,
    instanceId: string,
  ): Promise<{ readonly payments: boolean; readonly refunds: boolean }> {
    const payments = await executor.query(
      `SELECT 1 FROM payment WHERE provider_instance_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
      [instanceId, OPEN_PAYMENT_STATUSES],
    );
    const refunds = await executor.query(
      `SELECT 1 FROM payment_refund WHERE provider_instance_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
      [instanceId, OPEN_REFUND_STATUSES],
    );
    return { payments: payments.rows.length > 0, refunds: refunds.rows.length > 0 };
  }

  return {
    /** Safe settings projection for the Admin form: schema, ordinary values,
     * generation, slot PRESENCE, readiness. Never a value, ciphertext or
     * fragment of one. */
    async get(id: string): Promise<InstanceSettingsView> {
      const instance = await readInstance(pool, id, false);
      return buildView(pool, instance);
    },

    /** Atomic save. Absent fields are unchanged; an absent secret_updates map
     * leaves every credential untouched. */
    async save(
      id: string,
      rawInput: unknown,
      options?: {
        readonly actor?: string;
        /** Audit writer executed INSIDE the same transaction (review R7): the
         * security event commits with the settings or not at all. Receives the
         * safe change summary (slot NAMES only). */
        readonly audit?: (tx: DbClient, summary: SettingsAuditSummary) => Promise<void>;
      },
    ): Promise<SettingsUpdateResult> {
      const input = assertUpdateShape(rawInput);
      const actor = options?.actor ?? "system";
      const result = await pool.withTransaction(async (tx) => {
        // Serialize concurrent editors of THIS connection (and the generation
        // below turns a stale editor into a typed 409).
        const current = await readInstance(tx, id, true);
        if (
          input.expectedGeneration !== undefined &&
          input.expectedGeneration !== current.settingsGeneration
        ) {
          throw new PaymentError(
            "PAYMENT_SETTINGS_CONFLICT",
            "settings were changed by another editor — reload the form and reapply your change",
            {
              details: {
                expected_generation: input.expectedGeneration,
                current_generation: current.settingsGeneration,
              },
            },
          );
        }
        const provider = requireProvider(current.providerType);
        const config = input.config ?? current.config;
        instances.validate(current.providerType, config);
        if (provider.withConfig === undefined && Object.keys(config).length > 0) {
          throw new PaymentError(
            "PAYMENT_PROVIDER_CONFIG_UNSUPPORTED",
            "this provider package cannot receive instance settings — update the payment extension",
          );
        }
        // Review R3: a saved credential must never be redirected to an
        // unverified host by a config edit. The allowed origins are declared
        // by the adapter itself; an adapter that declares none cannot be
        // pointed anywhere else than its built-in default.
        for (const key of ENDPOINT_CONFIG_KEYS) {
          const value = config[key];
          if (value === undefined) continue;
          assertTrustedEndpointValue(provider, key, value);
        }
        // Environment changes are not a rotation: a refund/status call must
        // never travel to another environment under an old instance.
        //
        // Review R3 (third pass): a stored endpoint the package does not trust
        // may be REPAIRED, but only to an environment that is provably the one
        // the history ran in — an untrusted old value proves nothing about
        // where money actually went. Two admissible cases:
        //   a) no provider contact was ever possible on this connection (the
        //      local guard stopped every attempt before I/O);
        //   b) the target is the package's pre-policy DEFAULT origin, which is
        //      where historical calls went while instance config was ignored.
        // Anything else (external id, non-CREATED status, an attempted create
        // with unknown outcome, any refund) keeps the environment frozen.
        if (await hasPaymentHistory(tx, id)) {
          for (const key of ENVIRONMENT_BEARING_CONFIG_KEYS) {
            const before = current.config[key];
            const after = config[key];
            if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue;
            const legacyUntrusted = endpointPolicyIssues(provider, { [key]: before }).length > 0;
            if (!legacyUntrusted) {
              throw new PaymentError(
                "PAYMENT_REQUEST_INVALID",
                `"${key}" cannot change on a connection that already has payment history — create a separate connection for the other environment`,
              );
            }
            const contact = await providerContact(tx, id);
            if (!contact.any) continue;
            const targetOrigin =
              typeof after === "string" && after.trim() !== ""
                ? (() => {
                    try {
                      return new URL(after).origin;
                    } catch {
                      return null;
                    }
                  })()
                : null;
            const provablyEquivalent =
              targetOrigin !== null &&
              (provider.defaultEndpointOrigins ?? []).includes(targetOrigin);
            if (provablyEquivalent) continue;
            throw new PaymentError(
              "PAYMENT_REQUEST_INVALID",
              `"${key}" cannot be moved to another environment: this connection already reached the provider (${contact.reason}), so its historical payments belong to that environment — restore the package default endpoint, or create a separate connection for the new environment and keep this one for history and reconciliation`,
              { details: { key, reason: contact.reason, target_origin: targetOrigin } },
            );
          }
        }
        const updates = input.secretUpdates ?? {};
        const declared = new Set(provider.secretRequirements);
        for (const slot of Object.keys(updates)) {
          if (!declared.has(slot)) {
            throw new PaymentError(
              "PAYMENT_REQUEST_INVALID",
              `"${slot}" is not a credential slot of provider type "${current.providerType}"`,
            );
          }
        }
        // Review R4 (second pass): the invariant is "a connection UUID with
        // payment history belongs to ONE merchant account". Clearing the
        // identity slot and then setting another account bypassed the earlier
        // check, so with ANY history: clearing an identity slot is refused,
        // and a set is accepted only when the stored identity is readable AND
        // identical. An absent/unreadable identity cannot be verified, so it
        // is never replaced silently — the supported path is a new connection.
        const identitySlots = new Set(provider.merchantIdentitySlots ?? []);
        const identityOps = Object.entries(updates).filter(([slot]) => identitySlots.has(slot));
        if (identityOps.length > 0 && (await hasPaymentHistory(tx, id))) {
          const stored = await loadInstanceCredentials(tx, box(), id);
          for (const [slot, operation] of identityOps) {
            if (operation.action === "clear") {
              throw new PaymentError(
                "PAYMENT_REQUEST_INVALID",
                `"${slot}" identifies the merchant account of a connection that already has payment history — it cannot be removed; create a new connection for the other account and keep this one for history and reconciliation`,
                { details: { slot } },
              );
            }
            const row = stored?.find((entry) => entry.slot === slot);
            if (row === undefined) {
              throw new PaymentError(
                "PAYMENT_REQUEST_INVALID",
                `"${slot}" identifies the merchant account of a connection that already has payment history and its current value is not stored — the account cannot be verified, so it is not replaced silently; create a new connection for another account`,
                { details: { slot, reason: "identity_unverifiable" } },
              );
            }
            const decrypted =
              box() === undefined ? undefined : decryptInstanceCredentials(box()!, [row]);
            if (decrypted === undefined || decrypted.unreadable.length > 0) {
              throw new PaymentError(
                "PAYMENT_CREDENTIALS_UNREADABLE",
                `"${slot}" cannot be decrypted with the current key, so the merchant account of this historical connection cannot be verified — restore the key before changing it`,
                { details: { slot } },
              );
            }
            if (decrypted.values[slot] !== operation.value) {
              throw new PaymentError(
                "PAYMENT_REQUEST_INVALID",
                `"${slot}" identifies the merchant account and cannot change on a connection that already has payment history — create a new connection for the other account and keep this one for history and reconciliation`,
                { details: { slot } },
              );
            }
          }
        }

        const clearingRequired = Object.entries(updates)
          .filter(([slot, op]) => op.action === "clear" && declared.has(slot))
          .map(([slot]) => slot);
        if (clearingRequired.length > 0) {
          const open = await hasOpenMoneyOperations(tx, id);
          if (open.payments || open.refunds) {
            throw new PaymentError(
              "PAYMENT_REQUEST_INVALID",
              `cannot remove ${clearingRequired.join(", ")} while this connection has unfinished payments or refund intents — finish or reconcile them first`,
              {
                details: {
                  slots: clearingRequired,
                  open_payments: open.payments,
                  open_refunds: open.refunds,
                },
              },
            );
          }
        }
        // Credential writes participate in the SAME transaction: a failure
        // afterwards (schema, readiness, uniqueness) rolls them back too.
        const changedSlots: string[] = [];
        const clearedSlots: string[] = [];
        const now = clock.now();
        for (const [slot, operation] of Object.entries(updates)) {
          if (operation.action === "set") {
            await putInstanceCredential(tx, box(), {
              instanceId: id,
              slot,
              value: operation.value,
              actor,
              now,
            });
            changedSlots.push(slot);
          } else if (await deleteInstanceCredential(tx, { instanceId: id, slot })) {
            clearedSlots.push(slot);
          }
        }
        const next = {
          name: input.name ?? current.name,
          enabled: input.enabled ?? current.enabled,
          config,
        };
        const updated = await tx.query(
          `UPDATE payment_provider_instance
           SET name = $2, enabled = $3, config = $4, updated_at = $5,
               settings_generation = settings_generation + 1
           WHERE id = $1 AND settings_generation = $6
           RETURNING *`,
          [
            id,
            next.name,
            next.enabled,
            JSON.stringify(next.config),
            now,
            current.settingsGeneration,
          ],
        );
        if (updated.rows.length === 0) {
          // Row vanished or a write slipped in despite the lock.
          throw new PaymentError(
            "PAYMENT_SETTINGS_CONFLICT",
            "settings were changed by another editor — reload the form and reapply your change",
          );
        }
        const instance = rowToInstance(updated.rows[0] as never);
        // Review R8: the invariant is about the RESULTING state, not about
        // whether this request happened to carry `enabled: true`. An enabled
        // connection whose credentials/config become incomplete (cleared slot,
        // invalid edit) would keep accepting money while unable to call the
        // provider — so it is a typed refusal that names the way out
        // (send enabled:false in the same save).
        if (instance.enabled) {
          const readiness = await evaluateInstanceReadiness(tx, box(), {
            instance,
            provider,
          });
          if (!readiness.ready) {
            throw new PaymentError(
              readiness.code === "credentials_unreadable"
                ? "PAYMENT_CREDENTIALS_UNREADABLE"
                : readiness.code === "provider_not_composed"
                  ? "PAYMENT_PROVIDER_UNKNOWN"
                  : "PAYMENT_CREDENTIALS_INCOMPLETE",
              `the connection would stay enabled but is not ready: ${readiness.detail} — complete the settings, or disable it in the same save`,
              {
                details: {
                  code: readiness.code,
                  missing: readiness.missing,
                  config_issues: readiness.configIssues,
                },
              },
            );
          }
        }
        // The audit row belongs to THIS transaction (review R7): if it cannot
        // be written, nothing is applied.
        await options?.audit?.(tx, {
          name: instance.name,
          enabled: instance.enabled,
          settings_generation: instance.settingsGeneration,
          changed_slots: changedSlots,
          cleared_slots: clearedSlots,
        });
        return { instance, changedSlots, clearedSlots };
      });
      const view = await buildView(pool, result.instance);
      return {
        view,
        changedSlots: result.changedSlots,
        clearedSlots: result.clearedSlots,
      };
    },
  };
}

export type PaymentSettingsService = ReturnType<typeof createPaymentSettingsService>;
