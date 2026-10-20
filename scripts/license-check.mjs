#!/usr/bin/env node
// License allowlist scan over the installed dependency tree (node_modules).
// Prints package name@version + license only — no environment data, no
// registry payloads, no secrets (PCMS-M00-T011 acceptance).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = new Set([
  "MIT",
  "MIT-0", // MIT with no attribution requirement (@csstools helpers)
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "WTFPL",
  // Media subsystem exception (Media spec §23: Sharp/libvips is the approved
  // processor baseline): sharp's prebuilt libvips platform binaries are
  // LGPL-3.0-or-later / LGPL-2.1-or-later. They ship as unmodified, separate,
  // replaceable libraries — the standard LGPL compliance model. Documented in
  // THIRD_PARTY_NOTICES.md; revisit only if the processor baseline changes.
  "LGPL-3.0-or-later",
  "LGPL-2.1-or-later",
  "LGPL-2.1",
  "LGPL-3.0",
  // Build-tool exception (M10, ADR-0009): lightningcss is a vite build-time
  // dependency (Admin bundle CSS minification). It never ships in runtime
  // bundles or server processes; MPL-2.0 is file-level copyleft that does not
  // affect the generated artifact. Build tooling only.
  "MPL-2.0",
]);

// Fixture/benchmark/example folders inside dependency packages contain stray
// package.json files that are NOT shipped packages (e.g. pino/test/fixtures,
// secure-json-parse/benchmarks) — skip them so only real dependencies count.
const NON_PACKAGE_DIRS = new Set([
  "test",
  "tests",
  "fixtures",
  "fixture",
  "benchmarks",
  "benchmark",
  "examples",
  "example",
  "docs",
]);

function* packageJsonFiles(dir, depth = 0) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth >= 1 && NON_PACKAGE_DIRS.has(e.name)) continue;
      yield* packageJsonFiles(p, depth + 1);
    } else if (e.name === "package.json") yield p;
  }
}

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(", ");
  return "UNKNOWN";
}

function spdxTokens(license) {
  // SPDX operators are whitespace-separated (e.g. "MIT OR LGPL-3.0-or-later");
  // splitting only on them keeps hyphenated identifiers ("or-later") whole.
  return license
    .split(/[()]+/)
    .flatMap((part) => part.trim().split(/\s+(?:OR|AND)\s+/i))
    .map((t) => t.trim())
    .filter((t) => t && t !== "," && t !== ";");
}

if (!existsSync("node_modules")) {
  console.error("license-check: node_modules not found — run npm install first");
  process.exit(2);
}

const seen = new Set();
const violations = [];
for (const file of packageJsonFiles("node_modules")) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue; // unreadable file — skip, not a license verdict
  }
  if (!pkg.name || !pkg.version) continue;
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const license = licenseOf(pkg);
  const bad = spdxTokens(license).filter((t) => !ALLOWED.has(t));
  if (bad.length > 0) violations.push(`${id}: "${license}" (unknown: ${bad.join(", ")})`);
}

console.log(`license-check: scanned ${seen.size} packages`);
if (violations.length > 0) {
  console.error(`license-check: ${violations.length} package(s) outside the allowlist:`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("license-check: all licenses within allowlist");
