// Structured security events (PCMS-AUTH-T025; Auth spec §37, §66, §69).
//
// Append-only store + an optional in-process sink for the future audit
// subsystem (packages/audit is a later milestone; L1 packages cannot import
// each other, so the audit layer consumes either this table or the sink the
// composition root registers). Contract: metadata NEVER contains secret
// material — no passwords, hashes, tokens, codes or raw session ids.
// The no-secrets corpus test scans a hostile event against this contract.
import { type DbClient, type DbPool, newStableId } from "@pcms/core";
import type { ActorType } from "./actor.js";

export type SecurityEventType =
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILURE"
  | "LOGIN_THROTTLED"
  | "PASSWORD_CHANGED"
  | "PASSWORD_RESET_REQUESTED"
  | "PASSWORD_RESET"
  | "MFA_ENROLLED"
  | "MFA_DISABLED"
  | "MFA_RECOVERY_USED"
  | "MFA_RESET_BY_OPERATOR"
  | "SESSION_REVOKED"
  | "ROLE_ASSIGNED"
  | "ROLE_REMOVED"
  | "USER_CREATED"
  | "THEME_UPDATED"
  | "USER_ACTIVATED"
  | "USER_DISABLED"
  | "OWNER_BOOTSTRAPPED"
  | "SERVICE_ACCOUNT_CREATED"
  | "SERVICE_ACCOUNT_DISABLED"
  | "SERVICE_ACCOUNT_DELETED"
  | "TOKEN_CREATED"
  | "TOKEN_REVOKED"
  | "BREAK_GLASS"
  | "INTERACTIONS_EXPORT"
  // M13 privileged operations (Integrations/Payments specs §20/§37/§40):
  // integration config changes, connection tests, delivery retries and
  // refunds are permission-gated AND audited.
  | "INTEGRATION_CONFIGURED"
  | "INTEGRATION_SECRET_SET"
  | "INTEGRATION_SECRET_CLEARED"
  | "INTEGRATION_TESTED"
  | "INTEGRATION_RETRY"
  | "PAYMENT_REFUND"
  | "PAYMENT_PROVIDER_INSTANCE_CREATED"
  | "PAYMENT_PROVIDER_INSTANCE_UPDATED"
  | "PAYMENT_PROVIDER_INSTANCE_DELETED"
  | "PAYMENT_PROVIDER_INSTANCE_TESTED"
  // M14 privileged extension lifecycle and update operations
  // (Extensions spec §12–§13/§37): permission-gated AND audited.
  | "EXTENSION_INSTALLED"
  | "EXTENSION_ENABLED"
  | "EXTENSION_DISABLED"
  | "EXTENSION_UNINSTALLED"
  // ADR-0013 §52.4: media provider credential management is permission-gated
  // AND audited; the VALUE is never part of the event payload.
  | "EXTENSION_PROVIDER_SECRET_SET"
  | "EXTENSION_PROVIDER_SECRET_CLEARED"
  // ADR-0014 §52.7: provider network/proxy configuration changes are audited
  // (key NAMES only, never values).
  | "EXTENSION_PROVIDER_CONFIG_UPDATED"
  // PCMS-PRE-RESEARCH A2: generic extension settings are permission-gated
  // AND audited (key NAMES only, never values).
  | "EXTENSION_CONFIG_UPDATED"
  | "EXTENSION_SECRET_SET"
  | "EXTENSION_SECRET_CLEARED"
  // ADR-0014 §8: publication bundle ingest lifecycle (safe metadata only —
  // bundle/ingest ids, outcome, counts; never content or secrets).
  | "PCPUB_SUBMITTED"
  | "PCPUB_OUTCOME"
  | "UPDATE_APPLY_ATTEMPT"
  // M15 maintenance mode operations (task brief §33): toggling and editing
  // the public maintenance copy are permission-gated AND audited.
  | "MAINTENANCE_ENABLED"
  | "MAIL_SETTINGS_UPDATED"
  | "LOCALIZATION_UPDATED"
  | "TRANSLATION_CREATED"
  // Identity repair (owner 2026-10-06): entry + revisions moved between
  // identity locales; audited with from/to and the adopted revision count.
  | "ENTRY_IDENTITY_LOCALE_CHANGED"
  | "MAINTENANCE_DISABLED"
  | "MAINTENANCE_SETTINGS_UPDATED"
  // Community Skills plan §4: operator skill lifecycle is permission-gated
  // AND audited (id/sha256/origin only — skill TEXT is not a secret but is
  // never logged here either; the audit answers "who changed what").
  | "SKILL_INSTALLED"
  | "SKILL_DISABLED"
  | "SKILL_ENABLED"
  | "SKILL_UNINSTALLED"
  // Content schema apply (2026-09-29 "schemas via API"): additive-only
  // override persistence is permission-gated AND audited (type keys, change
  // kinds — never definition payloads).
  | "CONTENT_SCHEMA_APPLIED"
  // Revision deletion (2026-09-29 owner request): WORKING/SEALED cleanup is
  // permission-gated AND audited (id/entity/state only).
  | "REVISION_DELETED"
  | "REVISIONS_CLEANED"
  // Registry instance binding (2026-09-29): the operator binds this PCMS
  // instance to his registry account (label only — the code and the
  // account credentials are never logged).
  | "REGISTRY_INSTANCE_REGISTERED"
  | "REGISTRY_ACCOUNT_TOKEN_SET"
  | "REGISTRY_ACCOUNT_TOKEN_CLEARED"
  | "INDEXNOW_ENABLED"
  | "INDEXNOW_DISABLED"
  | "INDEXNOW_KEY_ROTATED"
  | "INDEXNOW_SETTINGS_UPDATED"
  // Notifications v1 (owner brief 2026-10-07): recipient routing edits are
  // permission-gated AND audited (category counts only — never recipient
  // e-mails; those live in the users table).
  | "NOTIFICATION_SETTINGS_UPDATED"
  | "NOTIFICATION_PREFS_UPDATED";

