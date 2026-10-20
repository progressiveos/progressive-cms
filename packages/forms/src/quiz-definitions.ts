// QuizDefinition domain (PCMS-FORM-T004; Forms spec §9–§15). Quiz is a
// first-class stateful interaction — not a disguised form. Definitions are
// stable identities with immutable versions; branching/scoring are
// *declarative* documents validated here and evaluated by branching.ts /
// scoring.ts (T005/T006). No arbitrary JavaScript anywhere (spec §43.10).
import type { DbPool } from "@pcms/core";
import { newStableId } from "@pcms/core";
import { FormsError } from "./errors.js";
import {
  asRecord,
  assertMachineKey,
  assertOptionValue,
  boundedInt,
  boundedText,
  oneOf,
  optionalText,
  parseRetentionPolicy,
  rejectUnknownKeys,
} from "./validate.js";

export const QUIZ_QUESTION_TYPES_V1 = [
  "single_choice",
  "multiple_choice",
  "text",
  "number",
  "boolean",
] as const;

export type QuizQuestionType = (typeof QUIZ_QUESTION_TYPES_V1)[number];

/** Baseline declarative operators (spec §13). Shared by branching (T005) and
 * scoring (T006); evaluation is deterministic and eval-free. */
export const QUIZ_OPERATORS_V1 = ["eq", "neq", "in", "gt", "gte", "lt", "lte", "answered"] as const;

export type QuizOperator = (typeof QUIZ_OPERATORS_V1)[number];

export interface QuizQuestionOption {
  readonly value: string;
  readonly label: string;
}

export interface QuizQuestion {
  readonly id: string;
  readonly type: QuizQuestionType;
  readonly label: string;
  readonly required?: boolean;
  readonly help?: string;
  readonly options?: readonly QuizQuestionOption[];
  readonly min?: number;
  readonly max?: number;
  readonly max_length?: number;
}

export interface QuizStep {
  readonly id: string;
  readonly title?: string;
  readonly questions: readonly QuizQuestion[];
}

/** ALL conditions must match (AND). `value` is the comparison operand;
 * `answered` ignores it. */
export interface QuizBranchCondition {
  readonly question_id: string;
  readonly operator: QuizOperator;
  readonly value?: unknown;
}

export interface QuizBranchRule {
  /** Rule set evaluated after `from_step` is answered. */
  readonly from_step: string;
  readonly when: readonly QuizBranchCondition[];
  /** Target step id (jump); otherwise the next declared step applies. */
  readonly goto_step: string;
}

export interface QuizScoringRule {
  readonly question_id: string;
  readonly operator: QuizOperator;
  readonly value?: unknown;
  readonly points: number;
}

export interface QuizOutcome {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly min_score?: number;
  readonly max_score?: number;
  readonly lead_classification?: string;
}

export interface QuizLeadPolicy {
  readonly create_lead?: boolean;
  readonly classification?: string;
  readonly summary_from_answer?: string;
  /**
   * Contact mapping (PCMS→HQ pilot, owner refinement §4): explicit question
   * ids whose answers become the lead's contact fields. Only mapped fields
   * are copied; raw quiz answers are never exported anywhere. `consent_from`
   * references a boolean question — when set, a not-true consent means NO
   * lead and NO LeadCreated event at all (the quiz result stays in PCMS; HQ
   * never receives a silent anonymous intake from a declined consent).
   */
  readonly name_from?: string;
  readonly email_from?: string;
  readonly phone_from?: string;
  readonly consent_from?: string;
}

export interface QuizRetentionPolicy {
  readonly mode: "retain" | "anonymize" | "delete";
  readonly after_days?: number;
}

export interface QuizDefinitionSettings {
  readonly lead_policy?: QuizLeadPolicy;
  readonly retention?: QuizRetentionPolicy;
}

