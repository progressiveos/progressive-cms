// ADR-0017 acceptance: the Core codebase imports NO first-party package
// implementations. The only sanctioned edges are (a) the GENERATED trusted
// catalog `extensions/catalog.ts` composed by the web/worker roots and
// (b) tests. Anything else importing `extensions/<package>/…` by a private
// path is a composition violation.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname ?? ".", "..", "..");
// Matches imports of first-party PACKAGE sources (progressive-*/reference-
// site) — the content domain's own `extensions/` subdirectory and the
// sanctioned generated `extensions/catalog.js` edge do not match.
const PRIVATE_IMPORT =
  /(?:from\s+|import\s*\(\s*)["'][^"']*extensions\/(?:progressive-|reference-site)[^"']*["']/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      yield* walk(full);
    } else if (entry.isFile() && /\.(ts|tsx|mts|mjs|js)$/.test(entry.name)) {
      yield full;
    }
  }
}

test("core imports no first-party package implementations by private paths", () => {
  const violations: string[] = [];
  for (const scope of ["packages", "apps"]) {
    for (const file of walk(join(ROOT, scope))) {
      if (file.endsWith("/apps/admin/src/extension/contributions.generated.ts")) continue;
      const source = readFileSync(file, "utf8");
      if (PRIVATE_IMPORT.test(source)) violations.push(file.replace(/\\/g, "/"));
    }
  }
  if (violations.length > 0) {
    assert.fail(`private first-party imports:\n${violations.join("\n")}`);
  }
});
