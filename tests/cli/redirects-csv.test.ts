// CSV parsing for `cms redirects validate|apply` (Navigation spec §60):
// header mapping, quoted fields, CRLF, 410-without-target, status default.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRedirectCsv } from "../../packages/cli/src/commands/redirects.js";

test("header mapping, defaults and 410 rows without target", () => {
  const csv = [
    "source,target,status_code,reason",
    "/old/,/new/,301,renamed",
    "/dead/,,410,removed",
    "/plain/,/x/",
  ].join("\n");
  const { rows, warnings } = parseRedirectCsv(csv);
  assert.deepEqual(rows, [
    { source: "/old/", target: "/new/", status_code: 301, reason: "renamed" },
    { source: "/dead/", target: null, status_code: 410, reason: "removed" },
    { source: "/plain/", target: "/x/", status_code: 301 },
  ]);
  assert.deepEqual(warnings, []);
});

test("quoted fields with commas, doubled quotes and CRLF line endings", () => {
  const csv = 'source,target,reason\r\n"/a, b/","/x/","moved, ""finally"""\r\n';
  const { rows } = parseRedirectCsv(csv);
  assert.deepEqual(rows, [
    { source: "/a, b/", target: "/x/", status_code: 301, reason: 'moved, "finally"' },
  ]);
});

test("empty source rows are skipped with a warning; missing header columns throw", () => {
  const ok = parseRedirectCsv("source,target\n,skip-me\n/ok/,/x/");
  assert.deepEqual(ok.rows, [{ source: "/ok/", target: "/x/", status_code: 301 }]);
  assert.equal(ok.warnings.length, 1);
  assert.throws(() => parseRedirectCsv("source,other\n/a/,/x/"), /source.*target/);
});
