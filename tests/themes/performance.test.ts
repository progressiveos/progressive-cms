// Performance budget/report hook tests (PCMS-THEME-T028, P1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AssetBuildOutput, performanceReport } from "@pcms/themes";

function output(source: string, bytes: number): AssetBuildOutput {
  return { source, output: source, hash: "0".repeat(8), bytes };
}

test("reference-sized assets stay within default budgets", () => {
  const report = performanceReport([
    output("assets/css/theme.css", 9_211),
    output("assets/js/theme.js", 6_400),
  ]);
  assert.equal(report.within, true);
  assert.deepEqual(report.breaches, []);
  assert.equal(report.totals.js, 6_400);
  assert.equal(report.totals.css, 9_211);
});

test("oversized bundles and per-file scripts are surfaced", () => {
  const report = performanceReport([
    output("assets/js/vendor.js", 300_000),
    output("assets/js/app.js", 40_000),
    output("assets/css/theme.css", 20_000),
  ]);
  assert.equal(report.within, false);
  assert.deepEqual(
    report.breaches.map((b) => b.path),
    ["/assets/js", "/assets/js/vendor.js"],
  );
  assert.ok(report.breaches[0]?.message.includes("340000"));
});

test("custom budgets tighten the report (policy-owned)", () => {
  const report = performanceReport([output("assets/css/theme.css", 9_211)], {
    totalCssBytes: 5_000,
  });
  assert.equal(report.within, false);
  assert.equal(report.breaches[0]?.path, "/assets/css");
});
