import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("deploy/scripts/backup-site.sh");

test("direct root backup delegates to the unit before any backup work", (t) => {
  const base = mkdtempSync(join(tmpdir(), "pcms-backup-entry-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, "bin"));
  writeFileSync(join(base, "bin/id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
  const calls = join(base, "calls");
  writeFileSync(
    join(base, "bin/systemctl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit "\${TEST_UNIT_STATUS:-0}"\n`,
    { mode: 0o755 },
  );
  // Any accidental fallthrough must fail without accessing real configuration.
  writeFileSync(join(base, "bin/jq"), "#!/bin/sh\necho unexpected-backup-work >&2\nexit 99\n", {
    mode: 0o755,
  });
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(base, "bin")}:${process.env.PATH}`,
        INVOCATION_ID: "",
        ...extra,
      },
    });
  const success = run([]);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(readFileSync(calls, "utf8"), "start progressive-cms-backup.service\n");
  assert.equal(run([], { TEST_UNIT_STATUS: "5" }).status, 5, "unit failure must propagate");
  rmSync(calls);
  const unsupported = run(["--retention", "3"]);
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /BACKUP_UNIT_ARGUMENTS_UNSUPPORTED/);
  const misconfigured = run([], { INVOCATION_ID: "test-invocation" });
  assert.equal(misconfigured.status, 2);
  assert.match(misconfigured.stderr, /BACKUP_SERVICE_USER_INVALID/);
  assert.equal(existsSync(calls), false, "neither rejection may start the unit");
  assert.doesNotMatch(
    success.stderr + unsupported.stderr + misconfigured.stderr,
    /unexpected-backup-work/,
  );
});
