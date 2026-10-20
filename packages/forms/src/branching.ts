// Declarative branching evaluator (PCMS-FORM-T005; Forms spec §13). Rules and
// answers are plain data; evaluation is a pure, deterministic function — no
// eval, no Function constructor, no arbitrary JS (spec §43.10). The theme
// never runs this: branching is server-authoritative.
import type { QuizBranchCondition, QuizBranchRule, QuizStep } from "./quiz-definitions.js";

/** Normalized answer value for one question. */
export type QuizAnswerValue = string | number | boolean | readonly string[];

/** Answer lookup: only "has the client actually answered this" plus the
 * value. Keeps the evaluator pure and trivially testable. */
export type AnswerLookup = (question_id: string) => {
  readonly answered: boolean;
  readonly value?: QuizAnswerValue;
};

function isBlank(value: QuizAnswerValue | undefined): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return value === null || value === "";
}

function compareOrdered(
  operator: "gt" | "gte" | "lt" | "lte",
  answer: QuizAnswerValue,
  operand: unknown,
): boolean {
  if (typeof answer === "boolean" || Array.isArray(answer)) return false;
  const left = typeof answer === "number" ? answer : Number(String(answer).trim());
  const right = typeof operand === "number" ? operand : Number(operand);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator === "gt") return left > right;
  if (operator === "gte") return left >= right;
  if (operator === "lt") return left < right;
  return left <= right;
}

function valuesEqual(answer: QuizAnswerValue, operand: unknown): boolean {
  if (Array.isArray(answer)) return answer.includes(operand as string);
  return answer === operand;
}

function answerIntersects(answer: QuizAnswerValue, operand: readonly unknown[]): boolean {
  if (Array.isArray(answer)) return answer.some((entry) => operand.includes(entry));
  return operand.includes(answer);
}

export function evaluateCondition(condition: QuizBranchCondition, lookup: AnswerLookup): boolean {
  const { answered, value } = lookup(condition.question_id);
  if (condition.operator === "answered") {
    return answered && !isBlank(value);
  }
  if (!answered || isBlank(value) || value === undefined) return false;
  switch (condition.operator) {
    case "eq":
      return valuesEqual(value, condition.value);
    case "neq":
      return !valuesEqual(value, condition.value);
    case "in":
      return Array.isArray(condition.value) && answerIntersects(value, condition.value);
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compareOrdered(condition.operator, value, condition.value);
  }
}

export interface BranchingDecision {
  /** Id of the next step to present, or null when the quiz path is done. */
  readonly next_step: string | null;
  /** The rule that matched, if any (audit/diagnostics only — no answers). */
  readonly matched_rule: number | null;
}

/**
 * Resolves the step to present after `from_step` was answered: the first
 * matching rule (declared order) wins; otherwise the next declared step;
 * otherwise the run is ready to complete.
 */
export function resolveNextStep(
  steps: readonly QuizStep[],
  branching_rules: readonly QuizBranchRule[],
  from_step: string,
  lookup: AnswerLookup,
): BranchingDecision {
  const rules = branching_rules.filter((rule) => rule.from_step === from_step);
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index]!;
    if (rule.when.every((condition) => evaluateCondition(condition, lookup))) {
      return { next_step: rule.goto_step, matched_rule: index };
    }
  }
  const position = steps.findIndex((step) => step.id === from_step);
  const next = position >= 0 ? steps[position + 1] : undefined;
  return { next_step: next?.id ?? null, matched_rule: null };
}
