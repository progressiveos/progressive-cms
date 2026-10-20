// Forms/Quizzes/Leads composition (PCMS-FORM-T020; Forms spec §3/§36).
// The api package is the only place allowed to join subsystems: it adapts
// @pcms/forms structural ports to the M07 outbox (publication.writeOutboxEvent
// inside the caller's transaction) and to the M08 security-event stream
// (export audit). @pcms/forms itself stays a pure L1 bounded context.

import { recordSecurityEvent } from "@pcms/auth";
import type { Clock, DbPool } from "@pcms/core";
import {
  createFormsDomainServices,
  createInteractionExportService,
  createPublicFormService,
  createPublicQuizService,
  type FormSubmissionRecord,
  type FormsDomainServices,
  FormsError,
  type FormsOutboxPort,
  type FormsPublicService,
  type InteractionExportService,
  type LeadStatus,
  leadStatusChangedEvent,
  type QuizPublicService,
} from "@pcms/forms";
import type { IntegrationProjectionSource } from "@pcms/integrations";
import { writeOutboxEvent } from "@pcms/publication";

export interface FormsSource {
  readonly domain: FormsDomainServices;
  readonly publicForm: FormsPublicService;
  readonly publicQuiz: QuizPublicService;
  readonly export: InteractionExportService;
  /** Privileged lead status change: status + LeadStatusChanged event commit
   * atomically (canonical event, Forms spec §27). */
  setLeadStatus(input: { readonly lead_id: string; readonly status: LeadStatus }): Promise<{
    readonly lead_id: string;
    readonly previous_status: LeadStatus;
    readonly status: LeadStatus;
  }>;
  /** Privileged submission moderation (ACCEPTED/SPAM/ARCHIVED). */
  setSubmissionStatus(input: {
    readonly submission_id: string;
    readonly status: "ACCEPTED" | "SPAM" | "ARCHIVED";
  }): Promise<FormSubmissionRecord>;
  /** Human stats for the definition screens (owner UX pass 0.1.28). */
  definitionStats(input: {
    readonly kind: "form" | "quiz";
    readonly definition_id: string;
  }): Promise<DefinitionStats>;
  /** Content entries whose revisions reference the definition (block props). */
  findDefinitionUsage(input: {
    readonly kind: "form" | "quiz";
    readonly definition_id: string;
  }): Promise<DefinitionUsage>;
  /** Submission detail: the raw record flattened with human labels resolved
   * against the exact historical definition version the submission pinned
   * (owner UX §27). The record shape stays the canonical surface. */
  adminSubmissionDetail(submission_id: string): Promise<AdminSubmissionDetail>;
  /** Quiz run detail with question/option labels from the pinned version. */
  adminQuizRunDetail(run_id: string): Promise<AdminQuizRunDetail>;
  /** Batched id -> title map for list views. */
  definitionTitles(input: {
    readonly kind: "form" | "quiz";
    readonly ids: readonly string[];
  }): Promise<Readonly<Record<string, string>>>;
}

export type AdminSubmissionDetail = FormSubmissionRecord & {
  readonly definition_title: string | null;
  /** payload key -> human label (pinned schema_version). */
  readonly labels: Readonly<Record<string, string>>;
  readonly lead_id: string | null;
};

export interface AdminQuizRunAnswer {
  readonly question_id: string;
  readonly label: string;
  readonly value_label: string | null;
  readonly value: unknown;
  readonly answered_at: string;
}

export interface AdminQuizRunDetail {
  readonly quiz_title: string | null;
  readonly outcome_title: string | null;
  readonly lead_id: string | null;
  readonly answers: readonly AdminQuizRunAnswer[];
}

export interface DefinitionStats {
  /** form: submissions; quiz: runs. */
  readonly primary: number;
  /** quiz only: completed runs. */
  readonly completed: number;
  readonly leads: number;
}

export interface DefinitionUsage {
  readonly entries: readonly {
    readonly entry_id: string;
    readonly title: string;
  }[];
}