/** Flattened current view of a quiz definition. */
export interface QuizDefinition {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly schema_version: number;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly steps: readonly QuizStep[];
  readonly branching_rules: readonly QuizBranchRule[];
  readonly scoring_rules: readonly QuizScoringRule[];
  readonly outcomes: readonly QuizOutcome[];
  readonly settings: QuizDefinitionSettings;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface QuizDefinitionVersionRecord {
  readonly quiz_definition_id: string;
  /** Definition-row attributes (identity lives on the definition, not the
   * immutable version); the version supplies schema content only. */
  readonly key: string;
  readonly title: string;
  readonly schema_version: number;
  readonly steps: readonly QuizStep[];
  readonly branching_rules: readonly QuizBranchRule[];
  readonly scoring_rules: readonly QuizScoringRule[];
  readonly outcomes: readonly QuizOutcome[];
  readonly settings: QuizDefinitionSettings;
  readonly created_at: string;
}

const MAX_STEPS = 50;
const MAX_QUESTIONS_PER_STEP = 20;
const MAX_BRANCH_RULES = 100;
const MAX_SCORING_RULES = 200;
const MAX_OUTCOMES = 50;

const QUESTION_KEYS = [
  "id",
  "type",
  "label",
  "required",
  "help",
  "options",
  "min",
  "max",
  "max_length",
];

function validateQuestion(value: unknown, stepId: string): QuizQuestion {
  const raw = asRecord(value, "QUIZ_DEFINITION_INVALID", `step "${stepId}" question`);
  rejectUnknownKeys(raw, QUESTION_KEYS, "QUIZ_DEFINITION_INVALID", `step "${stepId}" question`);
  const id = assertMachineKey(raw.id, "QUIZ_DEFINITION_INVALID", `step "${stepId}" question id`);
  const where = `question "${id}"`;
  const type = oneOf(
    raw.type,
    QUIZ_QUESTION_TYPES_V1,
    "QUIZ_QUESTION_UNSUPPORTED",
    `${where} type`,
  );
  const question: { -readonly [K in keyof QuizQuestion]?: QuizQuestion[K] } = {
    id,
    type,
    label: boundedText(raw.label, "QUIZ_DEFINITION_INVALID", `${where} label`, 1000),
  };
  if (raw.required !== undefined) {
    if (typeof raw.required !== "boolean") {
      throw new FormsError("QUIZ_DEFINITION_INVALID", `${where} required must be boolean`);
    }
    question.required = raw.required;
  }
  assign(question, "help", optionalText(raw.help, "QUIZ_DEFINITION_INVALID", `${where} help`, 500));
  if (type === "single_choice" || type === "multiple_choice") {
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 500) {
      throw new FormsError("QUIZ_DEFINITION_INVALID", `${where} options must be 2..500 entries`);
    }
    const seen = new Set<string>();
    question.options = raw.options.map((option) => {
      const record = asRecord(option, "QUIZ_DEFINITION_INVALID", `${where} option`);
      rejectUnknownKeys(record, ["value", "label"], "QUIZ_DEFINITION_INVALID", `${where} option`);
      const optionValue = assertOptionValue(
        record.value,
        "QUIZ_DEFINITION_INVALID",
        `${where} option value`,
      );
      if (seen.has(optionValue)) {
        throw new FormsError(
          "QUIZ_DEFINITION_INVALID",
          `${where} has duplicate option "${optionValue}"`,
        );
      }
      seen.add(optionValue);
      return {
        value: optionValue,
        label: boundedText(record.label, "QUIZ_DEFINITION_INVALID", `${where} option label`, 300),
      };
    });
  }
  if (raw.min !== undefined)
    assign(
      question,
      "min",
      boundedInt(raw.min, "QUIZ_DEFINITION_INVALID", `${where} min`, -1e12, 1e12),
    );
  if (raw.max !== undefined)
    assign(
      question,
      "max",
      boundedInt(raw.max, "QUIZ_DEFINITION_INVALID", `${where} max`, -1e12, 1e12),
    );
  if (question.min !== undefined && question.max !== undefined && question.min > question.max) {
    throw new FormsError("QUIZ_DEFINITION_INVALID", `${where} min exceeds max`);
  }
  if (raw.max_length !== undefined) {
    assign(
      question,
      "max_length",
      boundedInt(raw.max_length, "QUIZ_DEFINITION_INVALID", `${where} max_length`, 1, 5000),
    );
  }
  return question as QuizQuestion;
}

