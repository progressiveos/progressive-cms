// Hardened LiquidJS engine factory (PCMS-THEME-T004; Theme Contract spec §4,
// §20, §72). Decision recorded in docs/adr/0006-liquid-template-engine.md.
//
// Security posture:
//  - autoescape is unconditional: every output value passes through
//    `stringifyOutput`, which escapes unless the value is a trusted SafeHtml;
//  - the builtin `| raw` filter is removed — raw output is only reachable via
//    SafeHtml values produced by trusted renderers;
//  - templates render from an in-memory snapshot (no filesystem access from
//    template source, no arbitrary include paths);
//  - `ownPropertyOnly` blocks prototype-chain escapes like `x.constructor`;
//  - bounded resources: parseLimit / renderLimit guard DoS-sized templates.
import { Liquid, type LiquidOptions } from "liquidjs";
import { isSafeHtml, stringifyOutput } from "./safe-html.js";

/** Theme source snapshot: template name (no directories) → source text. */
export type TemplateSnapshot = Readonly<Record<string, string>>;

export interface ThemeEngineOptions {
  /** Template sources for `renderFile` + include/render lookups. */
  readonly templates: TemplateSnapshot;
  /** Per-render time budget in ms (LiquidJS renderLimit); default 1000. */
  readonly renderTimeBudgetMs?: number;
}

const DEFAULT_RENDER_TIME_BUDGET_MS = 1000;

export function createThemeEngine(options: ThemeEngineOptions): Liquid {
  const partials: Record<string, string> = { ...options.templates };
  const liquidOptions: LiquidOptions = {
    // Templates address only the snapshot: include/render resolve against
    // `templates`, never the host filesystem. The snapshot is immutable per
    // engine instance, so parsed templates are cached (parse once, render N).
    templates: partials as NonNullable<LiquidOptions["templates"]>,
    cache: true,
    ownPropertyOnly: true,
    strictFilters: true,
    // Optional content fields may be absent; templates use `| default`.
    strictVariables: false,
    outputEscape: (value: unknown) => stringifyOutput(value),
    parseLimit: 1_000_000,
    renderLimit: options.renderTimeBudgetMs ?? DEFAULT_RENDER_TIME_BUDGET_MS,
  };
  const engine = new Liquid(liquidOptions);
  // `| raw`/`| escape` would bypass or duplicate autoescape handling for
  // arbitrary values; trusted fragments flow through SafeHtml instead
  // (Theme spec §20).
  for (const filter of ["raw", "escape"] as const) {
    if (filter in engine.filters) engine.unregisterFilter(filter);
  }
  // `| date` (theme developer report 0.1.119→0.123: liquidjs builtin passes
  // non-Date input through untouched, so article dates never rendered).
  // Deterministic: input parsed as UTC, rendered in UTC. Default format
  // dd.MM.yyyy; supported tokens: yyyy, yy, MM, dd, HH, mm. Non-dates pass
  // through unchanged (SafeHtml stays SafeHtml).
  engine.registerFilter("date", (value: unknown, ...args: unknown[]): unknown => {
    if (value instanceof Date) {
      return formatUtcDate(value, typeof args[0] === "string" ? args[0] : undefined);
    }
    if (typeof value !== "string" || value.trim() === "") return value;
    const parsed = new Date(value.trim());
    if (Number.isNaN(parsed.getTime())) return value;
    return formatUtcDate(parsed, typeof args[0] === "string" ? args[0] : undefined);
  });
  return engine;
}

function formatUtcDate(date: Date, format?: string): string {
  const pattern = format ?? "dd.MM.yyyy";
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const tokens: Record<string, string> = {
    yyyy: String(date.getUTCFullYear()),
    yy: pad(date.getUTCFullYear() % 100),
    MM: pad(date.getUTCMonth() + 1),
    dd: pad(date.getUTCDate()),
    HH: pad(date.getUTCHours()),
    mm: pad(date.getUTCMinutes()),
  };
  return pattern.replace(/yyyy|yy|MM|dd|HH|mm/g, (token) => tokens[token] ?? token);
}

export { isSafeHtml, safeHtml } from "./safe-html.js";
