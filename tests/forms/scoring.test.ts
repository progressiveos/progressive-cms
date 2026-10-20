// PCMS-FORM-T006 — declarative scoring/outcome evaluator: server
// authoritative, deterministic, range-priority outcomes (Forms spec §14/§15).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { QuizOutcome, QuizScoringRule } from "@pcms/forms";
import { type AnswerLookup, computeScore, resolveOutcome } from "@pcms/forms";

function lookupFrom(answers: Record<string, unknown>): AnswerLookup {
  return (questionId) => {
    if (!(questionId in answers)) return { answered: false };
    return { answered: true, value: answers[questionId] as never };
  };
}

const RULES: readonly QuizScoringRule[] = [
  { question_id: "area", operator: "gte", value: 100, points: 20 },
  { question_id: "urgency", operator: "eq", value: "asap", points: 15 },
  { question_id: "rooms", operator: "eq", value: "3p", points: 10 },
  { question_id: "budget_unknown", operator: "answered", points: -5 },
];

const OUTCOMES: readonly QuizOutcome[] = [
  { id: "hot", title: "Горячая заявка", min_score: 30, lead_classification: "hot" },
  { id: "warm", title: "Тёплая заявка", min_score: 10, max_score: 29, lead_classification: "warm" },
  { id: "cold", title: "Холодная заявка", lead_classification: "cold" },
];

test("score sums matching rules; negative points apply", () => {
  const hot = computeScore(RULES, lookupFrom({ area: 150, urgency: "asap", rooms: "3p" }));
  assert.equal(hot, 45);
  const partial = computeScore(RULES, lookupFrom({ area: 20, urgency: "asap" }));
  assert.equal(partial, 15);
  const penalized = computeScore(RULES, lookupFrom({ budget_unknown: "yes" }));
  assert.equal(penalized, -5);
});

test("score is deterministic and independent of answer key order", () => {
  const a = computeScore(RULES, lookupFrom({ area: 150, urgency: "asap" }));
  const b = computeScore(RULES, lookupFrom({ urgency: "asap", area: 150 }));
  assert.equal(a, b);
  for (let i = 0; i < 25; i++)
    assert.equal(computeScore(RULES, lookupFrom({ area: 150, urgency: "asap" })), a);
});

test("no rules → score 0; unanswered questions never match", () => {
  assert.equal(computeScore([], lookupFrom({ area: 999 })), 0);
  assert.equal(computeScore(RULES, lookupFrom({})), 0);
});

test("outcomes resolve by declared order with range priority", () => {
  assert.equal(resolveOutcome(OUTCOMES, 45)?.id, "hot");
  assert.equal(resolveOutcome(OUTCOMES, 30)?.id, "hot", "inclusive lower bound");
  assert.equal(resolveOutcome(OUTCOMES, 12)?.id, "warm");
  assert.equal(
    resolveOutcome(OUTCOMES, 5)?.id,
    "cold",
    "unbounded fallback matches everything left",
  );
  assert.equal(resolveOutcome(OUTCOMES, -3)?.id, "cold");
  assert.equal(resolveOutcome([], 10), null);
});

test("client-declared score is ignored by design: evaluation inputs are rules + server answers", () => {
  // The evaluator API accepts only server data — there is no parameter a
  // client score could reach. This test pins the contract shape.
  const score = computeScore(RULES, lookupFrom({ area: 150 }));
  assert.equal(score, 20);
  assert.equal(resolveOutcome(OUTCOMES, score)?.id, "warm");
});