function assign<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

export function validateQuizSteps(value: unknown): QuizStep[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STEPS) {
    throw new FormsError("QUIZ_DEFINITION_INVALID", `steps must be 1..${MAX_STEPS} entries`);
  }
  const stepIds = new Set<string>();
  const questionIds = new Set<string>();
  return value.map((entry) => {
    const raw = asRecord(entry, "QUIZ_DEFINITION_INVALID", "step");
    rejectUnknownKeys(raw, ["id", "title", "questions"], "QUIZ_DEFINITION_INVALID", "step");
    const id = assertMachineKey(raw.id, "QUIZ_DEFINITION_INVALID", "step id");
    if (stepIds.has(id))
      throw new FormsError("QUIZ_DEFINITION_INVALID", `duplicate step id "${id}"`);
    stepIds.add(id);
    if (
      !Array.isArray(raw.questions) ||
      raw.questions.length === 0 ||
      raw.questions.length > MAX_QUESTIONS_PER_STEP
    ) {
      throw new FormsError(
        "QUIZ_DEFINITION_INVALID",
        `step "${id}" questions must be 1..${MAX_QUESTIONS_PER_STEP} entries`,
      );
    }
    const questions = raw.questions.map((question) => {
      const validated = validateQuestion(question, id);
      if (questionIds.has(validated.id)) {
        throw new FormsError("QUIZ_DEFINITION_INVALID", `duplicate question id "${validated.id}"`);
      }
      questionIds.add(validated.id);
      return validated;
    });
    const step: { -readonly [K in keyof QuizStep]?: QuizStep[K] } = { id, questions };
    assign(
      step,
      "title",
      optionalText(raw.title, "QUIZ_DEFINITION_INVALID", `step "${id}" title`, 300),
    );
    return step as QuizStep;
  });
}

function validateCondition(
  value: unknown,
  questionIds: Set<string>,
  label: string,
): QuizBranchCondition {
  const raw = asRecord(value, "QUIZ_DEFINITION_INVALID", `${label} condition`);
  rejectUnknownKeys(
    raw,
    ["question_id", "operator", "value"],
    "QUIZ_DEFINITION_INVALID",
    `${label} condition`,
  );
  const questionId = assertMachineKey(
    raw.question_id,
    "QUIZ_DEFINITION_INVALID",
    `${label} condition question_id`,
  );
  if (!questionIds.has(questionId)) {
    throw new FormsError(
      "QUIZ_DEFINITION_INVALID",
      `${label} condition references unknown question "${questionId}"`,
    );
  }
  const operator = oneOf(
    raw.operator,
    QUIZ_OPERATORS_V1,
    "QUIZ_DEFINITION_INVALID",
    `${label} condition operator`,
  );
  const condition: { -readonly [K in keyof QuizBranchCondition]?: QuizBranchCondition[K] } = {
    question_id: questionId,
    operator,
  };
  if (operator === "in") {
    if (
      !Array.isArray(raw.value) ||
      raw.value.length === 0 ||
      raw.value.length > 500 ||
      raw.value.some((entry) => typeof entry !== "string" && typeof entry !== "number")
    ) {
      throw new FormsError(
        "QUIZ_DEFINITION_INVALID",
        `${label} condition "in" value must be 1..500 strings/numbers`,
      );
    }
    condition.value = [...raw.value];
  } else if (operator !== "answered") {
    if (
      typeof raw.value !== "string" &&
      typeof raw.value !== "number" &&
      typeof raw.value !== "boolean"
    ) {
      throw new FormsError(
        "QUIZ_DEFINITION_INVALID",
        `${label} condition value must be string/number/boolean`,
      );
    }
    condition.value = raw.value;
  }
  return condition as QuizBranchCondition;
}

