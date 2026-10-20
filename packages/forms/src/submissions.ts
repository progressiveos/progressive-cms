// FormSubmission persistence (PCMS-FORM-T007; Forms spec §7). The repository
// layer is executor-parameterized: the public submission service (T011) runs
// submission + lead + outbox event inside ONE pool transaction, so all write
// methods accept either the pool or a transaction client.
import type { DbClient, DbPool } from "@pcms/core";
import { newStableId } from "@pcms/core";
import type { AttributionSnapshot } from "./attribution.js";
import { FormsError } from "./errors.js";

/** Anything with the core query surface: DbPool and DbClient both qualify. */
export type FormsExecutor = { readonly query: DbClient["query"] };

export type FormSubmissionStatus = "ACCEPTED" | "SPAM" | "ARCHIVED";

export const FORM_SUBMISSION_STATUSES: readonly FormSubmissionStatus[] = [
  "ACCEPTED",
  "SPAM",
  "ARCHIVED",
];

/** Privileged read model. Metadata that is only anti-spam fuel (IP hash,
 * user agent) is intentionally NOT part of this record. */
export interface FormSubmissionRecord {
  readonly id: string;
  readonly form_definition_id: string;
  readonly form_schema_version: number;
  readonly status: FormSubmissionStatus;
  readonly submitted_at: string;
  readonly source_entry_id: string | null;
  readonly source_url_snapshot: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly consent_snapshot: readonly unknown[];
  readonly spam_reasons: readonly string[];
  readonly anonymized_at: string | null;
  /** Immutable MKT-010 attribution snapshot (client-declared, server-validated). */
  readonly attribution: AttributionSnapshot | null;
}

export interface InsertSubmissionInput {
  readonly form_definition_id: string;
  readonly form_schema_version: number;
  readonly status: FormSubmissionStatus;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly consent_snapshot: readonly unknown[];
  readonly source_entry_id?: string | null;
  readonly source_url_snapshot?: string | null;
  readonly submission_token_hash?: string | null;
  readonly submit_ip_hash?: string | null;
  readonly user_agent?: string | null;
  readonly spam_reasons?: readonly string[];
  readonly attribution?: AttributionSnapshot | null;
}

export interface SubmissionListFilter {
  readonly form_definition_id?: string;
  readonly status?: FormSubmissionStatus;
  readonly submitted_after?: string;
  /** Keyset page break: rows strictly before (submitted_at, id). */
  readonly before?: { readonly submitted_at: string; readonly id: string };
  readonly limit?: number;
}

const MAX_LIST_LIMIT = 200;

interface SubmissionRow {
  readonly [column: string]: unknown;
  readonly id: string;
  readonly form_definition_id: string;
  readonly form_schema_version: number;
  readonly status: string;
  readonly submitted_at: Date;
  readonly source_entry_id: string | null;
  readonly source_url_snapshot: string | null;
  readonly payload: unknown;
  readonly consent_snapshot: unknown;
  readonly spam_reasons: unknown;
  readonly anonymized_at: Date | null;
  readonly attribution: unknown;
}

function rowToRecord(row: SubmissionRow): FormSubmissionRecord {
  return {
    id: row.id,
    form_definition_id: row.form_definition_id,
    form_schema_version: row.form_schema_version,
    status: row.status as FormSubmissionStatus,
    submitted_at: row.submitted_at.toISOString(),
    source_entry_id: row.source_entry_id,
    source_url_snapshot: row.source_url_snapshot,
    payload: (row.payload ?? {}) as Readonly<Record<string, unknown>>,
    consent_snapshot: (row.consent_snapshot ?? []) as readonly unknown[],
    spam_reasons: (row.spam_reasons ?? []) as readonly string[],
    anonymized_at: row.anonymized_at?.toISOString() ?? null,
    attribution: (row.attribution ?? null) as AttributionSnapshot | null,
  };
}

