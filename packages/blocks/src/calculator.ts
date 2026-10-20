// Calculator block + safe formula parser/evaluator (PCMS-CONT-T016;
// Content spec §50, Baseline §16).
//
// The calculator is a declarative inputs/formula/outputs model. The formula
// language is parsed with a bounded recursive-descent parser into an AST and
// evaluated deterministically — no `eval`, no `Function`, no arbitrary JS
// (Content spec invariant 11). Whitelisted operators and functions only;
// complexity is hard-bounded. Everything the client computes must be
// reproducible by this reference evaluator for tests (§50).
import type { BlockTypeDescriptor } from "./registry.js";

export const MAX_FORMULA_LENGTH = 500;
export const MAX_FORMULA_NODES = 100;
export const MAX_FORMULA_ARGS = 8;
export const MAX_INPUTS = 50;

export type CalculatorIssue = { readonly code: string; readonly message: string };

interface Token {
  kind: "number" | "ident" | "op" | "lparen" | "rparen" | "comma";
  text: string;
  position: number;
}

function tokenize(source: string): Token[] | CalculatorIssue {
  const tokens: Token[] = [];
  let position = 0;
  while (position < source.length) {
    const char = source[position];
    if (char === " " || char === "\t" || char === "\n") {
      position += 1;
      continue;
    }
    const current = char;
    if (current !== undefined && /[0-9]/.test(current)) {
      const match = /^\d*\.?\d+(e[+-]?\d+)?/.exec(source.slice(position));
      const text = match?.[0];
      if (text === undefined) {
        return { code: "CALC_FORMULA_INVALID", message: `malformed number at ${position}` };
      }
      tokens.push({ kind: "number", text, position });
      position += text.length;
      continue;
    }
    if (current !== undefined && /[a-z_]/i.test(current)) {
      const match = /^[a-z_][a-z0-9_]*/i.exec(source.slice(position));
      const text = match?.[0];
      if (text === undefined) {
        return { code: "CALC_FORMULA_INVALID", message: `malformed identifier at ${position}` };
      }
      tokens.push({ kind: "ident", text, position });
      position += text.length;
      continue;
    }
    if (current !== undefined && "+-*/%^".includes(current)) {
      tokens.push({ kind: "op", text: current, position });
      position += 1;
      continue;
    }
    if (current === "(") {
      tokens.push({ kind: "lparen", text: current, position });
      position += 1;
      continue;
    }
    if (current === ")") {
      tokens.push({ kind: "rparen", text: current, position });
      position += 1;
      continue;
    }
    if (current === ",") {
      tokens.push({ kind: "comma", text: current, position });
      position += 1;
      continue;
    }
    return {
      code: "CALC_FORMULA_INVALID",
      message: `unexpected character "${char}" at position ${position}`,
    };
  }
  return tokens;
}

export type FormulaNode =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "call"; readonly name: string; readonly args: FormulaNode[] }
  | {
      readonly kind: "binary";
      readonly op: "+" | "-" | "*" | "/" | "%" | "^";
      readonly left: FormulaNode;
      readonly right: FormulaNode;
    }
  | { readonly kind: "negate"; readonly operand: FormulaNode };

class Parser {
  private position = 0;
  constructor(private readonly tokens: Token[]) {}