export function validateBranchingRules(
  value: unknown,
  steps: readonly QuizStep[],
): QuizBranchRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_BRANCH_RULES) {
    throw new FormsError(
      "QUIZ_DEFINITION_INVALID",
      `branching_rules must be ≤ ${MAX_BRANCH_RULES} entries`,
    );
  }
  const stepIds = new Set(steps.map((step) => step.id));
  const questionIds = new Set(
    steps.flatMap((step) => step.questions.map((question) => question.id)),
  );
  return value.map((entry) => {
    const raw = asRecord(entry, "QUIZ_DEFINITION_INVALID", "branching rule");
    rejectUnknownKeys(
      raw,
      ["from_step", "when", "goto_step"],
      "QUIZ_DEFINITION_INVALID",
      "branching rule",
    );
    const fromStep = assertMachineKey(
      raw.from_step,
      "QUIZ_DEFINITION_INVALID",
      "branching rule from_step",
    );
    const gotoStep = assertMachineKey(
      raw.goto_step,
      "QUIZ_DEFINITION_INVALID",
      "branching rule goto_step",
    );
    if (!stepIds.has(fromStep)) {
      throw new FormsError(
        "QUIZ_DEFINITION_INVALID",
        `branching rule references unknown step "${fromStep}"`,
      );
    }
    if (!stepIds.has(gotoStep)) {
      throw new FormsError(
        "QUIZ_DEFINITION_INVALID",
        `branching rule jumps to unknown step "${gotoStep}"`,
      );
    }
    if (!Array.isArray(raw.when) || raw.when.length === 0 || raw.when.length > 20) {
      throw new FormsError(
        "QUIZ_DEFINITION_INVALID",
        `branching rule "when" must be 1..20 conditions`,
      );
    }
    return {
      from_step: fromStep,
      when: raw.when.map((condition) => validateCondition(condition, questionIds, "branching")),
      goto_step: gotoStep,
    };
  });
}

export function validateScoringRules(
  value: unknown,
  steps: readonly QuizStep[],
): QuizScoringRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SCORING_RULES) {
    throw new FormsError(
      "QUIZ_DEFINITION_INVALID",
      `scoring_rules must be ≤ ${MAX_SCORING_RULES} entries`,
    );
  }
  const questionIds = new Set(
    steps.flatMap((step) => step.questions.map((question) => question.id)),
  );
  return value.map((entry) => {
    const raw = asRecord(entry, "QUIZ_DEFINITION_INVALID", "scoring rule");
    rejectUnknownKeys(
      raw,
      ["question_id", "operator", "value", "points"],
      "QUIZ_DEFINITION_INVALID",
      "scoring rule",
    );
    const questionId = assertMachineKey(
      raw.question_id,
      "QUIZ_DEFINITION_INVALID",
      "scoring rule question_id",
    );
    if (!questionIds.has(questionId)) {
      throw new FormsError(
        "QUIZ_DEFINITION_INVALID",
        `scoring rule references unknown question "${questionId}"`,
      );
    }
    const operator = oneOf(
      raw.operator,
      QUIZ_OPERATORS_V1,
      "QUIZ_DEFINITION_INVALID",
      "scoring rule operator",
    );
    const points = boundedInt(
      raw.points,
      "QUIZ_DEFINITION_INVALID",
      "scoring rule points",
      -10_000,
      10_000,
    );
    const rule: { -readonly [K in keyof QuizScoringRule]?: QuizScoringRule[K] } = {
      question_id: questionId,
      operator,
      points,
    };
    if (operator === "in") {
      if (
        !Array.isArray(raw.value) ||
        raw.value.length === 0 ||
        raw.value.length > 500 ||
        raw.value.some((entry) => typeof entry !== "string" && typeof entry !== "number")
      ) {
        throw new FormsError(
          "QUIZ_DEFINITION_INVALID",
          `scoring rule "in" value must be 1..500 strings/numbers`,
        );
      }
      rule.value = [...raw.value];
    } else if (operator !== "answered") {
      if (
        typeof raw.value !== "string" &&
        typeof raw.value !== "number" &&
        typeof raw.value !== "boolean"
      ) {
        throw new FormsError(
          "QUIZ_DEFINITION_INVALID",
          "scoring rule value must be string/number/boolean",
        );
      }
      rule.value = raw.value;
    }
    return rule as QuizScoringRule;
  });
}

