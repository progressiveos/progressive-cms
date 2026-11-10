// Legacy credential import (CORE-PAYMENTS-ADMIN-CONFIG-01 §10.1, reworked for
// review R2).
//
// Before migration 0008 merchant credentials were process secrets referenced
// by NAME in payment_provider_instance.secret_refs. The encrypted per-instance
// store is the ONLY source afterwards; the importer resolves the old
// references in memory and retires them.
//
// Correctness rules (review R2):
//   - the preflight plan is INFORMATIONAL: the decision for each connection is
//     taken under that connection's row lock, re-reading its runtime slots;
//   - an existing runtime value ALWAYS wins — the importer never overwrites a
//     credential the operator saved, before or during the run;
//   - a reference whose slot already has a runtime value is retired too, so a
//     half-migrated connection can finish without restoring operator files;
//   - every instance is one transaction: its imports, its reference retirement,
//     its generation bump and its audit row commit together or not at all;
//   - an unresolvable reference blocks the WHOLE run (no half-migrated
//     connection, and the caller sees which connection needs attention);
//   - no value, prefix, length or ciphertext ever appears in a plan or report.
import type { Clock, DbClient, DbPool } from "@pcms/core";
import { PaymentError } from "./errors.js";
import { insertInstanceCredential, type PaymentSecretBox } from "./runtime-secrets.js";

export interface LegacyRefPlan {
  readonly instance_id: string;
  readonly name: string;
  readonly provider_type: string;
  /** "import" = references to resolve and/or retire; "skip" = nothing to do;
   * "blocked" = a reference cannot be resolved. */
  readonly action: "import" | "skip" | "blocked";
  readonly slots: readonly {
    readonly slot: string;
    readonly status: "ready" | "missing" | "already";
  }[];
  /** Safe reason (slot names only). */
  readonly reason: string | null;
}

export interface ImportPlan {
  readonly encryption_key_available: boolean;
  readonly instances: readonly LegacyRefPlan[];
  readonly importable: number;
  readonly blocked: number;
  readonly skipped: number;
  /** Process-secret names that will no longer be needed after the import. */
  readonly stale_refs: readonly string[];
}

export interface ImportResult {
  readonly imported_instances: readonly string[];
  readonly skipped_instances: readonly string[];
  readonly blocked_instances: readonly string[];
  readonly stale_refs: readonly string[];
}

interface InstanceRow {
  [column: string]: unknown;
  id: string;
  name: string;
  provider_type: string;
  secret_refs: Record<string, string>;
}

interface SlotDecision {
  readonly slot: string;
  readonly status: "ready" | "missing" | "already";
  readonly value?: string;
}

interface InstanceDecision {
  readonly slots: readonly SlotDecision[];
  readonly missing: readonly string[];
  /** Slots whose reference is retired once the decision is applied. */
  readonly retire: readonly string[];
  readonly importCount: number;
}

