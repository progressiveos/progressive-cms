// Interaction export (PCMS-FORM-T019; Forms spec §20/§29). CSV/JSON export
// of FormSubmissions, QuizRuns and Leads — permission-gated at the API layer
// (interactions.export / leads.export) and audited through a structural port
// (the composition adapts it to the auth security-event stream). CSV is
// RFC-4180-escaped; row counts are bounded; audit metadata carries filters
// and counts only — never exported PII.

import type { DbPool } from "@pcms/core";
import { FormsError } from "./errors.js";
import type { LeadRecord, LeadService, LeadStatus } from "./leads.js";
import type { QuizRunRecord, QuizRunService } from "./quiz-runs.js";
import type { FormSubmissionRecord, FormSubmissionService } from "./submissions.js";

export type ExportEntity = "submissions" | "quiz_runs" | "leads";
export type ExportFormat = "csv" | "json";

export interface FormsAuditEvent {
  readonly event_type: string;
  /** Structural mirror of the auth ActorType union (L1 cannot import it). */
  readonly actor_type:
    | "USER"
    | "SERVICE_ACCOUNT"
    | "SYSTEM"
    | "OPERATOR"
    /** PREPUBLIC §5: guest identity on public mutations. */
    | "GUEST";
  readonly actor_id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface FormsAuditPort {
  record(event: FormsAuditEvent): Promise<void>;
}

export interface ExportInput {
  readonly entity: ExportEntity;
  readonly format: ExportFormat;
  readonly form_definition_id?: string;
  readonly quiz_definition_id?: string;
  readonly status?: string;
  readonly created_after?: string;
  /** Hard row bound per export (bounded response, spec §37). */
  readonly limit?: number;
}

export interface ExportResult {
  readonly entity: ExportEntity;
  readonly format: ExportFormat;
  readonly rows: number;
  /** The export body itself (CSV text or pretty JSON). */
  readonly content: string;
}

const MAX_EXPORT_ROWS = 10_000;

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

const SUBMISSION_COLUMNS = [
  "submission_id",
  "form_definition_id",
  "form_schema_version",
  "status",
  "submitted_at",
  "source_entry_id",
  "spam_reasons",
  "attribution",
  "payload",
  "consent_snapshot",
] as const;

function submissionRow(row: FormSubmissionRecord): readonly unknown[] {
  return [
    row.id,
    row.form_definition_id,
    row.form_schema_version,
    row.status,
    row.submitted_at,
    row.source_entry_id,
    JSON.stringify(row.spam_reasons),
    row.attribution === null ? "" : JSON.stringify(row.attribution),
    JSON.stringify(row.payload),
    JSON.stringify(row.consent_snapshot),
  ];
}

const QUIZ_RUN_COLUMNS = [
  "quiz_run_id",
  "quiz_definition_id",
  "quiz_schema_version",
  "state",
  "started_at",
  "completed_at",
  "score",
  "outcome_id",
  "lead_id",
  "attribution",
] as const;

function quizRunRow(row: QuizRunRecord): readonly unknown[] {
  return [
    row.id,
    row.quiz_definition_id,
    row.quiz_schema_version,
    row.state,
    row.started_at,
    row.completed_at,
    row.score,
    row.outcome_id,
    row.lead_id,
    row.attribution === null ? "" : JSON.stringify(row.attribution),
  ];
}

const LEAD_COLUMNS = [
  "lead_id",
  "source_type",
  "source_id",
  "status",
  "name",
  "email",
  "phone",
  "summary",
  "classification",
  "created_at",
  "attribution",
] as const;

function leadRow(row: LeadRecord): readonly unknown[] {
  return [
    row.id,
    row.source_type,
    row.source_id,
    row.status,
    row.name,
    row.email,
    row.phone,
    row.summary,
    row.classification,
    row.created_at,
    row.attribution === null ? "" : JSON.stringify(row.attribution),
  ];
}

export interface InteractionExportService {
  /** Runs a bounded export and writes one audit record per call. */
  export(
    input: ExportInput,
    actor: {
      readonly actor_type:
        | "USER"
        | "SERVICE_ACCOUNT"
        | "SYSTEM"
        | "OPERATOR"
        /** PREPUBLIC §5: guest identity on public mutations. */
        | "GUEST";
      readonly actor_id: string;
    },
  ): Promise<ExportResult>;
}

export function createInteractionExportService(
  pool: DbPool,
  deps: {
    readonly submissions: Pick<FormSubmissionService, "listSubmissions">;
    readonly runs: Pick<QuizRunService, "listRuns">;
    readonly leads: Pick<LeadService, "listLeads">;
    readonly audit: FormsAuditPort;
  },
): InteractionExportService {
  return {
    async export(input, actor) {
      const limit = Math.min(Math.max(input.limit ?? MAX_EXPORT_ROWS, 1), MAX_EXPORT_ROWS);
      const filters: Record<string, unknown> = {
        ...(input.form_definition_id === undefined
          ? {}
          : { form_definition_id: input.form_definition_id }),
        ...(input.quiz_definition_id === undefined
          ? {}
          : { quiz_definition_id: input.quiz_definition_id }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.created_after === undefined ? {} : { created_after: input.created_after }),
      };
      let result: ExportResult;
      if (input.entity === "submissions") {
        const rows = await deps.submissions.listSubmissions({
          ...(input.form_definition_id === undefined
            ? {}
            : { form_definition_id: input.form_definition_id }),
          ...(input.status === undefined
            ? {}
            : { status: input.status as "ACCEPTED" | "SPAM" | "ARCHIVED" }),
          ...(input.created_after === undefined ? {} : { submitted_after: input.created_after }),
          limit,
        });
        result = {
          entity: input.entity,
          format: input.format,
          rows: rows.length,
          content: render(SUBMISSION_COLUMNS, rows.map(submissionRow), rows, input.format),
        };
      } else if (input.entity === "quiz_runs") {
        const rows = await deps.runs.listRuns({
          ...(input.quiz_definition_id === undefined
            ? {}
            : { quiz_definition_id: input.quiz_definition_id }),
          ...(input.status === undefined
            ? {}
            : { state: input.status as "STARTED" | "COMPLETED" | "ABANDONED" | "EXPIRED" }),
          limit,
        });
        result = {
          entity: input.entity,
          format: input.format,
          rows: rows.length,
          content: render(QUIZ_RUN_COLUMNS, rows.map(quizRunRow), rows, input.format),
        };
      } else {
        const rows = await deps.leads.listLeads({
          ...(input.status === undefined ? {} : { status: input.status as LeadStatus }),
          limit,
        });
        result = {
          entity: input.entity,
          format: input.format,
          rows: rows.length,
          content: render(LEAD_COLUMNS, rows.map(leadRow), rows, input.format),
        };
      }
      await deps.audit.record({
        event_type: "interactions.export",
        actor_type: actor.actor_type,
        actor_id: actor.actor_id,
        metadata: {
          entity: input.entity,
          format: input.format,
          rows: result.rows,
          ...filters,
        },
      });
      return result;
    },
  };
}

function render(
  header: readonly string[],
  cells: readonly (readonly unknown[])[],
  rawRows: readonly unknown[],
  format: ExportFormat,
): string {
  if (format === "csv") {
    return toCsv(header, cells);
  }
  if (format === "json") {
    return JSON.stringify(rawRows, null, 2);
  }
  throw new FormsError("INTERACTION_EXPORT_INVALID", `unsupported export format "${format}"`);
}
