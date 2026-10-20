// PCMS-FORM-T005 — declarative branching evaluator: deterministic, eval-free,
// every baseline operator covered (Forms spec §13/§43.10).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { QuizBranchCondition, QuizBranchRule, QuizStep } from "@pcms/forms";
import { type AnswerLookup, evaluateCondition, resolveNextStep } from "@pcms/forms";

function lookupFrom(answers: Record<string, unknown>): AnswerLookup {
  return (questionId) => {
    if (!(questionId in answers)) return { answered: false };
    return { answered: true, value: answers[questionId] as never };
  };
}

const STEPS: readonly QuizStep[] = [
  { id: "intro", questions: [] },
  { id: "cleaning", questions: [] },
  { id: "contact", questions: [] },
];

const RULES: readonly QuizBranchRule[] = [
  {
    from_step: "intro",
    when: [{ question_id: "service", operator: "eq", value: "cleaning" }],
    goto_step: "cleaning",
  },
  {
    from_step: "intro",
    when: [{ question_id: "area", operator: "gte", value: 100 }],
    goto_step: "contact",
  },
];

test("eq jumps to the matching branch; non-match falls through to declared order", () => {
  const decision = resolveNextStep(STEPS, RULES, "intro", lookupFrom({ service: "cleaning" }));
  assert.deepEqual(decision, { next_step: "cleaning", matched_rule: 0 });
  const fallthrough = resolveNextStep(
    STEPS,
    RULES,
    "intro",
    lookupFrom({ service: "repair", area: 5 }),
  );
  assert.deepEqual(
    fallthrough,
    { next_step: "cleaning", matched_rule: null },
    "no rule → next declared step",
  );
});

test("ordered rules: first match wins, deterministic across repeats", () => {
  const answers = { service: "cleaning", area: 500 };
  const first = resolveNextStep(STEPS, RULES, "intro", lookupFrom(answers));
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(resolveNextStep(STEPS, RULES, "intro", lookupFrom(answers)), first);
  }
  assert.equal(first.next_step, "cleaning");
});

test("operator coverage: neq, in, gt, gte, lt, lte, answered", () => {
  const condition = (
    operator: QuizBranchCondition["operator"],
    value?: unknown,
    questionId = "q",
  ): QuizBranchCondition => ({
    question_id: questionId,
    operator,
    ...(value === undefined ? {} : { value }),
  });
  assert.ok(evaluateCondition(condition("neq", "repair"), lookupFrom({ q: "cleaning" })));
  assert.ok(!evaluateCondition(condition("neq", "cleaning"), lookupFrom({ q: "cleaning" })));

  // `in`: scalar membership and multi-choice intersection.
  assert.ok(evaluateCondition(condition("in", ["a", "b"]), lookupFrom({ q: "b" })));
  assert.ok(!evaluateCondition(condition("in", ["a", "b"]), lookupFrom({ q: "c" })));
  assert.ok(evaluateCondition(condition("in", ["mon", "fri"]), lookupFrom({ q: ["tue", "fri"] })));
  assert.ok(!evaluateCondition(condition("in", ["mon"]), lookupFrom({ q: ["tue"] })));

  assert.ok(evaluateCondition(condition("gt", 10), lookupFrom({ q: 11 })));
  assert.ok(!evaluateCondition(condition("gt", 10), lookupFrom({ q: 10 })));
  assert.ok(evaluateCondition(condition("gte", 10), lookupFrom({ q: 10 })));
  assert.ok(
    evaluateCondition(condition("lt", 5), lookupFrom({ q: "4" })),
    "numeric strings compare",
  );
  assert.ok(evaluateCondition(condition("lte", 5), lookupFrom({ q: 5 })));
  assert.ok(
    !evaluateCondition(condition("lt", 5), lookupFrom({ q: "abc" })),
    "non-numeric is false, never throws",
  );

  assert.ok(evaluateCondition(condition("answered"), lookupFrom({ q: "x" })));
  assert.ok(
    evaluateCondition(condition("answered"), lookupFrom({ q: false })),
    "false boolean is an answer",
  );
  assert.ok(!evaluateCondition(condition("answered"), lookupFrom({ q: "" })));
  assert.ok(!evaluateCondition(condition("answered"), lookupFrom({ q: [] })));
  assert.ok(!evaluateCondition(condition("answered"), lookupFrom({})));

  // Comparisons against unanswered/blank questions are false, not errors.
  assert.ok(!evaluateCondition(condition("gt", 1), lookupFrom({})));
  assert.ok(!evaluateCondition(condition("eq", 1), lookupFrom({})));
});

test("terminal path: last step without matching rules completes (next_step null)", () => {
  const decision = resolveNextStep(STEPS, RULES, "contact", lookupFrom({}));
  assert.deepEqual(decision, { next_step: null, matched_rule: null });
  const selfLoop = resolveNextStep(
    STEPS,
    [
      {
        from_step: "contact",
        when: [{ question_id: "x", operator: "answered" }],
        goto_step: "contact",
      },
    ],
    "contact",
    lookupFrom({ x: 1 }),
  );
  assert.equal(selfLoop.next_step, "contact", "explicit rules may loop by declaration");
});

test("no eval / no Function constructor in the evaluator source", () => {
  const source = readFileSync("packages/forms/src/branching.ts", "utf8");
  assert.ok(!/\beval\s*\(/.test(source));
  assert.ok(!/new\s+Function/.test(source));
});
