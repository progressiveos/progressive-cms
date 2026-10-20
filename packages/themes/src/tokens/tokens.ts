// Design Token source/runtime contract (PCMS-THEME-T013; Theme Contract spec
// §25/§26/§70).
//
// Source of truth: `tokens/*.json` in the theme — flat dotted semantic keys
// (`color.primary`, `space.md`, `font.heading`) with typed, bounded values.
// Runtime contract: deterministic CSS custom properties (`--color-primary`)
// in a single `:root` block, sorted by name — same source, byte-identical
// output. Names are semantic, never value-bound (§26). Tokens marked
// `public: false` are implementation tokens: themes may rename them between
// releases; public ones are a cross-theme contract and live in THEME.md (§70).
//
// Values are strictly validated (no braces/semicolons/tags) so a token value
// can never inject CSS rules.

export type TokenType = "color" | "length" | "number" | "text";

export interface ThemeToken {
  readonly value: string;
  readonly type: TokenType;
  /** Default true; `false` marks implementation-only tokens (§70). */
  readonly public: boolean;
}

export type TokenMap = Readonly<Record<string, ThemeToken>>;

export interface TokenIssue {
  readonly code:
    | "TOKEN_NAME_INVALID"
    | "TOKEN_VALUE_INVALID"
    | "TOKEN_TYPE_INVALID"
    | "TOKEN_SOURCE_INVALID";
  readonly path: string;
  readonly message: string;
}

const KEY_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){0,4}$/;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$|^[a-z]+$/;
const LENGTH_RE = /^-?\d+(\.\d+)?(px|rem|em|%|vh|vw|ch|s|ms)?$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const TEXT_RE = /^[#a-zA-Z0-9 _(),.'%/*+-]{0,200}$/;

/** `color.primary` → `--color-primary`. */
export function tokenCssName(key: string): string {
  return `--${key.replaceAll(".", "-")}`;
}

/**
 * Value validator per token type — the single gate upholding the invariant
 * that a token value can never inject CSS rules (§25/§26). Exported so
 * setting-derived overrides (§29) are admitted through the same check
 * before they may enter the runtime token map.
 */
export function valueValid(type: TokenType, value: string): boolean {
  switch (type) {
    case "color":
      return COLOR_RE.test(value);
    case "length":
      return LENGTH_RE.test(value);
    case "number":
      return NUMBER_RE.test(value);
    case "text":
      return TEXT_RE.test(value);
  }
}

export type TokensParseResult =
  | { readonly ok: true; readonly tokens: TokenMap }
  | { readonly ok: false; readonly issues: readonly TokenIssue[] };

/** Parses one `tokens/*.json` document: `{ "color.primary": { "value": … } }`. */
export function parseTokensSource(source: string): TokensParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(source) as unknown;
  } catch {
    return {
      ok: false,
      issues: [{ code: "TOKEN_SOURCE_INVALID", path: "/", message: "not valid JSON" }],
    };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return {
      ok: false,
      issues: [
        { code: "TOKEN_SOURCE_INVALID", path: "/", message: "token source must be a JSON object" },
      ],
    };
  }
  const issues: TokenIssue[] = [];
  const tokens: Record<string, ThemeToken> = {};
  for (const [key, raw] of Object.entries(doc as Record<string, unknown>)) {
    if (!KEY_RE.test(key)) {
      issues.push({
        code: "TOKEN_NAME_INVALID",
        path: `/${key}`,
        message: `token key "${key}" is not a valid semantic key`,
      });
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      issues.push({
        code: "TOKEN_SOURCE_INVALID",
        path: `/${key}`,
        message: "token must be an object",
      });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const value = entry.value;
    const type = entry.type === undefined ? "text" : entry.type;
    if (typeof value !== "string") {
      issues.push({
        code: "TOKEN_VALUE_INVALID",
        path: `/${key}/value`,
        message: "token value must be a string",
      });
      continue;
    }
    if (type !== "color" && type !== "length" && type !== "number" && type !== "text") {
      issues.push({
        code: "TOKEN_TYPE_INVALID",
        path: `/${key}/type`,
        message: `unknown token type: ${String(type)}`,
      });
      continue;
    }
    if (!valueValid(type, value)) {
      issues.push({
        code: "TOKEN_VALUE_INVALID",
        path: `/${key}/value`,
        message: `value "${value}" is not a valid ${type}`,
      });
      continue;
    }
    tokens[key] = {
      value,
      type,
      public: entry.public === undefined ? true : entry.public === true,
    };
  }
  return issues.length === 0 ? { ok: true, tokens } : { ok: false, issues };
}

/**
 * Deterministic CSS custom properties: sorted by CSS name, public tokens
 * first, implementation tokens in a clearly separated section (§70).
 */
export function tokensToCss(tokens: TokenMap): string {
  const entries = Object.entries(tokens)
    .map(([key, token]) => ({ name: tokenCssName(key), token, key }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const line = (e: { name: string; token: ThemeToken }): string => `  ${e.name}: ${e.token.value};`;
  const pub = entries.filter((e) => e.token.public);
  const impl = entries.filter((e) => !e.token.public);
  const blocks: string[] = [];
  if (pub.length > 0) {
    blocks.push(
      [
        "  /* public tokens — documented in THEME.md, renaming is a breaking change */",
        ...pub.map(line),
      ].join("\n"),
    );
  }
  if (impl.length > 0) {
    blocks.push(
      [
        "  /* implementation tokens — internal, may change between minor releases */",
        ...impl.map(line),
      ].join("\n"),
    );
  }
  return `:root {\n${blocks.join("\n")}\n}`;
}