export type SecurityTransport = "web" | "api" | "mcp" | "cli" | "operator";

export interface SecurityEvent {
  readonly type: SecurityEventType;
  readonly actorType: ActorType;
  readonly actorId: string | null;
  readonly subjectType?: string;
  readonly subjectId?: string | null;
  readonly siteKey?: string | null;
  readonly environment?: string | null;
  readonly transport?: SecurityTransport;
  /** Non-secret context only (reason codes, coarse metadata, actor names). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export async function recordSecurityEvent(
  db: DbPool | DbClient,
  sink: SecurityEventSink | null | undefined,
  event: SecurityEvent,
): Promise<void> {
  // Defense in depth (spec §66/§69): even a buggy producer cannot persist a
  // secret-shaped metadata key — the filter below runs before the INSERT and
  // before the sink sees the event. Supersedes the logger's redaction pass
  // with an auth-specific list (recovery/OTP/CSRF/verifier shapes included).
  const safeEvent: SecurityEvent =
    event.metadata === undefined
      ? event
      : { ...event, metadata: redactEventMetadata(event.metadata) };
  const metadata = safeEvent.metadata === undefined ? null : JSON.stringify(safeEvent.metadata);
  await db.query(
    `INSERT INTO auth_security_events
       (id, event_type, actor_type, actor_id, subject_type, subject_id,
        site_key, environment, transport, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      newStableId(),
      event.type,
      safeEvent.actorType,
      safeEvent.actorId,
      safeEvent.subjectType ?? null,
      safeEvent.subjectId ?? null,
      safeEvent.siteKey ?? null,
      safeEvent.environment ?? null,
      safeEvent.transport ?? null,
      metadata,
    ],
  );
  if (sink !== null && sink !== undefined) {
    await sink(safeEvent);
  }
}

/** In-process tap for the audit subsystem; errors never break the flow. */
export type SecurityEventSink = (event: SecurityEvent) => void | Promise<void>;

const SECRET_KEY =
  /pass(word)?|secret|token|authorization|cookie|credential|totp|otp|recovery|csrf|api[-_]?key|private[-_]?key|session[-_]?id|verifier/i;
const REDACTED = "[REDACTED]";

function redactEventMetadata(
  value: Readonly<Record<string, unknown>>,
  depth = 0,
): Record<string, unknown> {
  if (depth >= 8) return { truncated: true };
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      out[key] = REDACTED;
    } else if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      out[key] = redactEventMetadata(item as Record<string, unknown>, depth + 1);
    } else {
      out[key] = item;
    }
  }
  return out;
}

export interface SecurityEventFilters {
  readonly event_type?: string | null;
  readonly actor_type?: string | null;
  readonly actor_id?: string | null;
  readonly transport?: string | null;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SecurityEventRecord extends Record<string, unknown> {
  readonly id: string;
  readonly event_type: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly site_key: string | null;
  readonly environment: string | null;
  readonly transport: string | null;
  readonly metadata: unknown;
  readonly created_at: Date;
}

/** Read side for the Admin audit UI (PCMS-ADMIN-T022; audit.read gates). */
export async function listSecurityEvents(
  pool: DbPool,
  filters: SecurityEventFilters = {},
): Promise<SecurityEventRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const add = (clause: string, value: unknown): void => {
    values.push(value);
    conditions.push(clause.replace("$?", `$${values.length}`));
  };
  if (filters.event_type) add("event_type = $?", filters.event_type);
  if (filters.actor_type) add("actor_type = $?", filters.actor_type);
  if (filters.actor_id) add("actor_id = $?", filters.actor_id);
  if (filters.transport) add("transport = $?", filters.transport);
  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const offset = Math.max(filters.offset ?? 0, 0);
  values.push(limit);
  values.push(offset);
  const result = await pool.query<SecurityEventRecord>(
    `SELECT id, event_type, actor_type, actor_id, subject_type, subject_id,
            site_key, environment, transport, metadata, created_at
     FROM auth_security_events ${where}
     ORDER BY created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows;
}
