// PCMS-FORM-T001 — Forms/Interactions module boundaries (Forms spec §0/§43).
//
// @pcms/forms is an L1 bounded context: single public application entry, no
// imports outside @pcms/core, and its PII-holding domain never reaches into
// Content, Themes, Auth or future Integrations packages. The repo-wide layer
// map lives in tests/architecture.test.ts; this suite pins the forms-specific
// surface contract.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("forms exposes a single public application entry", () => {
  const manifest = JSON.parse(readFileSync("packages/forms/package.json", "utf8")) as {
    exports?: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(manifest.exports ?? {}), ["."]);
});

test("forms sources import @pcms/core only (PII never crosses subsystems)", () => {
  const IMPORT_RE = /from\s+["'](@pcms\/([\w-]+))(\/[^"']*)?["']/g;
  const problems: string[] = [];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
    );
  for (const file of walk("packages/forms/src")) {
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
      const imported = m[2];
      const subpath = m[3];
      if (imported !== "core" || subpath) problems.push(`${file}: ${m[1]}${subpath ?? ""}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("forms public surface is importable and exports the package name", async () => {
  const forms = await import("@pcms/forms");
  assert.equal(forms.PACKAGE_NAME, "@pcms/forms");
  assert.ok(forms.FORMS_ERROR_CODES.length > 0);
});
