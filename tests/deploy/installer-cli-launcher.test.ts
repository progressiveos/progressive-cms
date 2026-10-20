import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const installer = readFileSync("deploy/scripts/install-release.sh", "utf8");
const helper = installer.match(/^install_cli_launcher\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(helper);

test("native CLI launcher preserves arguments/config selection and is idempotent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-launcher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const current = join(root, "runtime dir");
  const main = join(current, "packages/cli/src/bin/cms.js");
  mkdirSync(join(main, ".."), { recursive: true });
  writeFileSync(
    main,
    "console.log(JSON.stringify({ args: process.argv.slice(2), config: process.env.PCMS_CONFIG_FILE }));\n",
  );
  const target = join(root, "bin/cms");
  const config = join(root, "site config.json");
  const driver = join(root, "driver.sh");
  writeFileSync(
    driver,
    `set -e\nCONFIG=$1\nCURRENT=$2\nlog() { :; }\n${helper}\ninstall_cli_launcher "$3"\n`,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    execFileSync("bash", [driver, config, current, target]);
    assert.equal(statSync(target).mode & 0o777, 0o755);
    const args = ["--json", "argument with spaces"];
    for (const selected of ["", join(root, "explicit.json")]) {
      const output = execFileSync(target, args, {
        encoding: "utf8",
        env: { ...process.env, PCMS_CONFIG_FILE: selected },
      });
      assert.deepEqual(JSON.parse(output), { args, config: selected || config });
    }
  }
  assert.match(installer, /install_cli_launcher \/usr\/local\/bin\/cms/);
});

test("native installer preserves an existing operator-owned command", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-launcher-owned-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "cms");
  const original = "#!/bin/sh\necho operator-managed\n";
  writeFileSync(target, original, { mode: 0o755 });
  execFileSync("bash", [
    "-c",
    `set -e; log() { :; }; ${helper}; install_cli_launcher "$1"`,
    "test",
    target,
  ]);
  assert.equal(readFileSync(target, "utf8"), original);
});