export function validateOutcomes(value: unknown): QuizOutcome[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_OUTCOMES) {
    throw new FormsError("QUIZ_DEFINITION_INVALID", `outcomes must be ≤ ${MAX_OUTCOMES} entries`);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const raw = asRecord(entry, "QUIZ_DEFINITION_INVALID", "outcome");
    rejectUnknownKeys(
      raw,
      ["id", "title", "description", "min_score", "max_score", "lead_classification"],
      "QUIZ_DEFINITION_INVALID",
      "outcome",
    );
    const id = assertMachineKey(raw.id, "QUIZ_DEFINITION_INVALID", "outcome id");
    if (seen.has(id))
      throw new FormsError("QUIZ_DEFINITION_INVALID", `duplicate outcome id "${id}"`);
    seen.add(id);
    const outcome: { -readonly [K in keyof QuizOutcome]?: QuizOutcome[K] } = {
      id,
      title: boundedText(raw.title, "QUIZ_DEFINITION_INVALID", `outcome "${id}" title`, 300),
    };
    assign(
      outcome,
      "description",
      optionalText(raw.description, "QUIZ_DEFINITION_INVALID", `outcome "${id}" description`, 2000),
    );
    if (raw.min_score !== undefined)
      assign(
        outcome,
        "min_score",
        boundedInt(
          raw.min_score,
          "QUIZ_DEFINITION_INVALID",
          `outcome "${id}" min_score`,
          -1e9,
          1e9,
        ),
      );
    if (raw.max_score !== undefined)
      assign(
        outcome,
        "max_score",
        boundedInt(
          raw.max_score,
          "QUIZ_DEFINITION_INVALID",
          `outcome "${id}" max_score`,
          -1e9,
          1e9,
        ),
      );
    if (
      outcome.min_score !== undefined &&
      outcome.max_score !== undefined &&
      outcome.min_score > outcome.max_score
    ) {
      throw new FormsError(
        "QUIZ_DEFINITION_INVALID",
        `outcome "${id}" min_score exceeds max_score`,
      );
    }
    assign(
      outcome,
      "lead_classification",
      optionalText(
        raw.lead_classification,
        "QUIZ_DEFINITION_INVALID",
        `outcome "${id}" lead_classification`,
        100,
      ),
    );
    return outcome as QuizOutcome;
  });
}

function validateQuizSettings(value: unknown, steps: readonly QuizStep[]): QuizDefinitionSettings {
  const settings: { -readonly [K in keyof QuizDefinitionSettings]?: QuizDefinitionSettings[K] } =
    {};
  if (value === undefined || value === null) return settings;
  const raw = asRecord(value, "QUIZ_DEFINITION_INVALID", "settings");
  rejectUnknownKeys(raw, ["lead_policy", "retention"], "QUIZ_DEFINITION_INVALID", "settings");
  if (raw.lead_policy !== undefined) {
    const lp = asRecord(raw.lead_policy, "QUIZ_DEFINITION_INVALID", "settings.lead_policy");
    rejectUnknownKeys(
      lp,
      [
        "create_lead",
        "classification",
        "summary_from_answer",
        "name_from",
        "email_from",
        "phone_from",
        "consent_from",
      ],
      "QUIZ_DEFINITION_INVALID",
      "settings.lead_policy",
    );
    const policy: { -readonly [K in keyof QuizLeadPolicy]?: QuizLeadPolicy[K] } = {};
    if (lp.create_lead !== undefined) {
      if (typeof lp.create_lead !== "boolean") {
        throw new FormsError("QUIZ_DEFINITION_INVALID", "lead_policy.create_lead must be boolean");
      }
      policy.create_lead = lp.create_lead;
    }
    assign(
      policy,
      "classification",
      optionalText(lp.classification, "QUIZ_DEFINITION_INVALID", "lead_policy.classification", 100),
    );
    const summaryFrom = optionalText(
      lp.summary_from_answer,
      "QUIZ_DEFINITION_INVALID",
      "lead_policy.summary_from_answer",
      64,
    );
    if (summaryFrom !== undefined) {
      const questionIds = new Set(
        steps.flatMap((step) => step.questions.map((question) => question.id)),
      );
      if (!questionIds.has(summaryFrom)) {
        throw new FormsError(
          "QUIZ_DEFINITION_INVALID",
          `lead_policy.summary_from_answer references unknown question "${summaryFrom}"`,
        );
      }
      policy.summary_from_answer = summaryFrom;
    }
    // Contact mapping: every referenced question must exist, and its type
    // must make sense (contacts are free-text answers; consent is a boolean).
    const contactMappings: readonly [key: string, kind: "text" | "boolean"][] = [
      ["name_from", "text"],
      ["email_from", "text"],
      ["phone_from", "text"],
      ["consent_from", "boolean"],
    ];
    const questionById = new Map(
      steps.flatMap((step) => step.questions.map((question) => [question.id, question] as const)),
    );
    for (const [key, kind] of contactMappings) {
      const questionId = optionalText(lp[key], "QUIZ_DEFINITION_INVALID", `lead_policy.${key}`, 64);
      if (questionId === undefined) continue;
      const question = questionById.get(questionId);
      if (question === undefined) {
        throw new FormsError(
          "QUIZ_DEFINITION_INVALID",
          `lead_policy.${key} references unknown question "${questionId}"`,
        );
      }
      if (question.type !== kind) {
        throw new FormsError(
          "QUIZ_DEFINITION_INVALID",
          `lead_policy.${key} must reference a ${kind} question (got "${question.type}")`,
        );
      }
      if (key === "name_from") policy.name_from = questionId;
      else if (key === "email_from") policy.email_from = questionId;
      else if (key === "phone_from") policy.phone_from = questionId;
      else if (key === "consent_from") policy.consent_from = questionId;
    }
    settings.lead_policy = policy as QuizLeadPolicy;
  }
  if (raw.retention !== undefined) {
    settings.retention = parseRetentionPolicy<QuizRetentionPolicy>(
      raw.retention,
      "QUIZ_DEFINITION_INVALID",
    );
  }
  return settings;
}

