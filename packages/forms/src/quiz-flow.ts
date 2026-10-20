// Public quiz run orchestration (PCMS-FORM-T012; Forms spec §11–§17, §28).
// Quiz is a first-class stateful server-driven interaction: every answer is
// validated and persisted server-side, branching and scoring are computed
// here (never trusted from the client), and the resume token is high-entropy,
// opaque, hash-at-rest, expiring — it encodes no identity and cannot expose
// another run. Reliability invariant: run + answer + lead + events commit in
// ONE transaction; QuizCompleted payload is routing-safe only.
import { createHash, randomBytes } from "node:crypto";
import type { Clock, DbClient, DbPool } from "@pcms/core";
import { isStableId } from "@pcms/core";
import { parseAttribution } from "./attribution.js";
import { type AnswerLookup, type QuizAnswerValue, resolveNextStep } from "./branching.js";
import { FormsError } from "./errors.js";
import { leadCreatedEvent, quizCompletedEvent } from "./events.js";
import type { CreateLeadInput, LeadService } from "./leads.js";
import type { FormsOutboxPort } from "./ports.js";
import { renderLeadPresentation } from "./presentation.js";
import type { QuizDefinition, QuizQuestion } from "./quiz-definitions.js";
import type { QuizRunRecord } from "./quiz-runs.js";
import { computeScore, resolveOutcome } from "./scoring.js";
import type { FormsDomainServices } from "./submit.js";

/** Resume-token lifetime (bounded, spec §16). Constant by design: it is a
 * security bound, not an operator knob. */
const RESUME_TOKEN_TTL_MILLISECONDS = 4 * 60 * 60 * 1000;
const MAX_ANSWER_TEXT_LENGTH = 5000;
const MAX_MULTI_VALUES = 500;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Server-driven public step view: safe to hand to any client; contains no
 * branching targets, no scoring weights, no outcome conditions. */
export interface PublicQuizQuestion {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly required: boolean;
  readonly help?: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly min?: number;
  readonly max?: number;
  readonly max_length?: number;
}

export interface PublicQuizStep {
  readonly step_id: string;
  readonly title: string | null;
  readonly questions: readonly PublicQuizQuestion[];
}

export interface QuizStartResult {
  readonly quiz_run_id: string;
  readonly resume_token: string;
  readonly step: PublicQuizStep;
}

export interface QuizAnswerResult {
  readonly state: "STARTED";
  /** null → all server-driven steps are done; the client may complete. */
  readonly next_step: PublicQuizStep | null;
}

export interface QuizCompleteResult {
  readonly state: "COMPLETED";
  readonly score: number | null;
  readonly outcome: {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
  } | null;
  readonly lead_id: string | null;
}

export interface QuizStartInput {
  readonly quiz_definition_id: string;
  readonly source_entry_id?: string;
  readonly submitter?: { readonly ip?: string | null; readonly user_agent?: string | null };
  /** MKT-010 client-declared attribution snapshot (allowlisted, server-validated). */
  readonly attribution?: unknown;
}

export interface QuizAnswerInput {
  readonly quiz_run_id: string;
  readonly resume_token: string;
  readonly question_id: string;
  readonly value: unknown;
}

export interface QuizTokenInput {
  readonly quiz_run_id: string;
  readonly resume_token: string;
}

function publicStep(definition: QuizDefinition, stepId: string): PublicQuizStep {
  const step = definition.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new FormsError("QUIZ_DEFINITION_INVALID", `step "${stepId}" disappeared`);
  return {
    step_id: step.id,
    title: step.title ?? null,
    questions: step.questions.map((question) => publicQuestion(question)),
  };
}

function publicQuestion(question: QuizQuestion): PublicQuizQuestion {
  const base: PublicQuizQuestion = {
    id: question.id,
    type: question.type,
    label: question.label,
    required: question.required === true,
    ...(question.help === undefined ? {} : { help: question.help }),
    ...(question.options === undefined ? {} : { options: question.options }),
    ...(question.min === undefined ? {} : { min: question.min }),
    ...(question.max === undefined ? {} : { max: question.max }),
    ...(question.max_length === undefined ? {} : { max_length: question.max_length }),
  };
  return base;
}