export function createLegacyCredentialImport(deps: {
  pool: DbPool;
  clock: Clock;
  box: () => PaymentSecretBox | undefined;
  legacyResolver: ((name: string) => string | undefined) | undefined;
  /** Audit writer executed inside the instance transaction (review R7). */
  readonly audit?: (
    tx: DbClient,
    info: {
      readonly instanceId: string;
      readonly name: string;
      readonly slots: readonly string[];
      readonly retired: readonly string[];
    },
  ) => Promise<void>;
}) {
  const { pool, clock, box, legacyResolver } = deps;

  async function loadInstances(executor: DbClient | DbPool): Promise<readonly InstanceRow[]> {
    const result = await executor.query<InstanceRow>(
      `SELECT id, name, provider_type, secret_refs FROM payment_provider_instance
       WHERE secret_refs <> '{}'::jsonb ORDER BY name`,
    );
    return result.rows;
  }

  async function runtimeSlots(
    executor: DbClient | DbPool,
    instanceId: string,
  ): Promise<Set<string>> {
    const result = await executor.query<{ slot: string }>(
      "SELECT slot FROM payment_provider_runtime_secret WHERE instance_id = $1",
      [instanceId],
    );
    return new Set(result.rows.map((row) => row.slot));
  }

  /**
   * Decides what happens to ONE connection, given its current refs and the
   * runtime slots visible to this executor. Pure: no writes.
   */
  function decide(instance: InstanceRow, have: Set<string>): InstanceDecision {
    const slots: SlotDecision[] = [];
    const missing: string[] = [];
    const retire: string[] = [];
    let importCount = 0;
    for (const [slot, refName] of Object.entries(instance.secret_refs ?? {})) {
      if (have.has(slot)) {
        // Runtime value already exists: it wins and the reference is retired.
        slots.push({ slot, status: "already" });
        retire.push(slot);
        continue;
      }
      const value = legacyResolver?.(refName);
      if (value === undefined || value === "") {
        slots.push({ slot, status: "missing" });
        missing.push(slot);
        continue;
      }
      slots.push({ slot, status: "ready", value });
      retire.push(slot);
      importCount += 1;
    }
    return { slots, missing, retire, importCount };
  }

  function planEntry(instance: InstanceRow, decision: InstanceDecision): LegacyRefPlan {
    if (decision.missing.length > 0) {
      return {
        instance_id: instance.id,
        name: instance.name,
        provider_type: instance.provider_type,
        action: "blocked",
        slots: decision.slots.map(({ slot, status }) => ({ slot, status })),
        reason: `cannot resolve ${decision.missing.join(", ")} — restore the deployment secret or save the credential in Admin, then run the import again`,
      };
    }
    if (decision.retire.length === 0) {
      return {
        instance_id: instance.id,
        name: instance.name,
        provider_type: instance.provider_type,
        action: "skip",
        slots: decision.slots.map(({ slot, status }) => ({ slot, status })),
        reason: "no legacy references",
      };
    }
    return {
      instance_id: instance.id,
      name: instance.name,
      provider_type: instance.provider_type,
      action: "import",
      slots: decision.slots.map(({ slot, status }) => ({ slot, status })),
      reason: null,
    };
  }

  return {
    /** Inventory WITHOUT values: what would be imported/retired, what is
     * blocked and which process-secret names become unused. Informational —
     * `run()` re-decides per connection under its row lock. */
    async preflight(): Promise<ImportPlan> {
      const instances = await loadInstances(pool);
      const plans: LegacyRefPlan[] = [];
      const stale = new Set<string>();
      for (const instance of instances) {
        const have = await runtimeSlots(pool, instance.id);
        const decision = decide(instance, have);
        const entry = planEntry(instance, decision);
        // Only references that will really be retired become stale names.
        if (entry.action === "import") {
          for (const slot of decision.retire) {
            const refName = instance.secret_refs[slot];
            if (refName !== undefined) stale.add(refName);
          }
        }
        plans.push(entry);
      }
      return {
        encryption_key_available: box() !== undefined,
        instances: plans,
        importable: plans.filter((plan) => plan.action === "import").length,
        blocked: plans.filter((plan) => plan.action === "blocked").length,
        skipped: plans.filter((plan) => plan.action === "skip").length,
        stale_refs: [...stale].sort(),
      };
    },

    /**
     * Runs the import. Fail-closed BEFORE any write when the master key is
     * absent or any reference cannot be resolved; each connection is then
     * applied atomically under its row lock.
     */
    async run(options?: { readonly instanceIds?: readonly string[] }): Promise<ImportResult> {
      const secretBox = box();
      if (secretBox === undefined) {
        throw new PaymentError(
          "PAYMENT_CREDENTIALS_KEY_MISSING",
          "the deployment master key is missing — the legacy payment credentials cannot be encrypted; restore integrations.runtimeSecretsEncryptionKeySecretRef and run the import again",
        );
      }
      const candidates = await loadInstances(pool);
      const wanted =
        options?.instanceIds === undefined
          ? candidates
          : candidates.filter((entry) => options.instanceIds?.includes(entry.id));

      // Fail-closed pre-check: report every blocked connection before touching
      // any of them.
      const blocked: string[] = [];
      for (const candidate of wanted) {
        const have = await runtimeSlots(pool, candidate.id);
        if (decide(candidate, have).missing.length > 0) blocked.push(candidate.id);
      }
      if (blocked.length > 0) {
        const names = wanted
          .filter((entry) => blocked.includes(entry.id))
          .map((entry) => `"${entry.name}"`);
        throw new PaymentError(
          "PAYMENT_CREDENTIALS_INCOMPLETE",
          `import refused: ${names.join(", ")} still reference deployment secrets that cannot be resolved`,
          { details: { blocked } },
        );
      }

      const imported: string[] = [];
      const skipped: string[] = [];
      const stale = new Set<string>();
      for (const candidate of wanted) {
        // The decision is re-taken under the row lock: a concurrent Admin save
        // (new runtime value, cleared slot) is observed and never overwritten.
        const outcome = await pool.withTransaction(async (tx) => {
          const locked = await tx.query<InstanceRow>(
            `SELECT id, name, provider_type, secret_refs FROM payment_provider_instance
             WHERE id = $1 FOR UPDATE`,
            [candidate.id],
          );
          const row = locked.rows[0];
          if (row === undefined) return { kind: "skipped" as const };
          const have = await runtimeSlots(tx, row.id);
          const decision = decide(row, have);
          if (decision.missing.length > 0) {
            throw new PaymentError(
              "PAYMENT_CREDENTIALS_INCOMPLETE",
              `import refused for "${row.name}": ${decision.missing.join(", ")} cannot be resolved`,
              { details: { slots: decision.missing } },
            );
          }
          if (decision.retire.length === 0) return { kind: "skipped" as const };

          const written: string[] = [];
          for (const slot of decision.slots) {
            if (slot.status !== "ready" || slot.value === undefined) continue;
            const inserted = await insertInstanceCredential(tx, secretBox, {
              instanceId: row.id,
              slot: slot.slot,
              value: slot.value,
              actor: "system:payment-credential-import",
              now: clock.now(),
            });
            // A concurrent save may have written the slot between the pre-check
            // and this lock; the runtime value wins and the ref is still retired.
            if (inserted) written.push(slot.slot);
          }
          const refs = { ...row.secret_refs };
          const retired: string[] = [];
          for (const slot of decision.retire) {
            if (refs[slot] === undefined) continue;
            stale.add(refs[slot] as string);
            delete refs[slot];
            retired.push(slot);
          }
          await tx.query(
            `UPDATE payment_provider_instance SET secret_refs = $2::jsonb,
               settings_generation = settings_generation + 1, updated_at = $3 WHERE id = $1`,
            [row.id, JSON.stringify(refs), clock.now()],
          );
          await deps.audit?.(tx, {
            instanceId: row.id,
            name: row.name,
            slots: written,
            retired,
          });
          return { kind: "imported" as const };
        });
        if (outcome.kind === "imported") imported.push(candidate.id);
        else skipped.push(candidate.id);
      }
      return {
        imported_instances: imported,
        skipped_instances: skipped,
        blocked_instances: [],
        stale_refs: [...stale].sort(),
      };
    },
  };
}

export type LegacyCredentialImport = ReturnType<typeof createLegacyCredentialImport>;