export function createFormsSource(deps: {
  readonly pool: DbPool;
  readonly clock: Clock;
}): FormsSource {
  const domain = createFormsDomainServices(deps.pool);
  const outbox: FormsOutboxPort = {
    async write(executor, event) {
      // M07 envelope — same table, same at-least-once delivery as every
      // other subsystem event. No second envelope exists.
      await writeOutboxEvent(executor, event);
    },
  };
  const publicForm = createPublicFormService(deps.pool, { clock: deps.clock, outbox, domain });
  const publicQuiz = createPublicQuizService(deps.pool, { clock: deps.clock, outbox, domain });
  const exportService = createInteractionExportService(deps.pool, {
    submissions: domain.submissions,
    runs: domain.runs,
    leads: domain.leads,
    audit: {
      async record(event) {
        await recordSecurityEvent(deps.pool, null, {
          type: "INTERACTIONS_EXPORT",
          actorType: event.actor_type,
          actorId: event.actor_id,
          transport: "api",
          metadata: event.metadata,
        });
      },
    },
  });
  const source: FormsSource = {
    domain,
    publicForm,
    publicQuiz,
    export: exportService,
    async setLeadStatus(input) {
      return deps.pool.withTransaction(async (tx) => {
        const previous = await domain.leads.getLead(input.lead_id);
        if (previous.status === input.status) {
          return {
            lead_id: previous.id,
            previous_status: previous.status,
            status: previous.status,
          };
        }
        const lead = await domain.leads.setStatus(input.lead_id, input.status, { executor: tx });
        await outbox.write(
          tx,
          leadStatusChangedEvent({
            lead_id: lead.id,
            previous_status: previous.status,
            status: lead.status,
          }),
        );
        return { lead_id: lead.id, previous_status: previous.status, status: lead.status };
      });
    },
    async setSubmissionStatus(input) {
      return deps.pool.withTransaction(async (tx) =>
        domain.submissions.setStatus(input.submission_id, input.status, { executor: tx }),
      );
    },
    async definitionStats({ kind, definition_id }) {
      if (kind === "form") {
        const result = await deps.pool.query(
          `SELECT
             (SELECT count(*) FROM forms_submissions s WHERE s.form_definition_id = $1) AS primary_count,
             (SELECT count(*) FROM forms_leads l
                WHERE l.source_type = 'FORM_SUBMISSION'
                  AND EXISTS (SELECT 1 FROM forms_submissions s
                              WHERE s.id = l.source_id AND s.form_definition_id = $1)) AS leads`,
          [definition_id],
        );
        const row = result.rows[0];
        return {
          primary: Number(row?.primary_count ?? 0),
          completed: 0,
          leads: Number(row?.leads ?? 0),
        };
      }
      const result = await deps.pool.query(
        `SELECT
           (SELECT count(*) FROM forms_quiz_runs r WHERE r.quiz_definition_id = $1) AS primary_count,
           (SELECT count(*) FROM forms_quiz_runs r
              WHERE r.quiz_definition_id = $1 AND r.state = 'COMPLETED') AS completed,
           (SELECT count(*) FROM forms_leads l
              WHERE l.source_type = 'QUIZ_RUN'
                AND EXISTS (SELECT 1 FROM forms_quiz_runs r
                            WHERE r.id = l.source_id AND r.quiz_definition_id = $1)) AS leads`,
        [definition_id],
      );
      const row = result.rows[0];
      return {
        primary: Number(row?.primary_count ?? 0),
        completed: Number(row?.completed ?? 0),
        leads: Number(row?.leads ?? 0),
      };
    },
    async adminSubmissionDetail(submission_id) {
      const record = await domain.submissions.getSubmission(submission_id);
      const meta = await deps.pool.query<{ title: string | null; fields: unknown }>(
        `SELECT d.title, v.fields
         FROM forms_form_definitions d
         JOIN forms_form_definition_versions v
           ON v.definition_id = d.id AND v.schema_version = $2
         WHERE d.id = $1`,
        [record.form_definition_id, record.form_schema_version],
      );
      const labels: Record<string, string> = {};
      const fields = meta.rows[0]?.fields;
      if (Array.isArray(fields)) {
        for (const field of fields) {
          if (
            field !== null &&
            typeof field === "object" &&
            typeof (field as Record<string, unknown>).key === "string" &&
            typeof (field as Record<string, unknown>).label === "string"
          ) {
            labels[(field as Record<string, unknown>).key as string] = (
              field as Record<string, unknown>
            ).label as string;
          }
        }
      }
      const lead = await deps.pool.query<{ id: string }>(
        `SELECT id FROM forms_leads WHERE source_type = 'FORM_SUBMISSION' AND source_id = $1`,
        [submission_id],
      );
      return {
        ...record,
        definition_title: meta.rows[0]?.title ?? null,
        labels,
        lead_id: lead.rows[0]?.id ?? null,
      };
    },
    async adminQuizRunDetail(run_id) {
      const run = await domain.runs.getRun(run_id);
      const answers = await domain.runs.listAnswers(run_id);
      const version = await deps.pool.query<{
        title: string | null;
        steps: unknown;
        outcomes: unknown;
      }>(
        `SELECT d.title, v.steps, v.outcomes
         FROM forms_quiz_definitions d
         JOIN forms_quiz_definition_versions v
           ON v.quiz_definition_id = d.id AND v.schema_version = $2
         WHERE d.id = $1`,
        [run.quiz_definition_id, run.quiz_schema_version],
      );
      const questions = new Map<string, { label: string; options: Map<string, string> }>();
      const steps = version.rows[0]?.steps;
      if (Array.isArray(steps)) {
        for (const step of steps) {
          const list = (step as Record<string, unknown> | null)?.questions;
          if (!Array.isArray(list)) continue;
          for (const question of list) {
            const q = question as Record<string, unknown> | null;
            if (q === null || typeof q.id !== "string" || typeof q.label !== "string") continue;
            const options = new Map<string, string>();
            if (Array.isArray(q.options)) {
              for (const option of q.options) {
                const o = option as Record<string, unknown> | null;
                if (o !== null && typeof o.value === "string" && typeof o.label === "string") {
                  options.set(o.value, o.label);
                }
              }
            }
            questions.set(q.id, { label: q.label, options });
          }
        }
      }
      const resolveValueLabel = (questionId: string, value: unknown): string | null => {
        const q = questions.get(questionId);
        if (q === undefined) return null;
        if (Array.isArray(value)) {
          const labels = value
            .map((entry) => (typeof entry === "string" ? (q.options.get(entry) ?? null) : null))
            .filter((entry): entry is string => entry !== null);
          return labels.length === 0 ? null : labels.join(", ");
        }
        if (typeof value === "boolean") return value ? "✓" : "—";
        if (typeof value === "string") return q.options.get(value) ?? null;
        return null;
      };
      const outcomes = version.rows[0]?.outcomes;
      let outcome_title: string | null = null;
      if (run.outcome_id !== null && Array.isArray(outcomes)) {
        for (const outcome of outcomes) {
          const o = outcome as Record<string, unknown> | null;
          if (o !== null && o.id === run.outcome_id && typeof o.title === "string") {
            outcome_title = o.title;
            break;
          }
        }
      }
      const lead = await deps.pool.query<{ id: string }>(
        `SELECT id FROM forms_leads WHERE source_type = 'QUIZ_RUN' AND source_id = $1`,
        [run_id],
      );
      return {
        quiz_title: version.rows[0]?.title ?? null,
        outcome_title,
        lead_id: lead.rows[0]?.id ?? null,
        answers: answers.map((answer) => ({
          question_id: answer.question_id,
          label: questions.get(answer.question_id)?.label ?? answer.question_id,
          value_label: resolveValueLabel(answer.question_id, answer.value),
          value: answer.value,
          answered_at: answer.answered_at,
        })),
      };
    },
    async definitionTitles({ kind, ids }) {
      if (ids.length === 0) return {};
      const unique = [...new Set(ids)];
      const table = kind === "form" ? "forms_form_definitions" : "forms_quiz_definitions";
      const result = await deps.pool.query<{ id: string; title: string }>(
        `SELECT id, title FROM ${table} WHERE id = ANY($1::uuid[])`,
        [unique],
      );
      const map: Record<string, string> = {};
      for (const row of result.rows) map[row.id] = row.title;
      return map;
    },
    async findDefinitionUsage({ definition_id }) {
      // Same discipline as the media usage port: a bounded LIKE prefilter over
      // revision payloads, then exact containment on the latest revision.
      const hits = await deps.pool.query<{
        entity_id: string;
        title: string | null;
        payload: unknown;
      }>(
        `WITH candidates AS (
           SELECT DISTINCT r.entity_id
           FROM revisions r
           WHERE r.entity_type = 'entry' AND r.payload::text LIKE '%' || $1 || '%'
           LIMIT 500
         )
         SELECT latest.entity_id,
                latest.payload->'fields'->>'title' AS title,
                latest.payload
         FROM (
           SELECT DISTINCT ON (r.entity_id) r.entity_id, r.payload, r.revision_no
           FROM revisions r
           JOIN candidates c ON c.entity_id = r.entity_id
           WHERE r.entity_type = 'entry'
           ORDER BY r.entity_id, r.revision_no DESC
         ) latest`,
        [definition_id],
      );
      const entries = hits.rows
        .filter((row) => JSON.stringify(row.payload).includes(definition_id))
        .map((row) => ({ entry_id: row.entity_id, title: row.title ?? "" }));
      return { entries };
    },
  };
  return source;
}