/** Server-side answer validation (spec §10/§12): allowlists + bounds only. */
export function validateAnswerValue(
  question: QuizQuestion,
  value: unknown,
): QuizAnswerValue | undefined {
  const blank =
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0);
  if (blank) {
    if (question.required === true) {
      throw new FormsError("QUIZ_ANSWER_INVALID", `question "${question.id}" requires an answer`, {
        details: { question_id: question.id, code: "required" },
      });
    }
    return undefined; // optional blank = no answer
  }
  switch (question.type) {
    case "single_choice": {
      const text = typeof value === "string" ? value.trim() : "";
      if (!(question.options ?? []).some((option) => option.value === text)) {
        throw invalidChoice(question.id);
      }
      return text;
    }
    case "multiple_choice": {
      if (!Array.isArray(value) || value.length > MAX_MULTI_VALUES)
        throw invalidChoice(question.id);
      const allowed = new Set((question.options ?? []).map((option) => option.value));
      const picked: string[] = [];
      for (const entry of value) {
        const text = typeof entry === "string" ? entry.trim() : "";
        if (!allowed.has(text)) throw invalidChoice(question.id);
        if (!picked.includes(text)) picked.push(text);
      }
      return picked;
    }
    case "text": {
      if (typeof value !== "string") {
        throw new FormsError("QUIZ_ANSWER_INVALID", `question "${question.id}" must be a string`);
      }
      const text = value.trim();
      if (text.length > (question.max_length ?? MAX_ANSWER_TEXT_LENGTH)) {
        throw new FormsError("QUIZ_ANSWER_INVALID", `question "${question.id}" is too long`);
      }
      return text === "" ? undefined : text;
    }
    case "number": {
      const numeric =
        typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
      if (!Number.isFinite(numeric)) {
        throw new FormsError("QUIZ_ANSWER_INVALID", `question "${question.id}" must be a number`);
      }
      if (question.min !== undefined && numeric < question.min) {
        throw new FormsError(
          "QUIZ_ANSWER_INVALID",
          `question "${question.id}" is below the minimum`,
        );
      }
      if (question.max !== undefined && numeric > question.max) {
        throw new FormsError(
          "QUIZ_ANSWER_INVALID",
          `question "${question.id}" is above the maximum`,
        );
      }
      return numeric;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw new FormsError("QUIZ_ANSWER_INVALID", `question "${question.id}" must be a boolean`);
      }
      return value;
    }
  }
}

function invalidChoice(questionId: string): FormsError {
  return new FormsError(
    "QUIZ_ANSWER_INVALID",
    `question "${questionId}" received a value outside the allowed list`,
    {
      details: { question_id: questionId, code: "enum" },
    },
  );
}

export interface QuizPublicService {
  start(input: QuizStartInput): Promise<QuizStartResult>;
  answer(input: QuizAnswerInput): Promise<QuizAnswerResult>;
  complete(input: QuizTokenInput): Promise<QuizCompleteResult>;
  /** Client-driven explicit exit; no event by default (spec §17). */
  abandon(input: QuizTokenInput): Promise<{ readonly state: "ABANDONED" }>;
  /** Sanitized public schema for rendering clients (spec §36). */
  getPublicSchema(quiz_definition_id: string): Promise<{
    readonly quiz_definition_id: string;
    readonly quiz_schema_version: number;
    readonly steps: readonly PublicQuizStep[];
  }>;
}

