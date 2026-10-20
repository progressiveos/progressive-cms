// Basic performance budget/report hook (PCMS-THEME-T028, P1; Theme Contract
// spec §54). Surfacing only — deployment/project policy may tighten budgets;
// the defaults below encode the v1 sanity floor (no giant JS bundles, bounded
// CSS). Deterministic: totals and breaches derive purely from asset outputs.
import type { AssetBuildOutput } from "./assets.js";

export interface PerformanceBudget {
  /** Total JS across the theme; default 250 000 bytes. */
  readonly totalJsBytes?: number;
  /** Total CSS across the theme; default 150 000 bytes. */
  readonly totalCssBytes?: number;
  /** Per-file bound; default 100 000 bytes for JS/CSS. */
  readonly perAssetBytes?: number;
}

export interface PerformanceBreach {
  readonly code: "THEME_PERF_BUDGET_EXCEEDED";
  readonly path: string;
  readonly message: string;
}

export interface PerformanceReport {
  readonly totals: { readonly js: number; readonly css: number };
  readonly within: boolean;
  readonly breaches: readonly PerformanceBreach[];
}

export const DEFAULT_PERFORMANCE_BUDGET: Required<PerformanceBudget> = {
  totalJsBytes: 250_000,
  totalCssBytes: 150_000,
  perAssetBytes: 100_000,
};

export function performanceReport(
  outputs: readonly AssetBuildOutput[],
  budget: PerformanceBudget = {},
): PerformanceReport {
  const limits = { ...DEFAULT_PERFORMANCE_BUDGET, ...budget };
  const js = outputs.filter((o) => o.source.endsWith(".js"));
  const css = outputs.filter((o) => o.source.endsWith(".css"));
  const totalJs = js.reduce((sum, o) => sum + o.bytes, 0);
  const totalCss = css.reduce((sum, o) => sum + o.bytes, 0);
  const breaches: PerformanceBreach[] = [];
  if (totalJs > limits.totalJsBytes) {
    breaches.push({
      code: "THEME_PERF_BUDGET_EXCEEDED",
      path: "/assets/js",
      message: `total JS ${totalJs} bytes exceeds budget ${limits.totalJsBytes}`,
    });
  }
  if (totalCss > limits.totalCssBytes) {
    breaches.push({
      code: "THEME_PERF_BUDGET_EXCEEDED",
      path: "/assets/css",
      message: `total CSS ${totalCss} bytes exceeds budget ${limits.totalCssBytes}`,
    });
  }
  for (const output of outputs) {
    if (output.bytes > limits.perAssetBytes) {
      breaches.push({
        code: "THEME_PERF_BUDGET_EXCEEDED",
        path: `/${output.source}`,
        message: `asset ${output.source} (${output.bytes} bytes) exceeds per-asset budget ${limits.perAssetBytes}`,
      });
    }
  }
  return { totals: { js: totalJs, css: totalCss }, within: breaches.length === 0, breaches };
}
