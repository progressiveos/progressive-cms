// Strict Admin i18n gate (check:i18n). AST-based (acorn + acorn-typescript):
// visible JSX text, user-facing attribute literals, string literals inside
// JSX child expressions, user-facing object-property literals, and Cyrillic
// anywhere in Admin source are violations unless exempted below. Also
// validates catalog integrity: RU/EN key parity, no empty values, no
// duplicate keys across base + domain fragments, and that every literal
// t("key") exists in the merged catalog.
//
// Hardcoded user-facing strings in the Admin must be 0 — both Russian and
// English. Keep exemptions minimal and reviewed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser } from "acorn";
import tsPlugin from "acorn-typescript";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "apps/admin/src");

/** Catalog-shaped or data-shaped files whose literals are the catalog itself. */
const FILE_EXEMPTS = [
  /\/i18n\//,
  // Presentation-label data layer (field ids → {ru,en} labels), spec §6.4.
  /\/fields\/field-utils\.ts$/,
  /\/theme\/setting-labels\.ts$/,
];

/** Reviewed non-user-facing literals (brand names, protocol words). */
const LITERAL_ALLOWS = new Set([
  "Progressive CMS",
  "Progressive OS",
  "125000.00", // money input format example
  "RUB", // currency code
  "https://", // URL prefix example
  "+7…", // phone format example
  "cms@example.com", // email format example
  "smtp.example.com", // host example
  "{page_title} — {site_name}", // substitution-pattern demo
]);
/** Glyph-only visible text (menu dots, ×, arrows) — language-neutral. */
const GLYPH_ONLY = /^[\s\p{P}\p{S}]*$/u;
/**
 * Visible JSX text that is deliberately not localized: the locale toggle
 * shows language names in their own language (never translated, i18n
 * convention) and the product/brand marks are locale-invariant (the catalog
 * itself asserts "product name is never translated").
 */
const JSX_TEXT_ALLOWS = new Set(["RU", "EN", "Progressive CMS", "© Progressive OS"]);

/** JSX attributes whose string value is shown to a human. */
const USER_FACING_ATTRS = new Set(["placeholder", "title", "alt", "aria-label", "label"]);
const ATTR_PATTERN = /label|hint|placeholder|tooltip|message|description/i;
/** Structural/technical attributes that never carry human text. */
const ATTR_IGNORES =
  /^(className|id|key|name|role|type|rel|target|href|src|srcSet|method|action|content|lang|dir|icon|tone|variant|size|testId|data-testid|autoComplete|inputMode|encType|aria-hidden|aria-expanded|aria-selected|aria-modal|aria-current|aria-live|aria-invalid|aria-level|aria-posinset|aria-setsize|aria-controls|aria-labelledby|aria-describedby|aria-atomic|colSpan|rowSpan|width|height|min|max|step|maxLength|minLength|pattern|loading|decoding|referrerPolicy|download)$/;

/** Object properties whose literal value is usually human-visible text. */
const USER_FACING_PROPS = /title|label|message|hint|description|placeholder|text|detail/i;

const CYRILLIC = /[\u0400-\u04FF]/;
/** Capitalized multi-word literal = probably human prose (English hardcode). */
const PROSE = /^[A-Z\u0400-\u04FF][^\s{}]*(\s+[^\s{}]+)+[.!?…]?$/;

type Violation = { at: string; rule: string; detail: string };
const violations: Violation[] = [];
const tKeysUsed = new Set<string>();

interface Loc {
  loc?: { start: { line: number; column: number } };
}

type Ctx = { inJsxChildExpr: boolean; displayPos: boolean };

function at(file: string, node: Loc): string {
  const start = node.loc?.start;
  return start === undefined ? file : `${file}:${start.line}:${start.column + 1}`;
}

function flagString(
  file: string,
  node: Loc,
  text: string,
  ctx: Ctx,
  kind: string,
  propName?: string,
): void {
  if (LITERAL_ALLOWS.has(text)) return;
  if (CYRILLIC.test(text)) {
    violations.push({
      at: at(file, node),
      rule: "cyrillic",
      detail: `Cyrillic ${kind} ${JSON.stringify(text)}`,
    });
    return;
  }
  if (
    propName !== undefined &&
    USER_FACING_PROPS.test(propName) &&
    /\s/u.test(text) &&
    /\p{L}/u.test(text)
  ) {
    violations.push({
      at: at(file, node),
      rule: `prop:${propName}`,
      detail: `hardcoded ${propName} ${JSON.stringify(text)}`,
    });
    return;
  }
  if (ctx.inJsxChildExpr && ctx.displayPos && (PROSE.test(text) || /^[A-Z\p{Lu}]/u.test(text))) {
    violations.push({
      at: at(file, node),
      rule: "jsx-literal",
      detail: `literal shown in JSX ${JSON.stringify(text)}`,
    });
  }
}