export function createPublicQuizService(
  pool: DbPool,
  deps: {
    readonly clock: Clock;
    readonly outbox: FormsOutboxPort;
    readonly domain: FormsDomainServices;
  },
): QuizPublicService {
  /** Token-bound run load; expired STARTED runs are transitioned on touch. */
  async function loadLiveRun(input: QuizTokenInput, tx: DbClient): Promise<QuizRunRecord> {
    if (!isStableId(input.quiz_run_id))
      throw new FormsError("QUIZ_RUN_NOT_FOUND", "quiz run not found");
    const run = await deps.domain.runs.findRunByToken(
      input.quiz_run_id,
      sha256(input.resume_token),
    );
    if (!run) throw new FormsError("QUIZ_RUN_NOT_FOUND", "quiz run not found");
    // Addressed processing controls share the source row lock.
    const source = await tx.query("SELECT id FROM forms_quiz_runs WHERE id=$1 FOR UPDATE", [
      run.id,
    ]);
    if (source.rows.length === 0) throw new FormsError("QUIZ_RUN_NOT_FOUND", "quiz run not found");
    const privacy = await tx.query(
      "SELECT blocked,erased FROM interaction_privacy_subjects WHERE entity='quiz_run' AND entity_id=$1",
      [run.id],
    );
    if (privacy.rows.some((r) => r.blocked === true || r.erased === true))
      throw new FormsError("PRIVACY_BLOCKED_CONFLICT", "quiz processing is paused by the operator");
    if (
      run.state === "STARTED" &&
      new Date(run.session_expires_at).getTime() <= deps.clock.now().getTime()
    ) {
      await deps.domain.runs.markRun(run.id, "EXPIRED", { executor: tx });
      throw new FormsError("QUIZ_RUN_EXPIRED", "quiz run session expired");
    }
    return run;
  }

  function definitionOf(run: QuizRunRecord): Promise<QuizDefinition> {
    return deps.domain.quizzes
      .getVersion(run.quiz_definition_id, run.quiz_schema_version)
      .then((version) => ({
        id: run.quiz_definition_id,
        key: version.key,
        title: version.title,
        schema_version: version.schema_version,
        status: "ACTIVE" as const,
        steps: version.steps,
        branching_rules: version.branching_rules,
        scoring_rules: version.scoring_rules,
        outcomes: version.outcomes,
        settings: version.settings,
        created_at: version.created_at,
        updated_at: version.created_at,
      }));
  }

  function lookupOf(answers: ReadonlyMap<string, unknown>): AnswerLookup {
    return (questionId) => {
      if (!answers.has(questionId)) return { answered: false };
      return { answered: true, value: answers.get(questionId) as QuizAnswerValue };
    };
  }

  /** Re-simulates the deterministic server path and asserts every required
   * question on visited steps was actually answered. */
  function assertRequiredAnswered(
    definition: QuizDefinition,
    answers: ReadonlyMap<string, unknown>,
  ): void {
    const lookup = lookupOf(answers);
    const visited = new Set<string>();
    let current: string | null = definition.steps[0]?.id ?? null;
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      const step = definition.steps.find((candidate) => candidate.id === current);
      if (!step) break;
      const missing = step.questions.find(
        (question) => question.required === true && !answers.has(question.id),
      );
      if (missing) {
        throw new FormsError(
          "QUIZ_ANSWER_INVALID",
          `question "${missing.id}" is required to complete the quiz`,
          {
            details: { question_id: missing.id, code: "required" },
          },
        );
      }
      current = resolveNextStep(
        definition.steps,
        definition.branching_rules,
        current,
        lookup,
      ).next_step;
    }
  }

  return {
    async start(input) {
      const now = deps.clock.now();
      if (input.source_entry_id !== undefined && !isStableId(input.source_entry_id)) {
        throw new FormsError("QUIZ_DEFINITION_INVALID", "source_entry_id is malformed");
      }
      const definition = await deps.domain.quizzes.getDefinition(input.quiz_definition_id);
      if (definition.status !== "ACTIVE") {
        throw new FormsError(
          "QUIZ_DEFINITION_NOT_FOUND",
          `quiz definition ${input.quiz_definition_id} is not available`,
        );
      }
      const firstStep = definition.steps[0];
      if (!firstStep) throw new FormsError("QUIZ_DEFINITION_INVALID", "quiz has no steps");
      const resumeToken = randomBytes(32).toString("base64url");
      const run = await deps.domain.runs.insertRun({
        quiz_definition_id: definition.id,
        quiz_schema_version: definition.schema_version,
        session_token_hash: sha256(resumeToken),
        session_expires_at: new Date(now.getTime() + RESUME_TOKEN_TTL_MILLISECONDS),
        attribution: parseAttribution(input.attribution, "quiz", definition.id),
        source_entry_id: input.source_entry_id ?? null,
        submit_ip_hash: input.submitter?.ip ? sha256(input.submitter.ip) : null,
        user_agent: input.submitter?.user_agent ? input.submitter.user_agent.slice(0, 300) : null,
      });
      return {
        quiz_run_id: run.id,
        resume_token: resumeToken,
        step: publicStep(definition, firstStep.id),
      };
    },

    async answer(input) {
      return pool.withTransaction(async (tx) => {
        const run = await loadLiveRun(input, tx);
        if (run.state !== "STARTED") {
          throw new FormsError("QUIZ_RUN_STATE_INVALID", `quiz run is ${run.state}`);
        }
        const definition = await definitionOf(run);
        const question = definition.steps
          .flatMap((step) => step.questions)
          .find((candidate) => candidate.id === input.question_id);
        if (!question) {
          throw new FormsError("QUIZ_ANSWER_INVALID", `unknown question "${input.question_id}"`, {
            details: { question_id: input.question_id, code: "unknown_question" },
          });
        }
        const value = validateAnswerValue(question, input.value);
        if (value === undefined) {
          const answers = new Map(
            (await deps.domain.runs.listAnswers(run.id)).map((a) => [a.question_id, a.value]),
          );
          const next = resolveNextStep(
            definition.steps,
            definition.branching_rules,
            stepOfQuestion(definition, question.id),
            lookupOf(answers),
          );
          return {
            state: "STARTED" as const,
            next_step: next.next_step === null ? null : publicStep(definition, next.next_step),
          };
        }
        await deps.domain.runs.upsertAnswer(run.id, question.id, value, { executor: tx });

        const answers = new Map(
          (await deps.domain.runs.listAnswers(run.id)).map((a) => [a.question_id, a.value]),
        );
        answers.set(question.id, value);
        const next = resolveNextStep(
          definition.steps,
          definition.branching_rules,
          stepOfQuestion(definition, question.id),
          lookupOf(answers),
        );
        return {
          state: "STARTED" as const,
          next_step: next.next_step === null ? null : publicStep(definition, next.next_step),
        };
      });
    },

    async complete(input) {
      return pool.withTransaction(async (tx) => {
        const run = await loadLiveRun(input, tx);
        if (run.state === "COMPLETED") {
          // Idempotent retry: replay the stored outcome, no new event/lead.
          const stored = await definitionOf(run);
          const outcome =
            stored.outcomes.find((candidate) => candidate.id === run.outcome_id) ?? null;
          return {
            state: "COMPLETED" as const,
            score: run.score,
            outcome:
              outcome === null
                ? null
                : {
                    id: outcome.id,
                    title: outcome.title,
                    ...(outcome.description === undefined
                      ? {}
                      : { description: outcome.description }),
                  },
            lead_id: run.lead_id,
          };
        }
        if (run.state !== "STARTED") {
          throw new FormsError("QUIZ_RUN_STATE_INVALID", `quiz run is ${run.state}`);
        }
        const definition = await definitionOf(run);
        const answerRows = await deps.domain.runs.listAnswers(run.id);
        const answers = new Map(answerRows.map((row) => [row.question_id, row.value]));
        assertRequiredAnswered(definition, answers);
        const lookup = lookupOf(answers);
        const score = computeScore(definition.scoring_rules, lookup);
        const outcome = resolveOutcome(definition.outcomes, score);

        await deps.outbox.write(
          tx,
          quizCompletedEvent({
            quiz_run_id: run.id,
            quiz_definition_id: run.quiz_definition_id,
            quiz_schema_version: run.quiz_schema_version,
            ...(outcome === null ? {} : { outcome_id: outcome.id }),
            ...(definition.scoring_rules.length > 0 ? { score } : {}),
          }),
        );

        const lead = await createLeadFromQuizRun(
          deps.domain.leads,
          definition,
          run,
          answers,
          outcome,
          tx,
          deps.outbox,
        );
        await deps.domain.runs.completeRun(
          run.id,
          { score, outcome_id: outcome?.id ?? null, lead_id: lead?.lead_id ?? null },
          { executor: tx },
        );
        return {
          state: "COMPLETED" as const,
          score: definition.scoring_rules.length > 0 ? score : null,
          outcome:
            outcome === null
              ? null
              : {
                  id: outcome.id,
                  title: outcome.title,
                  ...(outcome.description === undefined
                    ? {}
                    : { description: outcome.description }),
                },
          lead_id: lead?.lead_id ?? null,
        };
      });
    },

    async abandon(input) {
      return pool.withTransaction(async (tx) => {
        const run = await loadLiveRun(input, tx);
        if (run.state !== "STARTED") {
          throw new FormsError("QUIZ_RUN_STATE_INVALID", `quiz run is ${run.state}`);
        }
        await deps.domain.runs.markRun(run.id, "ABANDONED", { executor: tx });
        return { state: "ABANDONED" as const };
      });
    },

    async getPublicSchema(quiz_definition_id) {
      const definition = await deps.domain.quizzes.getDefinition(quiz_definition_id);
      if (definition.status !== "ACTIVE") {
        throw new FormsError(
          "QUIZ_DEFINITION_NOT_FOUND",
          `quiz definition ${quiz_definition_id} is not available`,
        );
      }
      return {
        quiz_definition_id: definition.id,
        quiz_schema_version: definition.schema_version,
        steps: definition.steps.map((step) => publicStep(definition, step.id)),
      };
    },
  };
}