/**
 * Default M13 projection source over the M12 Forms application boundary
 * (M12+M13 convergence; Integrations spec §6): payload mappings may $project
 * ALLOWLISTED routing-safe fields; submission payloads and lead contact
 * fields (PII) stay behind this boundary and never reach a mapped delivery
 * payload.
 *
 * `projectExecution` is the owner-authorized exception for delivery-time
 * enrichment (Progressive HQ task §50): a connector action that declares an
 * execution projection may fetch the permitted lead fields BY ID during
 * delivery. Values ride the action context only — they never persist into
 * integration_delivery payload/attempts and never enter logs.
 */
export function createFormsProjectionSource(forms: FormsSource): IntegrationProjectionSource {
  return {
    async project({ aggregate, aggregateId }) {
      try {
        if (aggregate === "form_submission") {
          const s = await forms.domain.submissions.getSubmission(aggregateId);
          return {
            submission_id: s.id,
            form_definition_id: s.form_definition_id,
            form_schema_version: s.form_schema_version,
            status: s.status,
            submitted_at: s.submitted_at,
            ...(s.source_entry_id === null ? {} : { source_entry_id: s.source_entry_id }),
          };
        }
        if (aggregate === "quiz_run") {
          const r = await forms.domain.runs.getRun(aggregateId);
          return {
            quiz_run_id: r.id,
            quiz_definition_id: r.quiz_definition_id,
            quiz_schema_version: r.quiz_schema_version,
            state: r.state,
            score: r.score,
            outcome_id: r.outcome_id,
            lead_id: r.lead_id,
          };
        }
        if (aggregate === "lead") {
          const l = await forms.domain.leads.getLead(aggregateId);
          return {
            lead_id: l.id,
            source_type: l.source_type,
            source_id: l.source_id,
            status: l.status,
            classification: l.classification,
            created_at: l.created_at,
          };
        }
        return null;
      } catch (error) {
        if (error instanceof FormsError) return null; // aggregate gone → nothing to project
        throw error;
      }
    },

    async projectExecution({ aggregate, id, fields }) {
      try {
        if (aggregate !== "lead") return null;
        const lead = await forms.domain.leads.getLead(id);
        const full: Record<string, unknown> = {
          lead_id: lead.id,
          source_type: lead.source_type,
          source_id: lead.source_id,
          status: lead.status,
          classification: lead.classification,
          created_at: lead.created_at,
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          summary: lead.summary,
          presentation: lead.presentation,
          attribution: lead.attribution,
        };
        return Object.fromEntries(Object.entries(full).filter(([key]) => fields.includes(key)));
      } catch (error) {
        if (error instanceof FormsError) return null; // lead gone → permanent dispatch failure
        throw error;
      }
    },
  };
}
