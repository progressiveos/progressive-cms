// PCMS-CONT-T016 — calculator block + safe formula parser/evaluator.
// Acceptance: no eval; server/reference calculation tests (Content spec §50).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BlockDocumentResult,
  createBlockRegistry,
  evaluateFormulaText,
  type FormulaVariables,
  newBlockId,
  parseFormula,
  registerFirstPartyBlocksV1,
  validateBlockDocument,
} from "@pcms/blocks";

function firstPartyRegistry() {
  const registry = createBlockRegistry();
  registerFirstPartyBlocksV1(registry);
  return registry;
}

function issuesOf(result: BlockDocumentResult) {
  return result.ok ? [] : result.issues;
}

function block(type: string, props: Record<string, unknown>): Record<string, unknown> {
  return {
    id: newBlockId(),
    type,
    schema_version: 1,
    variant: null,
    props,
    children: [],
  };
}

function evalTo(formula: string, variables: FormulaVariables): number {
  const result = evaluateFormulaText(formula, variables);
  assert.equal(result.ok, true, `formula "${formula}" must evaluate`);
  return result.ok ? result.value : Number.NaN;
}

test("parser handles precedence, parens, right-associative exponent, unary minus", () => {
  assert.equal(evalTo("2 + 3 * 4", {}), 14);
  assert.equal(evalTo("(2 + 3) * 4", {}), 20);
  assert.equal(evalTo("2 ^ 3 ^ 2", {}), 512);
  assert.equal(evalTo("-5 + 3", {}), -2);
  assert.equal(evalTo("10 % 3", {}), 1);
  assert.equal(evalTo("7 / 2", {}), 3.5);
});

test("whitelisted functions work; unknown functions/variables are rejected", () => {
  assert.equal(evalTo("min(3, 2, 5)", {}), 2);
  assert.equal(evalTo("max(3, 2, 5)", {}), 5);
  assert.equal(evalTo("round(3.14159, 2)", {}), 3.14);
  assert.equal(evalTo("ceil(3.2)", {}), 4);
  assert.equal(evalTo("floor(3.8)", {}), 3);
  assert.equal(evalTo("abs(-7)", {}), 7);

  const unknownFunction = evaluateFormulaText("sqrt(4)", {});
  assert.equal(unknownFunction.ok, false);
  assert.equal(unknownFunction.ok ? "" : unknownFunction.issue.code, "CALC_UNKNOWN_FUNCTION");
  // `eval` is just an unknown function to the grammar (string literals do
  // not even parse — quoted args fail with CALC_FORMULA_INVALID).
  const evalCall = evaluateFormulaText("eval(1)", {});
  assert.equal(evalCall.ok ? "" : evalCall.issue.code, "CALC_UNKNOWN_FUNCTION");
  const evalQuoted = evaluateFormulaText("eval('1+1')", {});
  assert.equal(evalQuoted.ok ? "" : evalQuoted.issue.code, "CALC_FORMULA_INVALID");

  const unknownVariable = evaluateFormulaText("secret + 1", { a: 1 });
  assert.equal(unknownVariable.ok ? "" : unknownVariable.issue.code, "CALC_UNKNOWN_VARIABLE");
});

test("no eval: JS constructs and member access cannot parse", () => {
  for (const hostile of [
    "process.exit(1)",
    "(()=>1)()",
    "constructor",
    "1; 2",
    "import('node:fs')",
    "a ? b : c",
  ]) {
    const result = evaluateFormulaText(hostile, {});
    assert.equal(result.ok, false, `"${hostile}" must not evaluate`);
    const code = result.ok ? "" : result.issue.code;
    assert.ok(
      code === "CALC_FORMULA_INVALID" ||
        code === "CALC_UNKNOWN_VARIABLE" ||
        code === "CALC_UNKNOWN_FUNCTION",
      `"${hostile}" → unexpected ${code}`,
    );
  }
  // The parser produces a plain AST; there is no code path to compiled source.
  const parsed = parseFormula("1 + 2 * 3");
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(
      JSON.stringify(Object.keys(parsed.ast)),
      JSON.stringify(["kind", "op", "left", "right"]),
    );
  }
});

test("bounded complexity: long/oversized formulas rejected; division by zero reported", () => {
  const long = "1+".repeat(400) + "1";
  const longResult = evaluateFormulaText(long, {});
  assert.equal(longResult.ok, false);

  const deep = "(".repeat(120) + "1" + ")".repeat(120);
  assert.equal(evaluateFormulaText(deep, {}).ok, false);

  const division = evaluateFormulaText("1 / 0", {});
  assert.equal(division.ok ? "" : division.issue.code, "CALC_DIVISION_BY_ZERO");
});

const CALCULATOR_PROPS = {
  title: "Расчёт стоимости обслуживания",
  inputs: [
    { key: "area", label: "Площадь, м²", type: "number", min: 1, max: 10_000, default: 50 },
    {
      key: "tier",
      label: "Тариф",
      type: "select",
      options: [
        { value: 1, label: "Базовый" },
        { value: 1.5, label: "Расширенный" },
      ],
    },
    { key: "urgent", label: "Срочно", type: "checkbox", default: false },
  ],
  formula: "round(area * 1000 * tier * (1 + urgent * 0.2), 2)",
  outputs: [{ label: "Стоимость", unit: "RUB", digits: 2 }],
};

test("calculator block validates with a correct formula; bad formulas rejected in props", () => {
  const registry = firstPartyRegistry();
  const good = validateBlockDocument(
    { schema_version: 1, blocks: [block("calculator", CALCULATOR_PROPS)] },
    registry,
  );
  assert.equal(good.ok, true, JSON.stringify(issuesOf(good)));

  const syntaxError = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [block("calculator", { ...CALCULATOR_PROPS, formula: "area *" })],
    },
    registry,
  );
  assert.ok(issuesOf(syntaxError).some((issue) => issue.code === "CALC_FORMULA_INVALID"));

  const undeclared = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [block("calculator", { ...CALCULATOR_PROPS, formula: "height * area" })],
    },
    registry,
  );
  assert.ok(issuesOf(undeclared).some((issue) => issue.code === "CALC_UNKNOWN_VARIABLE"));
});

test("reference evaluator reproduces client calculations deterministically", () => {
  // area=80, tier=1.5, urgent=true → 80*1000*1.5*1.2 = 144000
  const value = evalTo(CALCULATOR_PROPS.formula as string, {
    area: 80,
    tier: 1.5,
    urgent: 1,
  });
  assert.equal(value, 144_000);
  // Same inputs → same output (deterministic).
  assert.equal(
    evalTo(CALCULATOR_PROPS.formula as string, { area: 80, tier: 1.5, urgent: 1 }),
    value,
  );
  // checkbox false → factor 1.
  assert.equal(
    evalTo(CALCULATOR_PROPS.formula as string, { area: 80, tier: 1.5, urgent: 0 }),
    120_000,
  );
});