function attrName(name: unknown): string {
  const n = name as { type: string; name?: string; namespace?: string; local?: unknown };
  if (n.type === "JSXIdentifier") return n.name ?? "";
  if (n.type === "JSXNamespacedName") return `${n.namespace}:${String(n.local)}`;
  return "";
}

function walk(node: unknown, ctx: Ctx, file: string): void {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, ctx, file);
    return;
  }
  const n = node as { type: string; [k: string]: unknown };
  switch (n.type) {
    case "JSXText": {
      const text = String(n.value);
      if (/\S/.test(text) && !GLYPH_ONLY.test(text) && !JSX_TEXT_ALLOWS.has(text.trim())) {
        violations.push({
          at: at(file, n as unknown as Loc),
          rule: "jsx-text",
          detail: `visible JSX text ${JSON.stringify(text.trim())}`,
        });
      }
      return;
    }
    case "JSXElement":
    case "JSXFragment": {
      const attributes =
        n.type === "JSXElement" ? (n.openingElement as { attributes: unknown }).attributes : [];
      walk(attributes, ctx, file);
      for (const child of (n.children ?? []) as Array<{ type: string; expression?: unknown }>) {
        if (child.type === "JSXExpressionContainer") {
          walk(child.expression, { inJsxChildExpr: true, displayPos: true }, file);
        } else {
          walk(child, ctx, file);
        }
      }
      return;
    }
    case "JSXAttribute": {
      const name = attrName(n.name);
      if (ATTR_IGNORES.test(name)) return;
      const value = n.value as
        | { type: string; value?: unknown; expression?: { type: string; value?: unknown } }
        | undefined
        | null;
      if (value === null || value === undefined) return;
      if (value.type === "Literal" && typeof value.value === "string") {
        const text = value.value;
        if (text.length === 0 || GLYPH_ONLY.test(text) || LITERAL_ALLOWS.has(text)) return;
        if (USER_FACING_ATTRS.has(name) || ATTR_PATTERN.test(name)) {
          violations.push({
            at: at(file, value as Loc),
            rule: `attr:${name}`,
            detail: `hardcoded ${name} ${JSON.stringify(text)}`,
          });
        } else if (CYRILLIC.test(text)) {
          violations.push({
            at: at(file, value as Loc),
            rule: "cyrillic",
            detail: `Cyrillic in ${name} ${JSON.stringify(text)}`,
          });
        }
        return;
      }
      if (value.type === "JSXExpressionContainer" && value.expression?.type === "StringLiteral") {
        violations.push({
          at: at(file, value.expression as Loc),
          rule: `attr:${name}`,
          detail: `hardcoded ${name} ${JSON.stringify((value.expression as { value: string }).value)}`,
        });
      }
      return;
    }
    case "BinaryExpression":
    case "UnaryExpression":
    case "SwitchCase":
    case "UpdateExpression": {
      for (const [key, value] of Object.entries(n)) {
        if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
        walk(value, { inJsxChildExpr: ctx.inJsxChildExpr, displayPos: false }, file);
      }
      return;
    }
    case "Literal": {
      if (typeof n.value === "string")
        flagString(file, n as unknown as Loc, String(n.value), ctx, "literal");
      return;
    }
    case "TemplateLiteral": {
      for (const quasi of n.quasis as Array<{ value: { cooked: string } } & Loc>) {
        flagString(file, quasi, quasi.value.cooked, ctx, "template");
      }
      for (const expr of n.expressions as unknown[]) walk(expr, ctx, file);
      return;
    }
    case "CallExpression":
    case "NewExpression": {
      const callee = n.callee as { type: string; name?: string; property?: { name?: string } };
      const args = n.arguments as Array<{ type: string; value?: unknown }>;
      void args;
      if (callee.type === "Identifier" && callee.name === "t" && args[0]?.type === "Literal") {
        tKeysUsed.add(String(args[0].value));
      }
      for (const arg of n.arguments as unknown[]) {
        walk(arg, { inJsxChildExpr: ctx.inJsxChildExpr, displayPos: false }, file);
      }
      return;
    }
    case "Property": {
      const key = n.key as { type: string; name?: string; value?: unknown };
      const propName = key.type === "Identifier" ? (key.name ?? "") : "";
      const value = n.value as { type: string; value?: unknown } & Loc;
      if (
        typeof value?.value === "string" &&
        (value.type === "Literal" || value.type === "StringLiteral")
      ) {
        flagString(file, value, value.value, ctx, "property", propName);
        return;
      }
      walk(value, ctx, file);
      return;
    }
    default: {
      for (const [key, value] of Object.entries(n)) {
        if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
        walk(value, ctx, file);
      }
    }
  }
}

function listFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

function catalogFrom(source: string, dict: Record<string, string>) {
  return { source, keys: Object.entries(dict) };
}

async function main(): Promise<number> {
  // Catalog integrity: base dictionaries + every domain fragment.
  const [ruMod, enMod, { ru, en }] = await Promise.all([
    import(join(ROOT, "i18n/ru.js")),
    import(join(ROOT, "i18n/en.js")),
    import(join(ROOT, "i18n/index.js")),
  ]);
  const sources = [catalogFrom("ru.ts", ruMod.ru), catalogFrom("en.ts", enMod.en)];
  const domDir = join(ROOT, "i18n/dom");
  for (const name of readdirSync(domDir).sort()) {
    if (!/\.ts$/.test(name)) continue;
    const mod = (await import(join(domDir, name))) as Record<string, unknown>;
    const fragment = Object.values(mod).find(
      (value) => typeof value === "object" && value !== null && "ru" in (value as object),
    ) as { ru: Record<string, string>; en: Record<string, string> } | undefined;
    if (fragment === undefined) {
      violations.push({
        at: `i18n/dom/${name}`,
        rule: "fragment-shape",
        detail: "no defineFragment result export found",
      });
      continue;
    }
    sources.push(catalogFrom(`dom/${name} (ru)`, fragment.ru));
    sources.push(catalogFrom(`dom/${name} (en)`, fragment.en));
  }

  const isEnSource = (s: { source: string }) => s.source === "en.ts" || s.source.endsWith("(en)");
  const owners = {
    ru: new Map<string, string>(),
    en: new Map<string, string>(),
  };
  for (const source of sources) {
    const owner = isEnSource(source) ? owners.en : owners.ru;
    for (const [key, value] of source.keys) {
      const previous = owner.get(key);
      if (previous !== undefined) {
        violations.push({
          at: source.source,
          rule: "duplicate-key",
          detail: `"${key}" already defined in ${previous}`,
        });
      }
      owner.set(key, source.source);
      if (String(value).trim().length === 0) {
        violations.push({
          at: source.source,
          rule: "empty-value",
          detail: `"${key}"`,
        });
      }
    }
  }
  const ruKeys = new Set(
    sources.filter((s) => !isEnSource(s)).flatMap((s) => s.keys.map(([k]) => k)),
  );
  const enKeys = new Set(sources.filter(isEnSource).flatMap((s) => s.keys.map(([k]) => k)));
  for (const key of ruKeys) {
    if (!enKeys.has(key)) {
      violations.push({ at: "catalog", rule: "missing-en", detail: key });
    }
  }
  for (const key of enKeys) {
    if (!ruKeys.has(key)) {
      violations.push({ at: "catalog", rule: "missing-ru", detail: key });
    }
  }

  // Source scan.
  const files = listFiles(ROOT);
  for (const file of files) {
    if (FILE_EXEMPTS.some((pattern) => pattern.test(file))) continue;
    const rel = relative(ROOT, file);
    const source = readFileSync(file, "utf8");
    let ast: unknown;
    try {
      ast = Parser.extend(tsPlugin({ jsx: {} }) as never).parse(source, {
        sourceType: "module",
        ecmaVersion: "latest",
        locations: true,
      });
    } catch (error) {
      violations.push({
        at: rel,
        rule: "parse",
        detail: String(error).slice(0, 200),
      });
      continue;
    }
    walk(ast, { inJsxChildExpr: false, displayPos: false }, rel);
  }

  // Every literal t("key") must exist in the merged RU catalog.
  for (const key of tKeysUsed) {
    if (!(key in (ru as Record<string, string>))) {
      violations.push({ at: "catalog", rule: "unknown-t-key", detail: key });
    }
  }

  for (const v of violations) {
    console.log(`${v.at} [${v.rule}] ${v.detail}`);
  }
  console.log(
    `\nfiles scanned: ${files.length}; catalog keys: ${ruKeys.size}; violations: ${violations.length}`,
  );
  void en;
  return violations.length === 0 ? 0 : 1;
}

process.exit(await main());
