// Retention / anonymize / delete semantics (PCMS-FORM-T017; Forms spec
// §17/§30/§31). Real PII lifecycle, not row-hiding:
//   mode "anonymize" — after N days the interaction payload, consent
//     snapshot, IP hash and user agent are destroyed; technical/audit
//     metadata (id, definition, status, timestamps, spam reasons) stays;
//     provenance leads lose their PII columns.
//   mode "delete"    — rows are truly removed, including provenance leads.
//   mode "retain"    — explicit indefinite retention.
// Expired STARTED quiz runs are transitioned to EXPIRED (spec §17).
import type { Clock, DbPool } from "@pcms/core";

export interface RetentionSweepStats {
  readonly forms_anonymized: number;
  readonly forms_deleted: number;
  readonly quiz_runs_anonymized: number;
  readonly quiz_runs_deleted: number;
  readonly leads_anonymized: number;
  readonly leads_deleted: number;
  readonly quiz_runs_expired: number;
}

interface RetainedEntity {
  readonly id: string;
  readonly days: number;
  readonly mode: "anonymize" | "delete";
}

export interface RetentionService {
  /** Applies every definition's retention policy. Idempotent; safe to run on
   * a schedule. Returns bounded counters for safe operational logging. */
  sweep(): Promise<RetentionSweepStats>;
}

const EMPTY_JSON = "{}";
const EMPTY_ARRAY = "[]";
/** Row cap per delete batch. */
const RETENTION_BATCH_SIZE = 1000;
/** Iteration guard so one sweep cannot wedge on a huge backlog. */
const RETENTION_MAX_BATCHES = 100;

