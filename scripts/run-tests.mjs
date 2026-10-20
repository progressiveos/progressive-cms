// Node test orchestrator (PCMS-ADMIN-T017; merge-note item).
// The M09 handoff documented two DB-concurrency-sensitive suites
// (tests/jobs/queue.test.ts "claim safety", tests/publication/plans.test.ts
// "failure policies") whose fixture timing degrades when the whole suite
// runs in parallel — M10 added many more DB-backed files, making the flake
// near-permanent. Per the handoff recommendation ("isolate the DB load of
// these files"), the main corpus runs in parallel and these two run after,
// sequentially. Exit code is non-zero when any phase fails.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// tests/search/performance.test.ts joins them (M16): its query-plan
// assertion degrades to Seq Scan under parallel DB load on a fresh test
// database (planner statistics), green in isolation — same fixture-timing
// class as the two suites above.
const ISOLATED = new Set([
  "tests/jobs/queue.test.ts",
  "tests/publication/plans.test.ts",
  "tests/search/performance.test.ts",
]);

function collectTests(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTests(full, out);
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
}

const all = [];
collectTests("tests", all);
const main = all.filter((file) => !ISOLATED.has(file)).sort();
const isolated = all.filter((file) => ISOLATED.has(file)).sort();

const NODE_OPTIONS = ["--env-file-if-exists=.env", "--import", "tsx", "--test"];

function run(label, args, files) {
  console.log(`> ${label}: ${files.length} file(s)`);
  const result = spawnSync(process.execPath, [...NODE_OPTIONS, ...args, ...files], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`test phase failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

run("parallel corpus", ["--test-concurrency=4"], main);
run("isolated DB-sensitive suites", ["--test-concurrency=1"], isolated);