function stepOfQuestion(definition: QuizDefinition, question_id: string): string {
  const step = definition.steps.find((candidate) =>
    candidate.questions.some((question) => question.id === question_id),
  );
  if (!step) throw new FormsError("QUIZ_ANSWER_INVALID", `question "${question_id}" has no step`);
  return step.id;
}

async function createLeadFromQuizRun(
  leads: LeadService,
  definition: QuizDefinition,
  run: QuizRunRecord,
  answers: ReadonlyMap<string, unknown>,
  outcome: {
    readonly id: string;
    readonly title?: string;
    readonly lead_classification?: string;
  } | null,
  tx: DbClient,
  outbox: FormsOutboxPort,
): Promise<{ lead_id: string } | null> {
  const policy = definition.settings.lead_policy;
  if (policy?.create_lead !== true) return null;
  // Consent gate (owner refinement §4): when a consent question is
  // configured, a not-true answer means the quiz result stays in PCMS —
  // no lead row and no LeadCreated event, so HQ can never receive a silent
  // anonymous intake from a declined consent.
  if (policy.consent_from !== undefined) {
    const consentAnswer = answers.get(policy.consent_from);
    if (consentAnswer !== true) return null;
  }
  const contactAnswer = (questionId: string | undefined): string | null => {
    if (questionId === undefined) return null;
    const value = answers.get(questionId);
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  const summaryAnswer =
    policy.summary_from_answer === undefined ? undefined : answers.get(policy.summary_from_answer);
  const summary =
    typeof summaryAnswer === "string" && summaryAnswer.trim() !== ""
      ? summaryAnswer.trim()
      : `Quiz (outcome: ${outcome?.id ?? "none"})`;
  // Readable representation of THIS run (owner refinement): fixed answers
  // with question labels plus the outcome — built once, stored immutably.
  const presentation = renderLeadPresentation({
    title:
      outcome === null
        ? `Quiz "${definition.title}"`
        : `Quiz "${definition.title}" — outcome: ${outcome.title ?? outcome.id}`,
    entries: definition.steps.flatMap((step) =>
      step.questions.map((question) => ({
        label: question.label,
        value: answers.get(question.id),
      })),
    ),
  });
  const { lead, created } = await leads.createLead(
    {
      source_type: "QUIZ_RUN",
      source_id: run.id,
      attribution: run.attribution,
      summary,
      classification: policy.classification ?? outcome?.lead_classification ?? null,
      name: contactAnswer(policy.name_from),
      email: contactAnswer(policy.email_from),
      phone: contactAnswer(policy.phone_from),
      presentation,
    },
    { executor: tx },
  );
  if (created) {
    const classification = policy.classification ?? outcome?.lead_classification;
    await outbox.write(
      tx,
      leadCreatedEvent({
        lead_id: lead.id,
        source_type: "QUIZ_RUN",
        source_id: run.id,
        ...(classification === undefined ? {} : { classification }),
      }),
    );
  }
  return { lead_id: lead.id };
}
