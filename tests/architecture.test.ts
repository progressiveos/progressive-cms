import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Architecture boundary enforcement (PCMS-M00-T005/T008; apps layer added
 * in PCMS-OPS-T007, see ADR-0003; application-surface rule added in
 * PCMS-CONT-T001).
 *
 * Layer map, from Architecture Baseline v0.2 §6 ("modular monolith"):
 *   L0 core        — imports no @pcms/* package
 *   L1 subsystems  — may import @pcms/core only; subsystems never import
 *                    each other's code (interaction goes through core
 *                    contracts, events, registries)
 *   L2 transports  — api/mcp/cli may import core + any subsystem
 *   apps           — web/worker composition roots may import core, any L1
 *                    and any L2 transport (they sit above everything and
 *                    wire processes together); apps never import each other
 *                    and no package ever imports an app.
 *
 * Application-surface rule (Content spec §82, Baseline §6): interaction with
 * a subsystem goes through its public application entry only. Deep imports
 * ("@pcms/<pkg>/…") bypass the application layer and are forbidden for every
 * importer — a package's internals are private by construction.
 *
 * Changing this map is an architecture decision: ADR required.
 */
const L1: readonly string[] = [
  "content",
  "blocks",
  "navigation",
  "routing",
  "revisions",
  "publication",
  "jobs",
  "media",
  "seo",
  "auth",
  "search",
  "forms",
  "integrations",
  "payments",
  "audit",
  "themes",
  "extensions",
  "operations",
  // M16 (ADR-0012): Agent Skills domain — manifest schema, compatibility
  // evaluator, installed-skill discovery. Pure L1: imports no @pcms/* code.
  "skills",
  // ADR-0016: Analytics & Tagging — L1 bounded subsystem (imports @pcms/core
  // only; provider-specific code never enters core/themes/renderer).
  "analytics",
];
const L2: readonly string[] = ["api", "mcp", "cli"];
/** Composition-root processes (ADR-0003): above transports, wire everything.
 * `admin` (ADR-0009) is a browser SPA workspace: it imports no @pcms/* code —
 * it is a pure static artifact served by the web process. */
const APPS: readonly string[] = ["web", "worker", "admin"];
const ALL = new Set(["core", ...L1, ...L2]);

function isAllowed(importer: string, imported: string): boolean {
  if (importer === "core") return false; // L0 imports nothing
  if (L1.includes(importer)) return imported === "core";
  if (L2.includes(importer)) return imported === "core" || L1.includes(imported);
  if (APPS.includes(importer))
    return imported === "core" || L1.includes(imported) || L2.includes(imported);
  return false;
}

const IMPORT_RE =
  /from\s+["'](@pcms\/([\w-]+))(\/[^"']*)?["']|import\s+["'](@pcms\/([\w-]+))(\/[^"']*)?["']/g;

function violationsIn(source: string, pkg: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const imported = m[2] ?? m[5];
    if (!imported) continue;
    const subpath = m[3] ?? m[6];
    const specifier = `@pcms/${imported}${subpath ?? ""}`;
    // Application-surface rule: only the bare package entry is public.
    if (
      subpath &&
      !(
        imported === "extensions" &&
        subpath === "/internal" &&
        (L2.includes(pkg) || APPS.includes(pkg))
      )
    ) {
      found.push(specifier);
      continue;
    }
    if (subpath) continue;
    if (!isAllowed(pkg, imported)) found.push(specifier);
  }
  return found;
}

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p);
    else if (e.name.endsWith(".ts")) yield p;
  }
}

test("checker itself flags a forbidden L1→L2 import (negative self-check)", () => {
  assert.deepEqual(violationsIn(`import { x } from "@pcms/api";`, "content"), ["@pcms/api"]);
  assert.deepEqual(violationsIn(`import "@pcms/cli";`, "core").length, 1);
  assert.deepEqual(violationsIn(`import { y } from "@pcms/core";`, "content"), []);
  assert.deepEqual(violationsIn(`import { z } from "@pcms/audit";`, "api"), []);
});

test("checker enforces the apps layer (negative self-check)", () => {
  // apps may use transports and subsystems…
  assert.deepEqual(violationsIn(`import { a } from "@pcms/api";`, "web"), []);
  assert.deepEqual(violationsIn(`import { c } from "@pcms/content";`, "worker"), []);
  // …but never each other, and packages never import apps.
  assert.deepEqual(violationsIn(`import "@pcms/worker";`, "web").length, 1);
  assert.deepEqual(violationsIn(`import "@pcms/web";`, "core").length, 1);
  assert.deepEqual(violationsIn(`import "@pcms/web";`, "api").length, 1);
});

test("checker forbids bypassing the application layer (negative self-check)", () => {
  // Deep imports are private-by-construction for every importer, even when
  // the layer map would allow the package itself.
  assert.deepEqual(violationsIn(`import { x } from "@pcms/content/src/ids";`, "api"), [
    "@pcms/content/src/ids",
  ]);
  assert.deepEqual(violationsIn(`import "@pcms/core/src/db/pool.js";`, "content").length, 1);
  assert.deepEqual(violationsIn(`import { y } from "@pcms/content";`, "api"), []);
  assert.deepEqual(violationsIn(`import { y } from "@pcms/extensions/internal";`, "api"), []);
  assert.deepEqual(violationsIn(`import { y } from "@pcms/extensions/internal";`, "extensions"), [
    "@pcms/extensions/internal",
  ]);
});

test("package tree matches the boundary map", () => {
  const dirs = readdirSync("packages");
  assert.deepEqual(
    dirs.filter((d) => !ALL.has(d)),
    [],
    "package without a declared layer",
  );
  for (const d of ALL) assert.ok(readdirSync(`packages/${d}`).includes("package.json"), d);
});

test("content/blocks expose a single public application entry (PCMS-CONT-T001)", () => {
  for (const pkg of ["content", "blocks"]) {
    const manifest = JSON.parse(readFileSync(`packages/${pkg}/package.json`, "utf8")) as {
      exports?: Record<string, unknown>;
    };
    assert.deepEqual(
      Object.keys(manifest.exports ?? {}),
      ["."],
      `${pkg} must export exactly the application entry "."`,
    );
  }
});

test("apps tree matches the composition-root map", () => {
  const dirs = readdirSync("apps");
  assert.deepEqual(
    dirs.filter((d) => !APPS.includes(d)),
    [],
    "app without a declared composition root",
  );
  for (const d of APPS) assert.ok(readdirSync(`apps/${d}`).includes("package.json"), d);
});

test("no forbidden @pcms/* imports in package sources", () => {
  const problems: string[] = [];
  for (const pkg of ALL) {
    for (const file of tsFiles(join("packages", pkg))) {
      for (const v of violationsIn(readFileSync(file, "utf8"), pkg)) {
        problems.push(`${file}: ${v}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("no forbidden @pcms/* imports in app sources", () => {
  const problems: string[] = [];
  for (const app of APPS) {
    for (const file of tsFiles(join("apps", app))) {
      for (const v of violationsIn(readFileSync(file, "utf8"), app)) {
        problems.push(`${file}: ${v}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
