// Integration Hub runtime secret store (PCMS-OPS-T131; Integrations spec §5).
//
// Generic Admin-managed secret VALUES for connector instances — write-only,
// encrypted at rest (AES-256-GCM via the injected structural secret box, the
// TOTP/managed-SMTP precedent), never returned by any API surface (only the
// stored KEY names are visible). The encryption key lives in the deployment
// secret channel (`integrations.runtimeSecretsEncryptionKeySecretRef`), never
// in the database. Resolution precedence per connector requirement:
//   1. runtime value stored here (Admin-managed),
//   2. the legacy integration_instance.secret_refs env/file reference.
// This module is crypto-agnostic: it accepts a structural box.
import type { DbPool } from "@pcms/core";

/** Structural secret box (same shape as @pcms/auth's SecretBox). */
export interface IntegrationSecretBox {
  encrypt(plaintext: string): Buffer;
  decrypt(blob: Buffer): string;
}

export class RuntimeSecretError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeSecretError";
    this.code = code;
  }
}

function requireBox(box: IntegrationSecretBox | undefined): IntegrationSecretBox {
  if (box === undefined) {
    throw new RuntimeSecretError(
      "INTEGRATION_RUNTIME_SECRETS_NOT_CONFIGURED",
      "storing connector secrets requires integrations.runtimeSecretsEncryptionKeySecretRef in the deployment config",
    );
  }
  return box;
}

export async function setInstanceRuntimeSecret(
  pool: DbPool,
  box: IntegrationSecretBox | undefined,
  input: {
    readonly instanceId: string;
    readonly key: string;
    readonly value: string;
    readonly actor: string;
  },
): Promise<void> {
  const enc = requireBox(box).encrypt(input.value);
  await pool.query(
    `INSERT INTO integration_runtime_secret (instance_id, key, value_enc, updated_at, updated_by)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (instance_id, key)
     DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [input.instanceId, input.key, enc, input.actor],
  );
}

export async function clearInstanceRuntimeSecret(
  pool: DbPool,
  input: { readonly instanceId: string; readonly key: string; readonly actor: string },
): Promise<void> {
  await pool.query(`DELETE FROM integration_runtime_secret WHERE instance_id = $1 AND key = $2`, [
    input.instanceId,
    input.key,
  ]);
}

/** Stored KEY names only — never values (safe for API serialization). */
export async function listInstanceRuntimeSecretKeys(
  pool: DbPool,
  instanceId: string,
): Promise<readonly string[]> {
  const result = await pool.query<{ key: string }>(
    `SELECT key FROM integration_runtime_secret WHERE instance_id = $1 ORDER BY key`,
    [instanceId],
  );
  return result.rows.map((row) => row.key);
}

/**
 * All decrypted runtime secrets for an instance — the dispatcher's overlay
 * source. Empty when nothing is stored; the key configuration is validated
 * at write time, so a missing box here only means "no runtime values".
 */
export async function loadInstanceRuntimeSecrets(
  pool: DbPool,
  box: IntegrationSecretBox | undefined,
  instanceId: string,
): Promise<Record<string, string>> {
  if (box === undefined) return {};
  const result = await pool.query<{ key: string; value_enc: Buffer }>(
    `SELECT key, value_enc FROM integration_runtime_secret WHERE instance_id = $1`,
    [instanceId],
  );
  const secrets: Record<string, string> = {};
  for (const row of result.rows) {
    secrets[row.key] = box.decrypt(row.value_enc);
  }
  return secrets;
}