interface QuizDefinitionRow {
  readonly [column: string]: unknown;
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly current_schema_version: number;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface QuizVersionRow {
  readonly [column: string]: unknown;
  readonly quiz_definition_id: string;
  readonly key: string;
  readonly title: string;
  readonly schema_version: number;
  readonly steps: unknown;
  readonly branching_rules: unknown;
  readonly scoring_rules: unknown;
  readonly outcomes: unknown;
  readonly settings: unknown;
  readonly created_at: Date;
}

export interface CreateQuizDefinitionInput {
  readonly key: string;
  readonly title: string;
  readonly steps: unknown;
  readonly branching_rules?: unknown;
  readonly scoring_rules?: unknown;
  readonly outcomes?: unknown;
  readonly settings?: unknown;
}

export interface AddQuizDefinitionVersionInput {
  readonly quiz_definition_id: string;
  readonly title?: string;
  readonly steps: unknown;
  readonly branching_rules?: unknown;
  readonly scoring_rules?: unknown;
  readonly outcomes?: unknown;
  readonly settings?: unknown;
}

export interface QuizDefinitionService {
  createDefinition(input: CreateQuizDefinitionInput): Promise<QuizDefinition>;
  addVersion(input: AddQuizDefinitionVersionInput): Promise<QuizDefinition>;
  listDefinitions(options?: {
    readonly status?: "ACTIVE" | "ARCHIVED";
  }): Promise<readonly QuizDefinition[]>;
  getDefinition(quiz_definition_id: string): Promise<QuizDefinition>;
  getVersion(
    quiz_definition_id: string,
    schema_version: number,
  ): Promise<QuizDefinitionVersionRecord>;
  getDefinitionByKey(key: string): Promise<QuizDefinition>;
  setArchived(quiz_definition_id: string, archived: boolean): Promise<QuizDefinition>;
}

const QUIZ_JOIN_SQL = `
  SELECT d.id, d.key, d.title, d.current_schema_version, d.status, d.created_at, d.updated_at,
         v.schema_version, v.steps, v.branching_rules, v.scoring_rules, v.outcomes, v.settings,
         v.created_at AS version_created_at
  FROM forms_quiz_definitions d
  JOIN forms_quiz_definition_versions v
    ON v.quiz_definition_id = d.id AND v.schema_version = d.current_schema_version`;

function rowToDefinition(row: Readonly<Record<string, unknown>>): QuizDefinition {
  return {
    id: row.id as string,
    key: row.key as string,
    title: row.title as string,
    schema_version: row.schema_version as number,
    status: row.status as "ACTIVE" | "ARCHIVED",
    steps: row.steps as readonly QuizStep[],
    branching_rules: row.branching_rules as readonly QuizBranchRule[],
    scoring_rules: row.scoring_rules as readonly QuizScoringRule[],
    outcomes: row.outcomes as readonly QuizOutcome[],
    settings: row.settings as QuizDefinitionSettings,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

export function createQuizDefinitionService(pool: DbPool): QuizDefinitionService {
  return {
    async createDefinition(input) {
      const key = assertMachineKey(input.key, "QUIZ_DEFINITION_INVALID", "definition key");
      const title = boundedText(input.title, "QUIZ_DEFINITION_INVALID", "title", 300);
      const steps = validateQuizSteps(input.steps);
      const branching = validateBranchingRules(input.branching_rules, steps);
      const scoring = validateScoringRules(input.scoring_rules, steps);
      const outcomes = validateOutcomes(input.outcomes);
      const settings = validateQuizSettings(input.settings, steps);
      const id = newStableId();
      return pool.withTransaction(async (tx) => {
        const inserted = await tx.query<QuizDefinitionRow>(
          `INSERT INTO forms_quiz_definitions (id, key, title) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO NOTHING
           RETURNING id, key, title, current_schema_version, status, created_at, updated_at`,
          [id, key, title],
        );
        if (inserted.rows.length !== 1) {
          throw new FormsError("QUIZ_KEY_TAKEN", `quiz definition key "${key}" already exists`);
        }
        await tx.query(
          `INSERT INTO forms_quiz_definition_versions
             (quiz_definition_id, schema_version, steps, branching_rules, scoring_rules, outcomes, settings)
           VALUES ($1, 1, $2, $3, $4, $5, $6)`,
          [
            id,
            JSON.stringify(steps),
            JSON.stringify(branching),
            JSON.stringify(scoring),
            JSON.stringify(outcomes),
            JSON.stringify(settings),
          ],
        );
        return {
          id,
          key,
          title,
          schema_version: 1,
          status: "ACTIVE" as const,
          steps,
          branching_rules: branching,
          scoring_rules: scoring,
          outcomes,
          settings,
          created_at: inserted.rows[0]!.created_at.toISOString(),
          updated_at: inserted.rows[0]!.updated_at.toISOString(),
        };
      });
    },

    async addVersion(input) {
      const title =
        input.title === undefined
          ? undefined
          : boundedText(input.title, "QUIZ_DEFINITION_INVALID", "title", 300);
      const steps = validateQuizSteps(input.steps);
      const branching = validateBranchingRules(input.branching_rules, steps);
      const scoring = validateScoringRules(input.scoring_rules, steps);
      const outcomes = validateOutcomes(input.outcomes);
      const settings = validateQuizSettings(input.settings, steps);
      return pool.withTransaction(async (tx) => {
        const current = await tx.query<QuizDefinitionRow>(
          `SELECT id, key, title, current_schema_version, status, created_at, updated_at
           FROM forms_quiz_definitions WHERE id = $1 FOR UPDATE`,
          [input.quiz_definition_id],
        );
        if (current.rows.length !== 1) {
          throw new FormsError(
            "QUIZ_DEFINITION_NOT_FOUND",
            `quiz definition ${input.quiz_definition_id} not found`,
          );
        }
        const row = current.rows[0]!;
        const nextVersion = row.current_schema_version + 1;
        const updated = await tx.query<QuizDefinitionRow>(
          `UPDATE forms_quiz_definitions
           SET current_schema_version = $2, updated_at = now(), title = COALESCE($3, title)
           WHERE id = $1
           RETURNING id, key, title, current_schema_version, status, created_at, updated_at`,
          [row.id, nextVersion, title ?? null],
        );
        await tx.query(
          `INSERT INTO forms_quiz_definition_versions
             (quiz_definition_id, schema_version, steps, branching_rules, scoring_rules, outcomes, settings)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            row.id,
            nextVersion,
            JSON.stringify(steps),
            JSON.stringify(branching),
            JSON.stringify(scoring),
            JSON.stringify(outcomes),
            JSON.stringify(settings),
          ],
        );
        return {
          id: row.id,
          key: row.key,
          title: updated.rows[0]!.title,
          schema_version: nextVersion,
          status: row.status as "ACTIVE" | "ARCHIVED",
          steps,
          branching_rules: branching,
          scoring_rules: scoring,
          outcomes,
          settings,
          created_at: row.created_at.toISOString(),
          updated_at: updated.rows[0]!.updated_at.toISOString(),
        };
      });
    },

    async listDefinitions(options) {
      const filter = options?.status ?? undefined;
      const result =
        filter === undefined
          ? await pool.query(`${QUIZ_JOIN_SQL} ORDER BY d.created_at DESC, d.id LIMIT 500`)
          : await pool.query(
              `${QUIZ_JOIN_SQL} WHERE d.status = $1 ORDER BY d.created_at DESC, d.id LIMIT 500`,
              [filter],
            );
      return result.rows.map(rowToDefinition);
    },

    async getDefinition(quiz_definition_id) {
      const result = await pool.query(`${QUIZ_JOIN_SQL} WHERE d.id = $1`, [quiz_definition_id]);
      if (result.rows.length !== 1) {
        throw new FormsError(
          "QUIZ_DEFINITION_NOT_FOUND",
          `quiz definition ${quiz_definition_id} not found`,
        );
      }
      return rowToDefinition(result.rows[0]!);
    },

    async getVersion(quiz_definition_id, schema_version) {
      const result = await pool.query<QuizVersionRow>(
        `SELECT d.key, d.title, v.quiz_definition_id, v.schema_version, v.steps,
                v.branching_rules, v.scoring_rules, v.outcomes, v.settings, v.created_at
         FROM forms_quiz_definition_versions v
         JOIN forms_quiz_definitions d ON d.id = v.quiz_definition_id
         WHERE v.quiz_definition_id = $1 AND v.schema_version = $2`,
        [quiz_definition_id, schema_version],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row) {
        throw new FormsError(
          "QUIZ_DEFINITION_NOT_FOUND",
          `quiz definition ${quiz_definition_id} version ${schema_version} not found`,
        );
      }
      return {
        quiz_definition_id: row.quiz_definition_id,
        key: row.key as string,
        title: row.title as string,
        schema_version: row.schema_version,
        steps: row.steps as readonly QuizStep[],
        branching_rules: row.branching_rules as readonly QuizBranchRule[],
        scoring_rules: row.scoring_rules as readonly QuizScoringRule[],
        outcomes: row.outcomes as readonly QuizOutcome[],
        settings: row.settings as QuizDefinitionSettings,
        created_at: row.created_at.toISOString(),
      };
    },

    async getDefinitionByKey(key) {
      const result = await pool.query(`${QUIZ_JOIN_SQL} WHERE d.key = $1`, [key]);
      if (result.rows.length !== 1) {
        throw new FormsError("QUIZ_DEFINITION_NOT_FOUND", `quiz definition "${key}" not found`);
      }
      return rowToDefinition(result.rows[0]!);
    },

    async setArchived(quiz_definition_id, archived) {
      const result = await pool.query<QuizDefinitionRow>(
        `UPDATE forms_quiz_definitions SET status = $2, updated_at = now() WHERE id = $1
         RETURNING id, key, title, current_schema_version, status, created_at, updated_at`,
        [quiz_definition_id, archived ? "ARCHIVED" : "ACTIVE"],
      );
      if (result.rows.length !== 1) {
        throw new FormsError(
          "QUIZ_DEFINITION_NOT_FOUND",
          `quiz definition ${quiz_definition_id} not found`,
        );
      }
      const definition = await pool.query(`${QUIZ_JOIN_SQL} WHERE d.id = $1`, [quiz_definition_id]);
      return rowToDefinition(definition.rows[0]!);
    },
  };
}
