import {
  AssignTag,
  CommentTag,
  ForTag,
  IfTag,
  IncludeTag,
  InlineCommentTag,
  Output,
  RenderTag,
  type Template,
  type Token,
  TokenKind,
  UnlessTag,
  type Value,
} from "liquidjs";
import type { ThemeMarkdownContract } from "../manifest/schema.js";
import { createThemeEngine, type TemplateSnapshot } from "./liquid.js";
import { isSafeMarkdown } from "./safe-markdown.js";

export interface MarkdownDiscoveryPlan {
  readonly dependencies: readonly string[];
  /** null means the source is safe and emits a nonempty semantic witness. */
  assess(scope: Readonly<Record<string, unknown>>, contentPaths?: readonly string[]): string | null;
}
export type MarkdownDiscoveryCompilation =
  | { readonly ok: true; readonly plan: MarkdownDiscoveryPlan }
  | { readonly ok: false; readonly reason: string };

type Scope = Readonly<Record<string, unknown>>;
type Ref = { readonly path: string | null; read(scope: Scope, locals: Scope): unknown };
type Expression = {
  readonly ref: Ref;
  readonly filters: readonly string[];
  readonly args: readonly Ref[];
  readonly filterArgs: readonly (readonly Ref[])[];
};
type Instruction =
  | { readonly kind: "literal"; readonly bytes: number }
  | { readonly kind: "output"; readonly expression: Expression }
  | {
      readonly kind: "condition";
      readonly branches: readonly {
        test: (scope: Scope, locals: Scope) => boolean | undefined;
        body: readonly Instruction[];
      }[];
      readonly otherwise: readonly Instruction[];
    }
  | {
      readonly kind: "loop";
      readonly variable: string;
      readonly collection: Ref;
      readonly body: readonly Instruction[];
      readonly otherwise: readonly Instruction[];
      readonly limit: number;
      readonly offset: number;
      readonly reversed: boolean;
    }
  | {
      readonly kind: "partial";
      readonly body: readonly Instruction[];
      readonly bindings: ReadonlyMap<string, Ref>;
      readonly isolated: boolean;
    };

type CompileScope = {
  readonly aliases: Map<string, Ref>;
  readonly isolated: boolean;
  readonly nested: boolean;
};
const ROOTS = new Set([
  "entry",
  "body_markdown",
  "blocks_markdown",
  "fallback_markdown",
  "media",
  "related_cards",
  "collections",
  "request",
  "site",
  "i18n",
]);
const SAFE_FILTERS = new Set([
  "default",
  "strip",
  "lstrip",
  "rstrip",
  "strip_newlines",
  "upcase",
  "downcase",
  "capitalize",
  "append",
  "prepend",
  "date",
  "join",
  "size",
  "replace",
  "replace_first",
  "replace_last",
  "remove",
  "remove_first",
  "remove_last",
]);
const PRESERVING_FILTERS = new Set([
  "default",
  "strip",
  "lstrip",
  "rstrip",
  "strip_newlines",
  "upcase",
  "downcase",
  "capitalize",
  "append",
  "prepend",
]);
// Counts exclude the input value. Keep the supported call shapes explicit:
// Liquid throws on malformed append/prepend and custom trim sets can erase text.
const FILTER_ARITY: Readonly<Record<string, readonly [number, number]>> = {
  default: [0, 1],
  strip: [0, 1],
  lstrip: [0, 1],
  rstrip: [0, 1],
  strip_newlines: [0, 0],
  upcase: [0, 0],
  downcase: [0, 0],
  capitalize: [0, 0],
  append: [1, 1],
  prepend: [1, 1],
  date: [0, 2],
  join: [0, 1],
  size: [0, 0],
  replace: [2, 2],
  replace_first: [2, 2],
  replace_last: [2, 2],
  remove: [1, 1],
  remove_first: [1, 1],
  remove_last: [1, 1],
};
const DEFAULT_CONTENT_PATHS = [
  "fallback_markdown",
  "blocks_markdown",
  "body_markdown",
  "entry.fields.intro_markdown",
  "entry.fields.body_markdown",
];
const MAX_NODES = 512;
const MAX_OPERATIONS = 4096;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

