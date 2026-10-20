// Extension runtime secret store (PCMS-MPA-T006; ADR-0013 §52.4).
//
// Generic Admin-managed secret VALUES for extension/provider configuration —
// write-only, encrypted at rest (AES-256-GCM via the injected structural
// secret box, the Integration Hub runtime-secrets precedent), never returned
// by any API surface (only the stored SLOT names are visible). The
// encryption key lives in the deployment secret channel — the same operator
// key that protects Integration Hub runtime secrets (single master runtime
// key, ADR-0013). This module is crypto-agnostic: it accepts a structural
// box. Lifecycle semantics ride the FK CASCADE: uninstall (installation row
// removal) deletes the secrets; enable/disable never touches them.
import type { DbPool } from "@pcms/core";

/** Structural secret box (same shape as @pcms/auth's SecretBox). */
export interface ExtensionSecretBox {
  encrypt(plaintext: string): Buffer;
  decrypt(blob: Buffer): string;
}

export class ExtensionRuntimeSecretError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ExtensionRuntimeSecretError";
    this.code = code;
  }
}

function requireBox(box: ExtensionSecretBox | undefined): ExtensionSecretBox {
  if (box === undefined) {
    throw new ExtensionRuntimeSecretError(
      "EXTENSION_RUNTIME_SECRETS_NOT_CONFIGURED",
      "storing extension secrets requires the runtime secrets encryption key in the deployment config",
    );
  }
  return box;
}

export async function setExtensionRuntimeSecret(
  pool: DbPool,
  box: ExtensionSecretBox | undefined,
  input: {
    readonly extensionId: string;
    readonly slot: string;
    readonly value: string;
    readonly actor: string;
  },
): Promise<void> {
  const enc = requireBox(box).encrypt(input.value);
  await pool.query(
    `INSERT INTO extension_runtime_secret (extension_id, slot, value_enc, updated_at, updated_by)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (extension_id, slot)
     DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [input.extensionId, input.slot, enc, input.actor],
  );
}

export async function clearExtensionRuntimeSecret(
  pool: DbPool,
  input: { readonly extensionId: string; readonly slot: string },
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM extension_runtime_secret WHERE extension_id = $1 AND slot = $2`,
    [input.extensionId, input.slot],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Stored SLOT names only — never values (safe for API serialization). */
export async function listExtensionRuntimeSecretSlots(
  pool: DbPool,
  extensionId: string,
): Promise<readonly string[]> {
  const result = await pool.query<{ slot: string }>(
    `SELECT slot FROM extension_runtime_secret WHERE extension_id = $1 ORDER BY slot`,
    [extensionId],
  );
  return result.rows.map((row) => row.slot);
}

/** Resolver seam for provider composition (ADR-0013 §52.2). */
export async function getExtensionRuntimeSecret(
  pool: DbPool,
  box: ExtensionSecretBox | undefined,
  extensionId: string,
  slot: string,
): Promise<string | undefined> {
  if (box === undefined) return undefined;
  const result = await pool.query<{ value_enc: Buffer }>(
    `SELECT value_enc FROM extension_runtime_secret WHERE extension_id = $1 AND slot = $2`,
    [extensionId, slot],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return box.decrypt(row.value_enc);
}
