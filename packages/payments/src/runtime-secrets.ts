// Instance credential store (CORE-PAYMENTS-ADMIN-CONFIG-01, migration 0008).
//
// Admin-managed merchant credentials for ONE payment provider connection:
// write-only, encrypted at rest (AES-256-GCM through the injected structural
// secret box — the Integration Hub / extension runtime-secret precedent),
// keyed by the instance UUID and the provider's declared secret slot. The
// namespace is the UUID, never the provider type or extension id: two
// merchant connections of one provider type own independent credentials and
// uninstalling an extension never deletes payment history's keys.
//
// The encryption key is the deployment master key
// (integrations.runtimeSecretsEncryptionKeySecretRef) — it is NEVER stored
// next to the ciphertext or accepted from the Admin form. This module is
// crypto-agnostic: it accepts any box with encrypt/decrypt.
import type { DbClient, DbPool } from "@pcms/core";
import { PaymentError } from "./errors.js";

/** Structural secret box (same shape as @pcms/auth's SecretBox). */
export interface PaymentSecretBox {
  encrypt(plaintext: string): Buffer;
  decrypt(blob: Buffer): string;
}

/** Executor: the pool itself or a client inside an open transaction. */
export type SqlExecutor = DbPool | DbClient;

export interface StoredCredential {
  [column: string]: unknown;
  readonly slot: string;
  readonly valueEnc: Buffer;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

function requireBox(box: PaymentSecretBox | undefined): PaymentSecretBox {
  if (box === undefined) {
    throw new PaymentError(
      "PAYMENT_CREDENTIALS_KEY_MISSING",
      "payment credentials require the deployment master encryption key (integrations.runtimeSecretsEncryptionKeySecretRef) — an operator restores it; it is never entered in the Admin form",
    );
  }
  return box;
}

/** Stores (or replaces) one slot inside the caller's transaction. */
export async function putInstanceCredential(
  executor: SqlExecutor,
  box: PaymentSecretBox | undefined,
  input: {
    readonly instanceId: string;
    readonly slot: string;
    readonly value: string;
    readonly actor: string;
    readonly now: Date;
  },
): Promise<void> {
  const enc = requireBox(box).encrypt(input.value);
  await executor.query(
    `INSERT INTO payment_provider_runtime_secret (instance_id, slot, value_enc, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (instance_id, slot)
     DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [input.instanceId, input.slot, enc, input.now, input.actor],
  );
}

/**
 * Inserts one slot ONLY when it does not exist yet (the legacy importer must
 * never overwrite a value the operator saved meanwhile). Returns whether the
 * row was written.
 */
export async function insertInstanceCredential(
  executor: SqlExecutor,
  box: PaymentSecretBox,
  input: {
    readonly instanceId: string;
    readonly slot: string;
    readonly value: string;
    readonly actor: string;
    readonly now: Date;
  },
): Promise<boolean> {
  const enc = box.encrypt(input.value);
  const result = await executor.query(
    `INSERT INTO payment_provider_runtime_secret (instance_id, slot, value_enc, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (instance_id, slot) DO NOTHING`,
    [input.instanceId, input.slot, enc, input.now, input.actor],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Removes one slot inside the caller's transaction; returns whether a row existed. */
export async function deleteInstanceCredential(
  executor: SqlExecutor,
  input: { readonly instanceId: string; readonly slot: string },
): Promise<boolean> {
  const result = await executor.query(
    `DELETE FROM payment_provider_runtime_secret WHERE instance_id = $1 AND slot = $2`,
    [input.instanceId, input.slot],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Presence-only listing: slot names + timestamps, never values and never
 * ciphertext (safe for API responses and the Admin DOM). */
export async function listInstanceCredentialSlots(
  executor: SqlExecutor,
  instanceId: string,
): Promise<readonly { readonly slot: string; readonly updatedAt: Date }[]> {
  const result = await executor.query<{ slot: string; updated_at: Date }>(
    `SELECT slot, updated_at FROM payment_provider_runtime_secret WHERE instance_id = $1 ORDER BY slot`,
    [instanceId],
  );
  return result.rows.map((row) => ({ slot: row.slot, updatedAt: row.updated_at }));
}

/**
 * Raw stored rows of ONE instance (names only until decrypted). A missing
 * box is reported as null: callers surface PAYMENT_CREDENTIALS_KEY_MISSING
 * instead of pretending "not configured".
 */
export async function loadInstanceCredentials(
  executor: SqlExecutor,
  box: PaymentSecretBox | undefined,
  instanceId: string,
): Promise<readonly StoredCredential[] | null> {
  if (box === undefined) return null;
  const result = await executor.query<StoredCredential>(
    `SELECT slot, value_enc AS "valueEnc", updated_at AS "updatedAt", updated_by AS "updatedBy"
     FROM payment_provider_runtime_secret WHERE instance_id = $1 ORDER BY slot`,
    [instanceId],
  );
  return result.rows;
}

/** Decrypts every stored slot of one instance (one query, in memory only).
 * A slot that cannot be decrypted is reported, never guessed, never
 * substituted from another connection. */
export function decryptInstanceCredentials(
  box: PaymentSecretBox,
  rows: readonly StoredCredential[],
): { readonly values: Readonly<Record<string, string>>; readonly unreadable: readonly string[] } {
  const values: Record<string, string> = {};
  const unreadable: string[] = [];
  for (const row of rows) {
    try {
      values[row.slot] = box.decrypt(Buffer.from(row.valueEnc));
    } catch {
      unreadable.push(row.slot);
    }
  }
  return { values, unreadable };
}