  static parse(
    source: string,
  ): { ok: true; ast: FormulaNode } | { ok: false; issue: CalculatorIssue } {
    if (source.length > MAX_FORMULA_LENGTH) {
      return {
        ok: false,
        issue: {
          code: "CALC_FORMULA_TOO_LONG",
          message: `formula exceeds ${MAX_FORMULA_LENGTH} characters`,
        },
      };
    }
    const tokens = tokenize(source);
    if (!Array.isArray(tokens)) return { ok: false, issue: tokens };
    if (tokens.length === 0) {
      return { ok: false, issue: { code: "CALC_FORMULA_INVALID", message: "formula is empty" } };
    }
    const parser = new Parser(tokens);
    let nodeCount = 0;
    try {
      const ast = parser.parseExpr(() => {
        nodeCount += 1;
        if (nodeCount > MAX_FORMULA_NODES) {
          throw {
            code: "CALC_FORMULA_TOO_COMPLEX",
            message: `formula exceeds ${MAX_FORMULA_NODES} nodes`,
          };
        }
      });
      if (parser.position < parser.tokens.length) {
        return {
          ok: false,
          issue: {
            code: "CALC_FORMULA_INVALID",
            message: `unexpected token "${parser.tokens[parser.position]?.text ?? ""}"`,
          },
        };
      }
      return { ok: true, ast };
    } catch (issue) {
      return { ok: false, issue: issue as CalculatorIssue };
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private eat(kind: Token["kind"], text?: string): Token {
    const token = this.peek();
    if (token === undefined || token.kind !== kind || (text !== undefined && token.text !== text)) {
      throw {
        code: "CALC_FORMULA_INVALID",
        message: `expected ${text ?? kind}, got "${token?.text ?? "end of formula"}"`,
      };
    }
    this.position += 1;
    return token;
  }

  private countNodes(onNode: () => void): void {
    onNode();
  }

  private parseExpr(onNode: () => void): FormulaNode {
    this.countNodes(onNode);
    let left = this.parseTerm(onNode);
    while (true) {
      const token = this.peek();
      if (token?.kind === "op" && (token.text === "+" || token.text === "-")) {
        this.position += 1;
        const right = this.parseTerm(onNode);
        left = { kind: "binary", op: token.text as "+" | "-", left, right };
      } else {
        return left;
      }
    }
  }

  private parseTerm(onNode: () => void): FormulaNode {
    let left = this.parseFactor(onNode);
    while (true) {
      const token = this.peek();
      if (token?.kind === "op" && ["*", "/", "%"].includes(token.text)) {
        this.position += 1;
        const right = this.parseFactor(onNode);
        left = {
          kind: "binary",
          op: token.text as "*" | "/" | "%",
          left,
          right,
        };
      } else {
        return left;
      }
    }
  }

  private parseFactor(onNode: () => void): FormulaNode {
    const base = this.parseUnary(onNode);
    const token = this.peek();
    if (token?.kind === "op" && token.text === "^") {
      this.position += 1;
      // Exponent is right-associative: 2^3^2 === 2^(3^2).
      const exponent = this.parseFactor(onNode);
      return { kind: "binary", op: "^", left: base, right: exponent };
    }
    return base;
  }

  private parseUnary(onNode: () => void): FormulaNode {
    const token = this.peek();
    if (token?.kind === "op" && token.text === "-") {
      this.position += 1;
      return { kind: "negate", operand: this.parseUnary(onNode) };
    }
    if (token?.kind === "op" && token.text === "+") {
      this.position += 1;
      return this.parseUnary(onNode);
    }
    return this.parsePrimary(onNode);
  }

  private parsePrimary(onNode: () => void): FormulaNode {
    const token = this.peek();
    if (token === undefined) {
      throw { code: "CALC_FORMULA_INVALID", message: "unexpected end of formula" };
    }
    if (token.kind === "number") {
      this.position += 1;
      return { kind: "number", value: Number(token.text) };
    }
    if (token.kind === "ident") {
      this.position += 1;
      const next = this.peek();
      if (next?.kind === "lparen") {
        this.position += 1;
        const args: FormulaNode[] = [];
        if (this.peek()?.kind !== "rparen") {
          args.push(this.parseExpr(onNode));
          while (this.peek()?.kind === "comma") {
            this.position += 1;
            if (args.length >= MAX_FORMULA_ARGS) {
              throw {
                code: "CALC_FORMULA_TOO_COMPLEX",
                message: `more than ${MAX_FORMULA_ARGS} arguments per call`,
              };
            }
            args.push(this.parseExpr(onNode));
          }
        }
        this.eat("rparen");
        return { kind: "call", name: token.text, args };
      }
      return { kind: "variable", name: token.text };
    }
    if (token.kind === "lparen") {
      this.position += 1;
      const inner = this.parseExpr(onNode);
      this.eat("rparen");
      return inner;
    }
    throw {
      code: "CALC_FORMULA_INVALID",
      message: `unexpected token "${token.text}"`,
    };
  }
}

/** Parses a formula into a bounded AST; never uses eval/Function. */
export function parseFormula(
  source: string,
): { ok: true; ast: FormulaNode } | { ok: false; issue: CalculatorIssue } {
  return Parser.parse(source);
}

const FUNCTIONS: ReadonlyMap<string, (args: number[]) => number> = new Map([
  ["min", (args) => Math.min(...args)],
  ["max", (args) => Math.max(...args)],
  [
    "round",
    (args) => {
      const digits = args[1] ?? 0;
      const factor = 10 ** digits;
      return Math.round((args[0] ?? 0) * factor) / factor;
    },
  ],
  ["ceil", (args) => Math.ceil(args[0] ?? 0)],
  ["floor", (args) => Math.floor(args[0] ?? 0)],
  ["abs", (args) => Math.abs(args[0] ?? 0)],
]);

export type FormulaVariables = Readonly<Record<string, number>>;

/** Evaluates the AST against concrete variable values. */
export function evaluateFormula(
  ast: FormulaNode,
  variables: FormulaVariables,
): { ok: true; value: number } | { ok: false; issue: CalculatorIssue } {
  const evaluate = (node: FormulaNode): number | CalculatorIssue => {
    switch (node.kind) {
      case "number":
        return node.value;
      case "variable": {
        const value = variables[node.name];
        if (value === undefined || !Number.isFinite(value)) {
          return {
            code: "CALC_UNKNOWN_VARIABLE",
            message: `unknown or non-numeric variable "${node.name}"`,
          };
        }
        return value;
      }
      case "negate": {
        const inner = evaluate(node.operand);
        return typeof inner === "number" ? -inner : inner;
      }
      case "binary": {
        const left = evaluate(node.left);
        if (typeof left !== "number") return left;
        const right = evaluate(node.right);
        if (typeof right !== "number") return right;
        switch (node.op) {
          case "+":
            return left + right;
          case "-":
            return left - right;
          case "*":
            return left * right;
          case "%":
            return right === 0
              ? { code: "CALC_DIVISION_BY_ZERO", message: "modulo by zero" }
              : left % right;
          case "/":
            if (right === 0) {
              return { code: "CALC_DIVISION_BY_ZERO", message: "division by zero" };
            }
            return left / right;
          case "^": {
            const result = left ** right;
            if (!Number.isFinite(result)) {
              return {
                code: "CALC_RESULT_OUT_OF_RANGE",
                message: "exponentiation left the finite range",
              };
            }
            return result;
          }
        }
        break;
      }
      case "call": {
        const fn = FUNCTIONS.get(node.name);
        if (fn === undefined) {
          return { code: "CALC_UNKNOWN_FUNCTION", message: `unknown function "${node.name}"` };
        }
        const values: number[] = [];
        for (const arg of node.args) {
          const value = evaluate(arg);
          if (typeof value !== "number") return value;
          values.push(value);
        }
        return fn(values);
      }
    }
    return { code: "CALC_FORMULA_INVALID", message: "malformed AST" };
  };
  const value = evaluate(ast);
  return typeof value === "number" ? { ok: true, value } : { ok: false, issue: value };
}

/** Convenience: parse + evaluate in one step (the reference evaluator, §50). */
export function evaluateFormulaText(
  source: string,
  variables: FormulaVariables,
): { ok: true; value: number } | { ok: false; issue: CalculatorIssue } {
  const parsed = parseFormula(source);
  if (!parsed.ok) return parsed;
  return evaluateFormula(parsed.ast, variables);
}

// ---------------------------------------------------------------------------
// Calculator block descriptor (registered as a first-party v1 block).
// ---------------------------------------------------------------------------

const INPUT_TYPES = ["number", "range", "select", "checkbox"] as const;

export const CALCULATOR_BLOCK: BlockTypeDescriptor = {
  typeId: "calculator",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", maxLength: 500 },
      inputs: {
        type: "array",
        minItems: 1,
        maxItems: MAX_INPUTS,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
            label: { type: "string", minLength: 1, maxLength: 300 },
            type: { type: "string", enum: [...INPUT_TYPES] },
            min: { type: "number" },
            max: { type: "number" },
            step: { type: "number", exclusiveMinimum: 0 },
            default: { type: ["number", "boolean", "string"] },
            options: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  value: { type: "number" },
                  label: { type: "string", minLength: 1, maxLength: 300 },
                },
                required: ["value", "label"],
              },
            },
          },
          required: ["key", "label", "type"],
        },
      },
      formula: { type: "string", minLength: 1, maxLength: MAX_FORMULA_LENGTH },
      outputs: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string", minLength: 1, maxLength: 300 },
            unit: { type: "string", maxLength: 20 },
            digits: { type: "integer", minimum: 0, maximum: 6 },
          },
          required: ["label"],
        },
      },
      formatting: {
        type: "object",
        additionalProperties: false,
        properties: {
          currency: { type: "string", pattern: "^[A-Z]{3}$" },
        },
      },
    },
    required: ["inputs", "formula", "outputs"],
  },
  childrenPolicy: "none",
  // The formula grammar itself is enforced by validateProps below — JSON
  // Schema can only check that the formula is a string.
  validateProps: (props) => {
    const formula = props.formula;
    if (typeof formula !== "string") return null;
    const parsed = parseFormula(formula);
    if (!parsed.ok) return [{ code: parsed.issue.code, message: parsed.issue.message }];
    const issues: CalculatorIssue[] = [];
    const inputKeys = new Set<string>();
    const inputs = props.inputs;
    if (Array.isArray(inputs)) {
      for (const input of inputs as Record<string, unknown>[]) {
        if (typeof input.key === "string") inputKeys.add(input.key);
      }
    }
    const collectUnknown = (node: FormulaNode): void => {
      if (node.kind === "variable" && !inputKeys.has(node.name) && !FUNCTIONS.has(node.name)) {
        issues.push({
          code: "CALC_UNKNOWN_VARIABLE",
          message: `formula references "${node.name}" which is not a declared input`,
        });
      }
      if (node.kind === "call") {
        for (const arg of node.args) collectUnknown(arg);
      }
      if (node.kind === "binary") {
        collectUnknown(node.left);
        collectUnknown(node.right);
      }
      if (node.kind === "negate") collectUnknown(node.operand);
    };
    collectUnknown(parsed.ast);
    return issues.length === 0 ? null : issues;
  },
};
