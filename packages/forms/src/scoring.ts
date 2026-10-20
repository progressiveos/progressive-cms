// Declarative scoring and outcome resolution (PCMS-FORM-T006; Forms spec
// §14/§15). Server-authoritative: the client score/outcome is never accepted
// as truth (spec §12). Reuses the branching condition evaluator — same
// operators, same determinism, still no eval.
import { type AnswerLookup, evaluateCondition } from "./branching.js";
import type { QuizOutcome, QuizScoringRule } from "./quiz-definitions.js";

/** Sum of points over matching rules, in declared rule order. Deterministic:
 * identical answers + rules always produce an identical score. */
export function computeScore(
  scoring_rules: readonly QuizScoringRule[],
  lookup: AnswerLookup,
): number {
  let score = 0;
  for (const rule of scoring_rules) {
    const condition = {
      question_id: rule.question_id,
      operator: rule.operator,
      ...(rule.value === undefined ? {} : { value: rule.value }),
    };
    if (evaluateCondition(condition, lookup)) score += rule.points;
  }
  return score;
}

/** First declared outcome whose score range contains `score`; outcomes
 * without bounds match any score. Null when no outcome matches. */
export function resolveOutcome(
  outcomes: readonly QuizOutcome[],
  score: number,
): QuizOutcome | null {
  for (const outcome of outcomes) {
    const min = outcome.min_score ?? -Infinity;
    const max = outcome.max_score ?? Infinity;
    if (score >= min && score <= max) return outcome;
  }
  return null;
}
