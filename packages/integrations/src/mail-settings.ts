// Admin-managed mail (SMTP) settings (PCMS-OPS-T130; Operations spec §31).
//
// Runtime-editable SMTP connection state (migration 1601): the operator
// configures/rotates credentials from the Admin instead of a redeploy. The
// password is the only secret VALUE the database ever holds — encrypted at
// rest with the injected secret box (AES-256-GCM, TOTP precedent); the key
// itself lives in the deployment secret channel, never in the database.
// This module is crypto-agnostic: it accepts a structural box, so the
// composition layer can inject @pcms/auth's secret-box without a package
// dependency.
import type { DbPool } from "@pcms/core";
import type { IntegrationSecretBox } from "./runtime-secrets.js";
import type { SmtpOptions } from "./smtp.js";

/**
 * Structural secret box for the managed SMTP password — the SAME deployment
 * key as the generic connector runtime secret store (1601+1602 share one
 * `integrations.runtimeSecretsEncryptionKeySecretRef`).
 */
export type MailSecretBox = IntegrationSecretBox;

export class MailSettingsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MailSettingsError";
    this.code = code;
  }
}

/** Admin-facing projection — never contains the password or its blob. */
export interface MailSettingsView {
  readonly enabled: boolean;
  readonly from: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly mode: "smtps" | "starttls" | "plain" | null;
  readonly username: string | null;
  readonly has_password: boolean;
  readonly updated_at: Date;
  readonly updated_by: string;
}

interface MailSettingsDbRow extends Record<string, unknown> {
  enabled: boolean;
  from_address: string | null;
  host: string | null;
  port: number | null;
  mode: string | null;
  username: string | null;
  password_enc: Buffer | null;
  updated_at: Date;
  updated_by: string;
}

const SELECT_COLUMNS = `enabled, from_address, host, port, mode, username, password_enc, updated_at, updated_by`;

function toView(row: MailSettingsDbRow): MailSettingsView {
  return {
    enabled: row.enabled,
    from: row.from_address,
    host: row.host,
    port: row.port,
    mode: parseMode(row.mode),
    username: row.username,
    has_password: row.password_enc !== null,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

function parseMode(value: string | null): "smtps" | "starttls" | "plain" | null {
  if (value === "smtps" || value === "starttls" || value === "plain") return value;
  return null;
}

/** Singleton row (sanitized); `null` when the migration has not run —
 * callers then fall back to deployment config (fail-safe). */
export async function loadMailSettings(pool: DbPool): Promise<MailSettingsView | null> {
  const result = await pool.query<MailSettingsDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM pcms_mail_settings WHERE id = 1`,
  );
  const row = result.rows[0];
  return row === undefined ? null : toView(row);
}

export interface MailSettingsWrite {
  readonly enabled: boolean;
  readonly from: string;
  readonly host: string;
  readonly port: number;
  readonly mode: "smtps" | "starttls" | "plain";
  readonly username?: string;
  /** set → store encrypted; clear → drop the stored password; absent → keep. */
  readonly password?: { readonly set: string } | { readonly clear: true };
}

export async function saveMailSettings(
  pool: DbPool,
  box: MailSecretBox | undefined,
  write: MailSettingsWrite,
  actor: string,
): Promise<MailSettingsView> {
  const current = await pool.query<Pick<MailSettingsDbRow, "password_enc">>(
    `SELECT password_enc FROM pcms_mail_settings WHERE id = 1`,
  );
  if (current.rows[0] === undefined) {
    throw new MailSettingsError(
      "MAIL_NOT_CONFIGURED",
      "mail settings are not configured (run migrations)",
    );
  }
  let passwordEnc: Buffer | null = current.rows[0].password_enc;
  if (write.password !== undefined) {
    if ("clear" in write.password) {
      passwordEnc = null;
    } else {
      if (box === undefined) {
        throw new MailSettingsError(
          "MAIL_ENCRYPTION_NOT_CONFIGURED",
          "storing the SMTP password requires integrations.runtimeSecretsEncryptionKeySecretRef in the deployment config",
        );
      }
      passwordEnc = box.encrypt(write.password.set);
    }
  }
  const result = await pool.query<MailSettingsDbRow>(
    `UPDATE pcms_mail_settings SET
       enabled = $1, from_address = $2, host = $3, port = $4, mode = $5,
       username = $6, password_enc = $7, updated_at = now(), updated_by = $8
     WHERE id = 1
     RETURNING ${SELECT_COLUMNS}`,
    [
      write.enabled,
      write.from,
      write.host,
      write.port,
      write.mode,
      write.username ?? null,
      passwordEnc,
      actor,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MailSettingsError(
      "MAIL_NOT_CONFIGURED",
      "mail settings are not configured (run migrations)",
    );
  }
  return toView(row);
}

/**
 * Active SMTP options for sending/probing: the managed row when enabled and
 * complete (password decrypted at the last moment), otherwise `null` —
 * callers fall back to the deployment-config transport. Database failures
 * propagate; the composition layer decides the fallback.
 */
export async function loadActiveSmtpOptions(
  pool: DbPool,
  box: MailSecretBox | undefined,
): Promise<SmtpOptions | null> {
  const result = await pool.query<MailSettingsDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM pcms_mail_settings WHERE id = 1`,
  );
  const row = result.rows[0];
  if (row === undefined || !row.enabled || row.host === null || row.from_address === null) {
    return null;
  }
  const password =
    box !== undefined && row.password_enc !== null ? box.decrypt(row.password_enc) : undefined;
  const mode = parseMode(row.mode) ?? "starttls";
  return {
    host: row.host,
    port: row.port ?? (mode === "smtps" ? 465 : 587),
    mode,
    ...(row.username === null ? {} : { username: row.username }),
    ...(password === undefined ? {} : { password }),
    from: row.from_address,
  };
}

/**
 * Candidate options for a pending write (before persistence): applies the
 * write's password semantics (set/clear/keep) on top of the stored row so
 * the ops layer can verify the connection BEFORE saving. Throws
 * MAIL_ENCRYPTION_NOT_CONFIGURED when a new password needs a missing box.
 */
export async function buildSmtpOptionsForWrite(
  pool: DbPool,
  box: MailSecretBox | undefined,
  write: MailSettingsWrite,
): Promise<SmtpOptions | null> {
  const current = await pool.query<Pick<MailSettingsDbRow, "password_enc">>(
    `SELECT password_enc FROM pcms_mail_settings WHERE id = 1`,
  );
  let password: string | undefined;
  if (write.password === undefined) {
    const stored = current.rows[0]?.password_enc;
    if (box !== undefined && stored !== null && stored !== undefined) {
      password = box.decrypt(stored);
    }
  } else if ("set" in write.password) {
    if (box === undefined) {
      throw new MailSettingsError(
        "MAIL_ENCRYPTION_NOT_CONFIGURED",
        "storing the SMTP password requires integrations.runtimeSecretsEncryptionKeySecretRef in the deployment config",
      );
    }
    password = write.password.set;
  }
  return {
    host: write.host,
    port: write.port,
    mode: write.mode,
    ...(write.username === undefined ? {} : { username: write.username }),
    ...(password === undefined ? {} : { password }),
    from: write.from,
  };
}
