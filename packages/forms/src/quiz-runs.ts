// QuizRun/QuizAnswer persistence (PCMS-FORM-T008; Forms spec §11/§12).
// Executor-parameterized like the submission repository: run + answer +
// lead + outbox event commit in ONE transaction from the T012 service.
// Session token hashes never leave this module's read models (spec §16).
import type { DbPool } from "@pcms/core";
import { newStableId } from "@pcms/core";
import type { AttributionSnapshot } from "./attribution.js";
import { FormsError } from "./errors.js";
import type { FormsExecutor } from "./submissions.js";

export type QuizRunState = "STARTED" | "COMPLETED" | "ABANDONED" | "EXPIRED";

export const QUIZ_RUN_STATES: readonly QuizRunState[] = [
  "STARTED",
  "COMPLETED",
  "ABANDONED",
  "EXPIRED",
];

export interface QuizRunRecord {
  readonly id: string;
  readonly quiz_definition_id: string;
  readonly quiz_schema_version: number;
  readonly state: QuizRunState;
  readonly started_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly source_entry_id: string | null;
  readonly score: number | null;
  readonly outcome_id: string | null;
  readonly lead_id: string | null;
  readonly session_expires_at: string;
  readonly anonymized_at: string | null;
  /** Immutable MKT-010 attribution snapshot (client-declared, server-validated). */
  readonly attribution: AttributionSnapshot | null;
}

export interface QuizAnswerRecord {
  readonly question_id: string;
  readonly value: unknown;
  readonly answered_at: string;
}

export interface InsertQuizRunInput {
  readonly quiz_definition_id: string;
  readonly quiz_schema_version: number;
  readonly session_token_hash: string;
  readonly session_expires_at: Date;
  readonly source_entry_id?: string | null;
  readonly submit_ip_hash?: string | null;
  readonly user_agent?: string | null;
  readonly attribution?: AttributionSnapshot | null;
}

export interface RunListFilter {
  readonly quiz_definition_id?: string;
  readonly state?: QuizRunState;
  readonly before?: { readonly started_at: string; readonly id: string };
  readonly limit?: number;
}

const MAX_LIST_LIMIT = 200;

interface RunRow {
  readonly [column: string]: unknown;
  readonly id: string;
  readonly quiz_definition_id: string;
  readonly quiz_schema_version: number;
  readonly state: string;
  readonly started_at: Date;
  readonly updated_at: Date;
  readonly completed_at: Date | null;
  readonly source_entry_id: string | null;
  readonly session_expires_at: Date;
  readonly score: number | null;
  readonly outcome_id: string | null;
  readonly lead_id: string | null;
  readonly anonymized_at: Date | null;
}

function rowToRun(row: RunRow): QuizRunRecord {
  return {
    id: row.id,
    quiz_definition_id: row.quiz_definition_id,
    quiz_schema_version: row.quiz_schema_version,
    state: row.state as QuizRunState,
    started_at: row.started_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
    source_entry_id: row.source_entry_id,
    attribution: (row.attribution ?? null) as AttributionSnapshot | null,
    score: row.score,
    outcome_id: row.outcome_id,
    lead_id: row.lead_id,
    session_expires_at: row.session_expires_at.toISOString(),
    anonymized_at: row.anonymized_at?.toISOString() ?? null,
  };
}

export interface QuizRunService {
  /** Creates a STARTED run inside the caller's transaction when passed. */
  insertRun(
    input: InsertQuizRunInput,
    options?: { readonly executor?: FormsExecutor },
  ): Promise<QuizRunRecord>;
  getRun(id: string): Promise<QuizRunRecord>;
  /** Token-bound lookup: no match for (id, token) → null, no existence oracle. */
  findRunByToken(id: string, session_token_hash: string): Promise<QuizRunRecord | null>;
  /** Last answer wins while the run is STARTED. */
  upsertAnswer(
    run_id: string,
    question_id: string,
    value: unknown,
    options?: { readonly executor?: FormsExecutor },
  ): Promise<void>;
  listAnswers(run_id: string): Promise<readonly QuizAnswerRecord[]>;
  /** STARTED → COMPLETED with server-computed results; guarded transition. */
  completeRun(
    id: string,
    result: {
      readonly score: number;
      readonly outcome_id: string | null;
      readonly lead_id?: string | null;
    },
    options?: { readonly executor?: FormsExecutor; readonly completedAt?: Date },
  ): Promise<QuizRunRecord>;
  /** STARTED → ABANDONED | EXPIRED (retention/sweep or user exit). */
  markRun(
    id: string,
    state: "ABANDONED" | "EXPIRED",
    options?: { readonly executor?: FormsExecutor },
  ): Promise<QuizRunRecord>;
  /** Bind a lead created from this run (T009), STARTED or COMPLETED runs. */
  attachLead(
    id: string,
    lead_id: string,
    options?: { readonly executor?: FormsExecutor },
  ): Promise<void>;
  listRuns(filter?: RunListFilter): Promise<readonly QuizRunRecord[]>;
}

