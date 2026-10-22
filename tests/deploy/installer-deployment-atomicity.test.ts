import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const installer = readFileSync("deploy/scripts/install-release.sh", "utf8");
const helper = (name: string) => {
  const source = installer.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0];
  assert.ok(source, name);
  return source;
};
const install = installer.match(/^install_from_incoming\(\) \([\s\S]*?^\)/m)?.[0];
assert.ok(install);

test("installer restores current on an activation error and refuses unreadable releases before switching", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-install-atomic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const failure of ["launcher", "unreadable", "none"]) {
    const scenario = join(root, failure);
    const incoming = join(scenario, "incoming");
    const releases = join(scenario, "releases");
    const pin = join(scenario, "pin");
    for (const path of [incoming, releases, pin]) mkdirSync(path, { recursive: true });
    const previous = join(releases, "v1-old");
    mkdirSync(previous);
    symlinkSync(previous, join(scenario, "current"));
    const payload = join(scenario, "payload/v2-new");
    mkdirSync(payload, { recursive: true });
    const manifest = { version: "2.0.0", rollback_policy: "rollback_safe" };
    writeFileSync(
      join(payload, "build-metadata.json"),
      JSON.stringify({
        releaseId: "v2-new",
        gitCommit: "test",
        schema: "pcms-release-build/1",
        version: "2.0.0",
      }),
    );
    writeFileSync(join(payload, "update-manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(incoming, "update-manifest.json"), JSON.stringify(manifest));
    const zip = join(incoming, "release.zip");
    assert.equal(
      spawnSync("zip", ["-qr", zip, "v2-new"], { cwd: join(scenario, "payload") }).status,
      0,
    );
    const digest = spawnSync("sha256sum", ["release.zip"], { cwd: incoming, encoding: "utf8" });
    writeFileSync(`${zip}.sha256`, digest.stdout);
    const script: string = [
      "set -eu",
      'id() { printf 0; }; chown() { :; }; log() { :; }; die() { echo "$*" >&2; exit 1; }',
      helper("normalize_release_permissions"),
      'verify_release_access() { [ "$FAILURE" != unreadable ] || die "runtime unreadable"; }',
      'install_cli_launcher() { [ "$FAILURE" != launcher ]; }',
      install,
      "INCOMING=$1; RELEASES=$2; CURRENT=$3; PIN_DIR=$4; FAILURE=$5; SERVICE_USER=progressive-cms; OPT_EXPECT_VERSION=; OPT_EXPECT_POLICY=",
      "install_from_incoming 1",
    ].join("\n");
    const result = spawnSync(
      "bash",
      ["-c", script, "installer-test", incoming, releases, join(scenario, "current"), pin, failure],
      { encoding: "utf8" },
    );
    assert.equal(result.status, failure === "none" ? 0 : 1, result.stderr);
    assert.equal(
      readlinkSync(join(scenario, "current")),
      failure === "none" ? join(releases, "v2-new") : previous,
    );
  }
});

test("root deployment recovery uses its receipt, CAS and a readable previous release", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-deploy-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const incoming = join(root, "incoming");
  const releases = join(root, "releases");
  const previous = join(releases, "previous");
  const target = join(releases, "target");
  for (const path of [incoming, previous, target]) mkdirSync(path, { recursive: true });
  const current = join(root, "current");
  const receipt = join(root, "deployment.json");
  const script: string = [
    "set -eu",
    'die() { echo "$*" >&2; exit 1; }; log() { :; }; verify_release_access() { :; }',
    helper("rollback_failed_deployment"),
    "INCOMING=$1; RELEASES=$2; CURRENT=$3; PIN_DIR=$4; rollback_failed_deployment",
  ].join("\n");
  for (const failure of ["previous", "target", "current", "symlink", "none"]) {
    writeFileSync(receipt, JSON.stringify({ previous, target }));
    const request = join(incoming, "rollback-deployment.json");
    rmSync(request, { force: true });
    const bytes = JSON.stringify({
      previous: failure === "previous" ? root : previous,
      target: failure === "target" ? previous : target,
    });
    if (failure === "symlink") {
      writeFileSync(join(root, "request-source"), bytes);
      symlinkSync(join(root, "request-source"), request);
    } else writeFileSync(request, bytes);
    rmSync(current, { force: true });
    const before = failure === "current" ? previous : target;
    symlinkSync(before, current);
    const result = spawnSync(
      "bash",
      ["-c", script, "recovery-test", incoming, releases, current, root],
      { encoding: "utf8" },
    );
    assert.equal(result.status, failure === "none" ? 0 : 1, result.stderr);
    assert.equal(readlinkSync(current), failure === "none" ? previous : before);
  }
});

test("runtime access gate checks Admin, Web, Worker and dependency readability as the service user", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-access-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = () =>
    spawnSync(
      "bash",
      [
        "-c",
        [
          "set -eu",
          'runuser() { [ "$1" = -u ] && [ "$2" = progressive-cms ] && [ "$3" = -- ]; shift 3; "$@"; }; die() { exit 1; }',
          helper("verify_release_access"),
          'SERVICE_USER=progressive-cms; verify_release_access "$1"',
        ].join("\n"),
        "access-test",
        root,
      ],
      { encoding: "utf8" },
    );
  assert.equal(run().status, 1);
  for (const file of [
    "build-metadata.json",
    "apps/web/src/main.js",
    "apps/worker/src/main.js",
    "apps/admin/dist/index.html",
  ]) {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "runtime");
  }
  assert.equal(run().status, 0);
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules/private.js"), "code", { mode: 0o000 });
  assert.equal(run().status, 1);
});