export interface FormSubmissionService {
  /** Inserts inside the caller's transaction when one is passed. Returns the
   * inserted row, or the pre-existing row when the idempotency token already
   * exists for this definition (public retry safety, spec §23). */
  insertSubmission(
    input: InsertSubmissionInput,
    options?: {
      readonly executor?: FormsExecutor;
      readonly submittedAt?: Date;
    },
  ): Promise<{ readonly submission: FormSubmissionRecord; readonly duplicate: boolean }>;
  getSubmission(id: string): Promise<FormSubmissionRecord>;
  findByToken(
    form_definition_id: string,
    submission_token_hash: string,
  ): Promise<FormSubmissionRecord | null>;
  listSubmissions(filter?: SubmissionListFilter): Promise<readonly FormSubmissionRecord[]>;
  setStatus(
    id: string,
    status: FormSubmissionStatus,
    options?: { readonly executor?: FormsExecutor },
  ): Promise<FormSubmissionRecord>;
}

export function createFormSubmissionService(pool: DbPool): FormSubmissionService {
  return {
    async insertSubmission(input, options) {
      const executor = options?.executor ?? pool;
      const id = newStableId();
      const submittedAt = options?.submittedAt ?? new Date();
      try {
        const inserted = await executor.query<SubmissionRow>(
          `INSERT INTO forms_submissions
             (id, form_definition_id, form_schema_version, status, submitted_at,
              source_entry_id, source_url_snapshot, payload, consent_snapshot,
              submission_token_hash, submit_ip_hash, user_agent, spam_reasons, attribution)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING *`,
          [
            id,
            input.form_definition_id,
            input.form_schema_version,
            input.status,
            submittedAt,
            input.source_entry_id ?? null,
            input.source_url_snapshot ?? null,
            JSON.stringify(input.payload),
            JSON.stringify(input.consent_snapshot),
            input.submission_token_hash ?? null,
            input.submit_ip_hash ?? null,
            input.user_agent ?? null,
            JSON.stringify(input.spam_reasons ?? []),
            input.attribution === null || input.attribution === undefined
              ? null
              : JSON.stringify(input.attribution),
          ],
        );
        return { submission: rowToRecord(inserted.rows[0]!), duplicate: false };
      } catch (error) {
        // 23505 on the partial unique index: this definition + token already
        // has an accepted interaction — the public retry replays the original.
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "23505"
        ) {
          const existing = await this.findByToken(
            input.form_definition_id,
            input.submission_token_hash ?? "",
          );
          if (existing) return { submission: existing, duplicate: true };
        }
        throw error;
      }
    },

    async getSubmission(id) {
      const result = await pool.query<SubmissionRow>(
        `SELECT * FROM forms_submissions WHERE id = $1`,
        [id],
      );
      if (result.rows.length !== 1) {
        throw new FormsError("FORM_SUBMISSION_NOT_FOUND", `submission ${id} not found`);
      }
      return rowToRecord(result.rows[0]!);
    },

    async findByToken(form_definition_id, submission_token_hash) {
      if (submission_token_hash === "") return null;
      const result = await pool.query<SubmissionRow>(
        `SELECT * FROM forms_submissions
         WHERE form_definition_id = $1 AND submission_token_hash = $2`,
        [form_definition_id, submission_token_hash],
      );
      return result.rows.length === 1 ? rowToRecord(result.rows[0]!) : null;
    },

    async listSubmissions(filter = {}) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (filter.form_definition_id !== undefined) {
        params.push(filter.form_definition_id);
        conditions.push(`form_definition_id = $${params.length}`);
      }
      if (filter.status !== undefined) {
        params.push(filter.status);
        conditions.push(`status = $${params.length}`);
      }
      if (filter.submitted_after !== undefined) {
        params.push(new Date(filter.submitted_after));
        conditions.push(`submitted_at >= $${params.length}`);
      }
      if (filter.before !== undefined) {
        params.push(new Date(filter.before.submitted_at), filter.before.id);
        conditions.push(
          `(submitted_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), MAX_LIST_LIMIT);
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      const result = await pool.query<SubmissionRow>(
        `SELECT * FROM forms_submissions${where} ORDER BY submitted_at DESC, id DESC LIMIT ${limit}`,
        params,
      );
      return result.rows.map(rowToRecord);
    },

    async setStatus(id, status, options) {
      const executor = options?.executor ?? pool;
      const result = await executor.query<SubmissionRow>(
        `UPDATE forms_submissions SET status = $2 WHERE id = $1 RETURNING *`,
        [id, status],
      );
      if (result.rows.length !== 1) {
        throw new FormsError("FORM_SUBMISSION_NOT_FOUND", `submission ${id} not found`);
      }
      return rowToRecord(result.rows[0]!);
    },
  };
}