export function createQuizRunService(pool: DbPool): QuizRunService {
  async function loadRun(executor: FormsExecutor, id: string): Promise<QuizRunRecord> {
    const result = await executor.query<RunRow>(`SELECT * FROM forms_quiz_runs WHERE id = $1`, [
      id,
    ]);
    if (result.rows.length !== 1) {
      throw new FormsError("QUIZ_RUN_NOT_FOUND", `quiz run ${id} not found`);
    }
    return rowToRun(result.rows[0]!);
  }

  return {
    async insertRun(input, options) {
      const executor = options?.executor ?? pool;
      const id = newStableId();
      const inserted = await executor.query<RunRow>(
        `INSERT INTO forms_quiz_runs
           (id, quiz_definition_id, quiz_schema_version, state, session_token_hash, session_expires_at,
            source_entry_id, submit_ip_hash, user_agent, attribution)
         VALUES ($1, $2, $3, 'STARTED', $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          id,
          input.quiz_definition_id,
          input.quiz_schema_version,
          input.session_token_hash,
          input.session_expires_at,
          input.source_entry_id ?? null,
          input.submit_ip_hash ?? null,
          input.user_agent ?? null,
          input.attribution === null || input.attribution === undefined
            ? null
            : JSON.stringify(input.attribution),
        ],
      );
      return rowToRun(inserted.rows[0]!);
    },

    async getRun(id) {
      return loadRun(pool, id);
    },

    async findRunByToken(id, session_token_hash) {
      const result = await pool.query<RunRow>(
        `SELECT * FROM forms_quiz_runs WHERE id = $1 AND session_token_hash = $2`,
        [id, session_token_hash],
      );
      return result.rows.length === 1 ? rowToRun(result.rows[0]!) : null;
    },

    async upsertAnswer(run_id, question_id, value, options) {
      const executor = options?.executor ?? pool;
      const result = await executor.query(
        `INSERT INTO forms_quiz_answers (id, run_id, question_id, value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (run_id, question_id)
         DO UPDATE SET value = EXCLUDED.value, answered_at = now()`,
        [newStableId(), run_id, question_id, JSON.stringify(value ?? null)],
      );
      if (result.rowCount === 0) {
        throw new FormsError("QUIZ_RUN_NOT_FOUND", `quiz run ${run_id} not found`);
      }
      await executor.query(`UPDATE forms_quiz_runs SET updated_at = now() WHERE id = $1`, [run_id]);
    },

    async listAnswers(run_id) {
      const result = await pool.query<{
        readonly question_id: string;
        readonly value: unknown;
        readonly answered_at: Date;
      }>(
        `SELECT question_id, value, answered_at FROM forms_quiz_answers
         WHERE run_id = $1 ORDER BY answered_at, question_id`,
        [run_id],
      );
      return result.rows.map((row) => ({
        question_id: row.question_id,
        value: row.value,
        answered_at: row.answered_at.toISOString(),
      }));
    },

    async completeRun(id, resultInput, options) {
      const executor = options?.executor ?? pool;
      const completedAt = options?.completedAt ?? new Date();
      const updated = await executor.query<RunRow>(
        `UPDATE forms_quiz_runs
         SET state = 'COMPLETED', completed_at = $2, updated_at = $2,
             score = $3, outcome_id = $4, lead_id = COALESCE($5, lead_id)
         WHERE id = $1 AND state = 'STARTED'
         RETURNING *`,
        [id, completedAt, resultInput.score, resultInput.outcome_id, resultInput.lead_id ?? null],
      );
      if (updated.rows.length !== 1) {
        const existing = await loadRun(executor, id);
        if (existing.state === "COMPLETED") return existing;
        throw new FormsError(
          "QUIZ_RUN_STATE_INVALID",
          `quiz run ${id} is ${existing.state}, cannot complete`,
        );
      }
      return rowToRun(updated.rows[0]!);
    },

    async markRun(id, state, options) {
      const executor = options?.executor ?? pool;
      const updated = await executor.query<RunRow>(
        `UPDATE forms_quiz_runs SET state = $2, updated_at = now(),
           completed_at = CASE WHEN $2 = 'ABANDONED' THEN now() ELSE completed_at END
         WHERE id = $1 AND state = 'STARTED'
         RETURNING *`,
        [id, state],
      );
      if (updated.rows.length !== 1) {
        throw new FormsError("QUIZ_RUN_STATE_INVALID", `quiz run ${id} is not STARTED`);
      }
      return rowToRun(updated.rows[0]!);
    },

    async attachLead(id, lead_id, options) {
      const executor = options?.executor ?? pool;
      const updated = await executor.query<RunRow>(
        `UPDATE forms_quiz_runs SET lead_id = $2, updated_at = now()
         WHERE id = $1 AND lead_id IS NULL
         RETURNING id`,
        [id, lead_id],
      );
      if (updated.rows.length !== 1) {
        throw new FormsError("QUIZ_RUN_STATE_INVALID", `quiz run ${id} already has a lead`);
      }
    },

    async listRuns(filter = {}) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (filter.quiz_definition_id !== undefined) {
        params.push(filter.quiz_definition_id);
        conditions.push(`quiz_definition_id = $${params.length}`);
      }
      if (filter.state !== undefined) {
        params.push(filter.state);
        conditions.push(`state = $${params.length}`);
      }
      if (filter.before !== undefined) {
        params.push(new Date(filter.before.started_at), filter.before.id);
        conditions.push(
          `(started_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), MAX_LIST_LIMIT);
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      const result = await pool.query<RunRow>(
        `SELECT * FROM forms_quiz_runs${where} ORDER BY started_at DESC, id DESC LIMIT ${limit}`,
        params,
      );
      return result.rows.map(rowToRun);
    },
  };
}