export function createRetentionService(
  pool: DbPool,
  deps: { readonly clock: Clock },
): RetentionService {
  async function policiesOf(
    definitionsTable: string,
    versionsTable: string,
    idColumn: string,
  ): Promise<RetainedEntity[]> {
    const result = await pool.query<{
      id: string;
      settings: { retention?: { mode?: string; after_days?: number } };
    }>(
      `SELECT d.id, v.settings
       FROM ${definitionsTable} d
       JOIN ${versionsTable} v
         ON v.${idColumn} = d.id AND v.schema_version = d.current_schema_version
       WHERE v.settings->'retention'->>'mode' IN ('anonymize', 'delete')
         AND v.settings->'retention'->>'after_days' IS NOT NULL
         AND d.status IN ('ACTIVE', 'ARCHIVED')`,
    );
    return result.rows.flatMap((row) => {
      const retention = row.settings.retention;
      const mode = retention?.mode;
      const days = retention?.after_days;
      if ((mode !== "anonymize" && mode !== "delete") || typeof days !== "number") return [];
      return [{ id: row.id, days, mode }];
    });
  }

  return {
    async sweep() {
      const now = deps.clock.now();
      const stats = {
        forms_anonymized: 0,
        forms_deleted: 0,
        quiz_runs_anonymized: 0,
        quiz_runs_deleted: 0,
        leads_anonymized: 0,
        leads_deleted: 0,
        quiz_runs_expired: 0,
      };

      // Forms.
      for (const policy of await policiesOf(
        "forms_form_definitions",
        "forms_form_definition_versions",
        "definition_id",
      )) {
        const cutoff = new Date(now.getTime() - policy.days * 24 * 60 * 60 * 1000);
        if (policy.mode === "anonymize") {
          const updated = await pool.query(
            `UPDATE forms_submissions
             SET payload = $3::jsonb, consent_snapshot = $4::jsonb,
                 submit_ip_hash = NULL, user_agent = NULL, attribution = NULL, anonymized_at = $2
             WHERE form_definition_id = $1 AND submitted_at < $2 AND anonymized_at IS NULL`,
            [policy.id, cutoff, EMPTY_JSON, EMPTY_ARRAY],
          );
          stats.forms_anonymized += updated.rowCount ?? 0;
        } else {
          // Delete is transactional per batch — a submission and its
          // provenance leads vanish together, so a crash can never leave
          // orphaned leads behind — and drains repeated batches so one sweep
          // outruns the daily inflow (bounded by RETENTION_MAX_BATCHES).
          for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
            const { deleted, leads } = await pool.withTransaction(async (tx) => {
              const rows = await tx.query<{ id: string }>(
                `DELETE FROM forms_submissions
                 WHERE id IN (
                   SELECT id FROM forms_submissions
                   WHERE form_definition_id = $1 AND submitted_at < $2 LIMIT ${RETENTION_BATCH_SIZE}
                 ) RETURNING id`,
                [policy.id, cutoff],
              );
              if (rows.rows.length === 0) return { deleted: 0, leads: 0 };
              const leadRows = await tx.query(
                `DELETE FROM forms_leads WHERE source_type = 'FORM_SUBMISSION' AND source_id = ANY($1::uuid[])`,
                [rows.rows.map((row) => row.id)],
              );
              return { deleted: rows.rows.length, leads: leadRows.rowCount ?? 0 };
            });
            stats.forms_deleted += deleted;
            stats.leads_deleted += leads;
            if (deleted < RETENTION_BATCH_SIZE) break;
          }
        }
      }

      // Quiz runs.
      for (const policy of await policiesOf(
        "forms_quiz_definitions",
        "forms_quiz_definition_versions",
        "quiz_definition_id",
      )) {
        const cutoff = new Date(now.getTime() - policy.days * 24 * 60 * 60 * 1000);
        if (policy.mode === "anonymize") {
          const updated = await pool.query<{ id: string }>(
            `UPDATE forms_quiz_runs
             SET submit_ip_hash = NULL, user_agent = NULL, session_token_hash = '',
                 attribution = NULL, anonymized_at = $2
             WHERE id IN (
               SELECT id FROM forms_quiz_runs
               WHERE quiz_definition_id = $1 AND started_at < $2 AND anonymized_at IS NULL LIMIT 1000
             ) RETURNING id`,
            [policy.id, cutoff],
          );
          stats.quiz_runs_anonymized += updated.rows.length;
          if (updated.rows.length > 0) {
            await pool.query(`DELETE FROM forms_quiz_answers WHERE run_id = ANY($1::uuid[])`, [
              updated.rows.map((row) => row.id),
            ]);
          }
        } else {
          // Same transactional batched delete as form submissions: quiz run
          // and its leads go together, repeated until the backlog drains.
          for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
            const { deleted, leads } = await pool.withTransaction(async (tx) => {
              const rows = await tx.query<{ id: string }>(
                `DELETE FROM forms_quiz_runs
                 WHERE id IN (
                   SELECT id FROM forms_quiz_runs
                   WHERE quiz_definition_id = $1 AND started_at < $2 LIMIT ${RETENTION_BATCH_SIZE}
                 ) RETURNING id`,
                [policy.id, cutoff],
              );
              if (rows.rows.length === 0) return { deleted: 0, leads: 0 };
              const leadRows = await tx.query(
                `DELETE FROM forms_leads WHERE source_type = 'QUIZ_RUN' AND source_id = ANY($1::uuid[])`,
                [rows.rows.map((row) => row.id)],
              );
              return { deleted: rows.rows.length, leads: leadRows.rowCount ?? 0 };
            });
            stats.quiz_runs_deleted += deleted;
            stats.leads_deleted += leads;
            if (deleted < RETENTION_BATCH_SIZE) break;
          }
        }
      }

      // Provenance leads of anonymized interactions lose their PII columns
      // but keep the business metadata (status/classification/timestamps).
      const staleLeadSources = await pool.query<{ form_ids: string[]; quiz_ids: string[] }>(
        `SELECT
           COALESCE(array_agg(DISTINCT CASE WHEN source_type = 'FORM_SUBMISSION' THEN source_id END), '{}') AS form_ids,
           COALESCE(array_agg(DISTINCT CASE WHEN source_type = 'QUIZ_RUN' THEN source_id END), '{}') AS quiz_ids
         FROM forms_leads l
         WHERE EXISTS (
           SELECT 1 FROM forms_submissions s
             WHERE s.id = l.source_id AND l.source_type = 'FORM_SUBMISSION' AND s.anonymized_at IS NOT NULL)
            OR EXISTS (
           SELECT 1 FROM forms_quiz_runs r
             WHERE r.id = l.source_id AND l.source_type = 'QUIZ_RUN' AND r.anonymized_at IS NOT NULL)`,
      );
      const row = staleLeadSources.rows[0];
      const sourceIds = [...(row?.form_ids ?? []), ...(row?.quiz_ids ?? [])];
      if (sourceIds.length > 0) {
        const updated = await pool.query(
          `UPDATE forms_leads SET name = NULL, email = NULL, phone = NULL, summary = '', presentation = '', attribution = NULL, updated_at = $1
           WHERE source_id = ANY($2::uuid[]) AND (name IS NOT NULL OR email IS NOT NULL OR phone IS NOT NULL OR summary <> '' OR attribution IS NOT NULL)`,
          [now, sourceIds],
        );
        stats.leads_anonymized += updated.rowCount ?? 0;
      }

      // Abandoned/expired sessions (spec §17): STARTED runs past their
      // session window become EXPIRED.
      const expired = await pool.query(
        `UPDATE forms_quiz_runs SET state = 'EXPIRED', updated_at = $1
         WHERE state = 'STARTED' AND session_expires_at < $1`,
        [now],
      );
      stats.quiz_runs_expired += expired.rowCount ?? 0;

      return stats;
    },
  };
}