function fail(reason: string): never {
  throw new Error(reason);
}
function isScalar(value: unknown): value is string | number | boolean | null | undefined {
  return (
    value == null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
function nonempty(value: unknown): boolean {
  if (isSafeMarkdown(value)) return value.markdown.trim() !== "";
  return typeof value === "string"
    ? value.trim() !== ""
    : typeof value === "number" && Number.isFinite(value);
}
function property(value: unknown, key: unknown): unknown {
  if (value == null) return undefined;
  if (typeof key !== "string" && typeof key !== "number") return fail("unsupported_lookup");
  const name = String(key);
  if (FORBIDDEN.has(name)) return fail("unsafe_lookup");
  if (Array.isArray(value)) {
    if (name === "size") return value.length;
    if (name === "first") return value[0];
    if (name === "last") return value.at(-1);
  }
  if (typeof value === "string" && name === "size") return value.length;
  return typeof value === "object" && Object.hasOwn(value, name)
    ? (value as Record<string, unknown>)[name]
    : undefined;
}
function covered(path: string, declarations: readonly string[]): boolean {
  return declarations.some((declared) => path === declared || path.startsWith(`${declared}.`));
}

/** Parses once per immutable snapshot. No Liquid renderer or evaluator is called. */
export function compileMarkdownDiscoveryPlan(input: {
  readonly snapshot: TemplateSnapshot;
  readonly file: string;
  readonly contract?: ThemeMarkdownContract;
}): MarkdownDiscoveryCompilation {
  try {
    const engine = createThemeEngine({ templates: input.snapshot, outputFormat: "markdown" });
    const dependencies = new Set<string>();
    let nodes = 0;
    let sourceBytes = 0;
    const activeFiles = new Set<string>();

    function tokenRef(token: Token | undefined, context: CompileScope): Ref {
      if (!token) return { path: null, read: () => undefined };
      if (
        token.kind === TokenKind.Quoted ||
        token.kind === TokenKind.Number ||
        token.kind === TokenKind.Literal
      ) {
        const literal = token as Token & { content: unknown; literal?: string };
        if (literal.literal === "blank" || literal.literal === "empty")
          return { path: null, read: () => undefined };
        return { path: null, read: () => literal.content };
      }
      if (token.kind !== TokenKind.PropertyAccess) return fail("unsupported_expression");
      const access = token as Token & { variable?: Token; props: Token[] };
      if (access.variable || access.props.length === 0) return fail("unsupported_lookup");
      const first = access.props[0] as Token & { content?: unknown };
      if (typeof first.content !== "string" || FORBIDDEN.has(first.content))
        return fail("unsafe_lookup");
      const root = first.content;
      let ref: Ref;
      const alias = context.aliases.get(root);
      if (alias) ref = alias;
      else {
        if (!ROOTS.has(root)) return fail("unsupported_scope");
        if (context.isolated) return fail("unbound_partial_scope");
        ref = { path: root, read: (scope) => property(scope, root) };
      }
      for (const prop of access.props.slice(1)) {
        const item = prop as Token & { content?: unknown };
        const key =
          prop.kind === TokenKind.Word ||
          prop.kind === TokenKind.Quoted ||
          prop.kind === TokenKind.Number
            ? { path: null, read: () => item.content }
            : tokenRef(prop, context);
        const fixed =
          prop.kind === TokenKind.Word ||
          prop.kind === TokenKind.Quoted ||
          prop.kind === TokenKind.Number;
        if (fixed && FORBIDDEN.has(String(item.content))) return fail("unsafe_lookup");
        const base = ref;
        ref = {
          path: base.path === null ? null : `${base.path}.${fixed ? String(item.content) : "*"}`,
          read: (scope, locals) => property(base.read(scope, locals), key.read(scope, locals)),
        };
      }
      if (ref.path !== null) dependencies.add(ref.path);
      return ref;
    }
    function expression(value: Value, context: CompileScope): Expression {
      if (value.initial.postfix.length !== 1) return fail("unsupported_output_expression");
      const ref = tokenRef(value.initial.postfix[0], context);
      const filters = value.filters.filter((filter) => filter.name !== "[object Function]");
      if (filters.some((filter) => !SAFE_FILTERS.has(filter.name)))
        return fail("unsupported_filter");
      const filterArgs = filters.map((filter) => {
        const [minimum, maximum] = FILTER_ARITY[filter.name] ?? [0, 0];
        if (filter.args.length < minimum || filter.args.length > maximum)
          return fail("unsupported_filter_arity");
        if (filter.args.some(Array.isArray)) return fail("unsupported_filter_argument");
        return filter.args.map((arg) => tokenRef(arg as Token, context));
      });
      return {
        ref,
        filters: filters.map((filter) => filter.name),
        args: filterArgs.flat(),
        filterArgs,
      };
    }
    function condition(value: Value, context: CompileScope, negate: boolean) {
      if (value.filters.length !== 0) return fail("unsupported_condition");
      const tokens = value.initial.postfix;
      for (const token of tokens) {
        if (token.kind === TokenKind.Operator) continue;
        tokenRef(token, context);
      }
      if (tokens.length === 1) {
        const ref = tokenRef(tokens[0], context);
        return (scope: Scope, locals: Scope) => {
          const value = ref.read(scope, locals);
          const truth = value !== false && value !== null && value !== undefined;
          return negate ? !truth : truth;
        };
      }
      // Match Liquid's distinct scalar nil/empty/blank semantics. Other object
      // comparisons stay unknown rather than invoking arbitrary Drop methods.
      const operator = (tokens[2] as (Token & { operator?: string }) | undefined)?.operator;
      if (tokens.length === 3 && (operator === "!=" || operator === "==")) {
        const right = tokens[1] as Token & { literal?: string };
        if (["blank", "empty", "nil", "null"].includes(right.literal ?? "")) {
          const left = tokenRef(tokens[0], context);
          return (scope: Scope, locals: Scope) => {
            const value = left.read(scope, locals);
            if (!isScalar(value)) return undefined;
            const equal =
              right.literal === "blank"
                ? value == null ||
                  value === false ||
                  (typeof value === "string" && /^\s*$/.test(value))
                : right.literal === "empty"
                  ? value === ""
                  : value == null;
            const truth = operator === "==" ? equal : !equal;
            return negate ? !truth : truth;
          };
        }
      }
      return () => undefined;
    }
    function file(file: string, context: CompileScope): Instruction[] {
      if (activeFiles.has(file) || activeFiles.size >= 8) return fail("recursive_partial");
      const source = Object.hasOwn(input.snapshot, file) ? input.snapshot[file] : undefined;
      if (source === undefined) return fail("missing_partial");
      sourceBytes += Buffer.byteLength(source);
      if (sourceBytes > 65_536) return fail("template_size_limit");
      activeFiles.add(file);
      try {
        return compile(engine.parse(source, file), context);
      } finally {
        activeFiles.delete(file);
      }
    }
    function compile(templates: readonly Template[], context: CompileScope): Instruction[] {
      const instructions: Instruction[] = [];
      for (const node of templates) {
        if (++nodes > MAX_NODES) return fail("template_node_limit");
        if (node.token.kind === TokenKind.HTML) {
          instructions.push({ kind: "literal", bytes: Buffer.byteLength(node.token.getText()) });
          continue;
        }
        if (node instanceof CommentTag || node instanceof InlineCommentTag) continue;
        if (node instanceof Output) {
          instructions.push({ kind: "output", expression: expression(node.value, context) });
        } else if (node instanceof AssignTag) {
          if (context.nested) return fail("nested_assignment");
          const assign = node as unknown as { key: string; value: Value };
          if (ROOTS.has(assign.key) || FORBIDDEN.has(assign.key) || context.aliases.has(assign.key))
            return fail("unsafe_assignment");
          const value = expression(assign.value, context);
          if (value.filters.length !== 0) return fail("filtered_assignment");
          context.aliases.set(assign.key, value.ref);
        } else if (node instanceof IfTag || node instanceof UnlessTag) {
          instructions.push({
            kind: "condition",
            branches: node.branches.map((branch, index) => ({
              test: condition(branch.value, context, node instanceof UnlessTag && index === 0),
              body: compile(branch.templates, {
                ...context,
                aliases: new Map(context.aliases),
                nested: true,
              }),
            })),
            otherwise: compile(node.elseTemplates ?? [], {
              ...context,
              aliases: new Map(context.aliases),
              nested: true,
            }),
          });
        } else if (node instanceof ForTag) {
          const collection = tokenRef(node.collection, context);
          const options = node.hash.hash;
          if (Object.keys(options).some((name) => !["limit", "offset", "reversed"].includes(name)))
            return fail("unsupported_loop");
          const constant = (name: string, fallback: number) => {
            const token = options[name] as (Token & { content?: number }) | undefined;
            if (token === undefined) return fallback;
            if (
              token.kind !== TokenKind.Number ||
              typeof token.content !== "number" ||
              !Number.isInteger(token.content) ||
              token.content < 0 ||
              token.content > 1000
            )
              return fail("unsupported_loop_bound");
            return token.content;
          };
          const aliases = new Map(context.aliases);
          if (
            FORBIDDEN.has(node.variable) ||
            ROOTS.has(node.variable) ||
            aliases.has(node.variable)
          )
            return fail("unsafe_loop_binding");
          aliases.set(node.variable, {
            path: collection.path === null ? null : `${collection.path}.*`,
            read: (_scope, locals) => locals[node.variable],
          });
          // forloop values are presentation-only and cannot prove content.
          aliases.set("forloop", { path: null, read: (_scope, locals) => locals.forloop });
          instructions.push({
            kind: "loop",
            variable: node.variable,
            collection,
            body: compile(node.templates, { ...context, aliases, nested: true }),
            otherwise: compile(node.elseTemplates, {
              ...context,
              aliases: new Map(context.aliases),
              nested: true,
            }),
            limit: constant("limit", 1000),
            offset: constant("offset", 0),
            reversed: Object.hasOwn(options, "reversed"),
          });
        } else if (node instanceof IncludeTag || node instanceof RenderTag) {
          const partial = node as unknown as {
            file: unknown;
            hash: { hash: Record<string, Token | undefined> };
            withVar?: unknown;
            with?: unknown;
            forBinding?: unknown;
          };
          if (
            typeof partial.file !== "string" ||
            partial.withVar ||
            partial.with ||
            partial.forBinding
          )
            return fail("dynamic_partial");
          const bindings = new Map<string, Ref>();
          const isolated = node instanceof RenderTag;
          const aliases = isolated ? new Map<string, Ref>() : new Map(context.aliases);
          for (const [name, token] of Object.entries(partial.hash.hash)) {
            if (FORBIDDEN.has(name)) return fail("unsafe_partial_binding");
            const ref = tokenRef(token, context);
            aliases.set(name, { path: ref.path, read: (_scope, locals) => locals[name] });
            bindings.set(name, ref);
          }
          instructions.push({
            kind: "partial",
            isolated,
            bindings,
            body: file(partial.file, { aliases, isolated, nested: true }),
          });
        } else return fail("unsupported_tag");
      }
      return instructions;
    }
    const instructions = file(input.file, { aliases: new Map(), isolated: false, nested: false });
    const paths = [...dependencies].sort();
    const contract = input.contract;
    if (contract) {
      if (
        contract.version !== 1 ||
        paths.some((path) => !covered(path, contract.dependencies)) ||
        contract.dependencies.some((declared) => !paths.some((path) => covered(path, [declared])))
      )
        return fail("dependency_contract_mismatch");
    }
    return {
      ok: true,
      plan: {
        dependencies: paths,
        assess(scope, contentPaths = DEFAULT_CONTENT_PATHS) {
          try {
            let operations = 0;
            let outputBytes = 0;
            const addBytes = (bytes: number) => {
              outputBytes += bytes;
              if (outputBytes > 262_144) fail("assessment_budget");
            };
            function prove(body: readonly Instruction[], locals: Scope): boolean {
              let witness = false;
              for (const instruction of body) {
                if (++operations > MAX_OPERATIONS) return fail("assessment_budget");
                if (instruction.kind === "literal") {
                  addBytes(instruction.bytes);
                } else if (instruction.kind === "output") {
                  const { ref, filters, args, filterArgs } = instruction.expression;
                  operations += filters.length + args.length;
                  if (operations > MAX_OPERATIONS) return fail("assessment_budget");
                  const value = ref.read(scope, locals);
                  if (
                    !isScalar(value) &&
                    !isSafeMarkdown(value) &&
                    !(
                      Array.isArray(value) &&
                      value.length <= 1000 &&
                      filters[0] === "join" &&
                      value.every(isScalar)
                    )
                  )
                    return fail("unsupported_output_value");
                  if (typeof value === "string" && value.length > 262_144)
                    return fail("assessment_budget");
                  if (args.some((arg) => !isScalar(arg.read(scope, locals))))
                    return fail("unsupported_filter_value");
                  const bytes = (value: unknown): number => {
                    if (isSafeMarkdown(value)) return Buffer.byteLength(value.markdown);
                    if (Array.isArray(value))
                      return value.reduce<number>((sum, item) => sum + bytes(item), 0);
                    return value == null ? 0 : Buffer.byteLength(String(value));
                  };
                  let bound = bytes(value);
                  for (let index = 0; index < filters.length; index++) {
                    const sizes = (filterArgs[index] ?? []).map((arg) =>
                      bytes(arg.read(scope, locals)),
                    );
                    switch (filters[index]) {
                      case "join":
                        if (index === 0 && Array.isArray(value))
                          bound += Math.max(0, value.length - 1) * (sizes[0] ?? 2);
                        break;
                      case "replace":
                        // At most UTF-8 byte length + 1 matches, even for an empty pattern.
                        bound += (bound + 1) * (sizes[1] ?? 0);
                        break;
                      case "replace_first":
                      case "replace_last":
                        bound += sizes[1] ?? 0;
                        break;
                      case "append":
                      case "prepend":
                      case "default":
                        bound += sizes[0] ?? 0;
                        break;
                      case "upcase":
                      case "downcase":
                      case "capitalize":
                        bound *= 3;
                        break;
                      case "date":
                        bound = Math.max(bound, (sizes[0] ?? 0) * 2, 64);
                        break;
                      case "size":
                        bound = 32;
                        break;
                    }
                    if (bound > 262_144) return fail("assessment_budget");
                  }
                  // Escaping may add one byte for each input byte. SafeMarkdown
                  // without transforms bypasses escaping in the real renderer.
                  addBytes(bound * (isSafeMarkdown(value) && filters.length === 0 ? 1 : 2));
                  if (isSafeMarkdown(value) && filters.some((filter) => filter !== "default"))
                    return fail("filtered_projection");
                  const actualPath = ref.path;
                  if (
                    actualPath !== null &&
                    contentPaths.some((path) => {
                      const pattern = path.split(".");
                      const actual = actualPath.split(".");
                      return (
                        pattern.length === actual.length &&
                        pattern.every((part, index) => part === "*" || part === actual[index])
                      );
                    }) &&
                    filters.every(
                      (filter, index) =>
                        PRESERVING_FILTERS.has(filter) &&
                        (!["strip", "lstrip", "rstrip"].includes(filter) ||
                          filterArgs[index]?.length === 0),
                    ) &&
                    nonempty(value)
                  )
                    witness = true;
                } else if (instruction.kind === "condition") {
                  let possible = true;
                  const branches: boolean[] = [];
                  for (const branch of instruction.branches) {
                    const guaranteed = prove(branch.body, locals);
                    const truth = branch.test(scope, locals);
                    if (possible && truth !== false) branches.push(guaranteed);
                    if (truth === true) possible = false;
                  }
                  const otherwise = prove(instruction.otherwise, locals);
                  if (possible) branches.push(otherwise);
                  if (branches.length > 0 && branches.every(Boolean)) witness = true;
                } else if (instruction.kind === "loop") {
                  const collection = instruction.collection.read(scope, locals);
                  if (collection != null && !Array.isArray(collection))
                    return fail("unsupported_collection");
                  const items = (collection ?? []) as unknown[];
                  if (items.length > 1000) return fail("assessment_budget");
                  const selected = items.slice(
                    instruction.offset,
                    instruction.offset + instruction.limit,
                  );
                  if (instruction.reversed) selected.reverse();
                  let any = false;
                  for (let index = 0; index < selected.length; index++) {
                    if (
                      prove(instruction.body, {
                        ...locals,
                        [instruction.variable]: selected[index],
                        forloop: {
                          index: index + 1,
                          index0: index,
                          first: index === 0,
                          last: index === selected.length - 1,
                          length: selected.length,
                        },
                      })
                    )
                      any = true;
                  }
                  const otherwise = prove(instruction.otherwise, locals);
                  if (selected.length === 0 ? otherwise : any) witness = true;
                } else {
                  const bindings = Object.fromEntries(
                    [...instruction.bindings].map(([name, ref]) => [name, ref.read(scope, locals)]),
                  );
                  if (
                    prove(instruction.body, {
                      ...(instruction.isolated ? {} : locals),
                      ...bindings,
                    })
                  )
                    witness = true;
                }
              }
              return witness;
            }
            return prove(instructions, {}) ? null : "empty_template_content";
          } catch (error) {
            return error instanceof Error ? error.message : "unproven_template";
          }
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? (error.message.split("\n")[0]?.slice(0, 160) ?? "invalid_template")
          : "invalid_template",
    };
  }
}
