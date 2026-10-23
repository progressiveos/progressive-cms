import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = readFileSync("deploy/scripts/backup-site.sh", "utf8");

test("backup completion survives retention failure, but not a failed database dump", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-backup-retention-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const scenario of ["normal", "retention-denied", "dump-failed"]) {
    const base = join(root, scenario);
    for (const path of ["backups", "release", "config/secrets", "media", "bin"])
      mkdirSync(join(base, path), { recursive: true });
    writeFileSync(
      join(base, "config/pcms.json"),
      JSON.stringify({ db: { host: "test", user: "test", database: "test" } }),
    );
    writeFileSync(join(base, "config/secrets/db.password"), "synthetic-test-password");
    writeFileSync(
      join(base, "release/build-metadata.json"),
      JSON.stringify({ releaseId: "test", gitCommit: "test" }),
    );
    for (let n = 1; n <= 8; n++) mkdirSync(join(base, "backups", `2020010${n}T000000Z`));
    const executable = (name: string, body: string) =>
      writeFileSync(join(base, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    executable("id", "echo 1000"); // Exercise the service-user path even in a root test runner.
    executable("psql", "printf 'test\\n'");
    executable(
      "pg_dump",
      scenario === "dump-failed"
        ? "exit 1"
        : 'if [ "$1" = --version ]; then echo "pg_dump test"; else while [ "$1" != -f ]; do shift; done; printf dump > "$2"; fi',
    );
    executable("systemctl", "echo ActiveState=active");
    executable(
      "rm",
      scenario === "retention-denied"
        ? 'case "$*" in *20200101*) echo "Permission denied" >&2; exit 1;; esac; exec /bin/rm "$@"'
        : 'exec /bin/rm "$@"',
    );
    let script = source;
    for (const [key, directory] of [
      ["BACKUP_ROOT", "backups"],
      ["RELEASE_ROOT", "release"],
      ["CONF_DIR", "config"],
      ["MEDIA_DIR", "media"],
    ] as const)
      script = script.replace(new RegExp(`^${key}=.*$`, "m"), `${key}='${join(base, directory)}'`);
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(base, "bin")}:${process.env.PATH}` },
    });
    if (scenario === "dump-failed") {
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /backup set:/);
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    const set = result.stdout.trim().replace(/^backup set: /, "");
    assert.equal(
      spawnSync("sha256sum", ["-c", "checksums.sha256", "--quiet"], { cwd: set }).status,
      0,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(set, "warnings.json"), "utf8")),
      scenario === "retention-denied" ? ["BACKUP_RETENTION_FAILED"] : [],
    );
    if (scenario === "retention-denied") assert.match(result.stderr, /BACKUP_RETENTION_FAILED/);
  }
});
