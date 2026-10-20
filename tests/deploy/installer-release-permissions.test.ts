import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import yazl from "yazl";

const installerPath = resolve("deploy/scripts/install-release.sh");
const installer = readFileSync(installerPath, "utf8");
const normalizeReleasePermissions = installer.match(
  /^normalize_release_permissions\(\) \{[\s\S]*?^\}/m,
)?.[0];

assert.ok(normalizeReleasePermissions, "installer permission normalizer is present");

async function archiveWithoutDirectoryEntries(): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const complete = once(zip.outputStream, "end");
  zip.addBuffer(Buffer.from("web"), "release/apps/web/src/main.js", { mode: 0o100644 });
  zip.addBuffer(Buffer.from("worker"), "release/apps/worker/src/main.js", { mode: 0o100644 });
  zip.addBuffer(Buffer.from("#!/bin/sh\n"), "release/deploy/scripts/install-release.sh", {
    mode: 0o100755,
  });
  zip.addBuffer(Buffer.from("[Service]\n"), "release/deploy/systemd/web.service", {
    mode: 0o100644,
  });
  zip.end();
  await complete;
  return Buffer.concat(chunks);
}

test("release install permissions are umask-independent and keep private paths closed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-installer-permissions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const zipPath = join(root, "release.zip");
  writeFileSync(zipPath, await archiveWithoutDirectoryEntries());

  assert.match(
    installer,
    /fi\n\s*normalize_release_permissions "\$target_dir"\n\n\s*previous_target=/,
    "normalize both newly extracted and previously installed releases",
  );
  assert.match(installer, /chown root:"\$SERVICE_USER" "\$CONFIG"; chmod 640 "\$CONFIG"/);
  assert.match(
    installer,
    /chown "\$SERVICE_USER":"\$SERVICE_USER" "\$SECRETS\/\$1"; chmod 600 "\$SECRETS\/\$1"/,
  );
  assert.match(installer, /chmod 750 "\$ETC" "\$SECRETS"/);
  assert.match(installer, /umask 077\n\s*printf[\s\S]*?> \/root\/owner-bootstrap\.txt/);
  assert.match(
    installer,
    /chown root:root \/var\/www\/progressive-cms-emergency\n\s*chmod 755 \/var\/www\/progressive-cms-emergency/,
  );
  assert.match(installer, /chown root:"\$SERVICE_USER" "\$PIN_DIR"; chmod 750 "\$PIN_DIR"/);
  for (const unit of ["web", "worker"]) {
    const contents = readFileSync(`deploy/systemd/progressive-cms-${unit}.service`, "utf8");
    assert.match(contents, /^User=progressive-cms$/m);
    assert.match(contents, /^Group=progressive-cms$/m);
    assert.match(contents, /^WorkingDirectory=\/opt\/progressive-cms\/current$/m);
  }

  const runNormalizer = (release: string) =>
    spawnSync(
      "bash",
      [
        "-c",
        [
          'id() { [ "$1" = "-u" ] && { printf 0; return 0; }; command id "$@"; }',
          'chown() { [ "$#" -eq 4 ] && [ "$1" = "-R" ] && [ "$2" = "root:progressive-cms" ] && [ "$3" = "--" ]; }',
          'set -e; SERVICE_USER=progressive-cms; eval "$1"; normalize_release_permissions "$2"',
        ].join("\n"),
        "test",
        normalizeReleasePermissions,
        release,
      ],
      { encoding: "utf8" },
    );

  for (const mask of ["022", "077"]) {
    const stage = join(root, `stage-${mask}`);
    mkdirSync(stage);
    const extract = spawnSync(
      "bash",
      ["-c", 'umask "$1"; exec unzip -q "$2" -d "$3"', "test", mask, zipPath, stage],
      { encoding: "utf8" },
    );
    assert.equal(extract.status, 0, extract.stderr);
    const release = join(stage, "release");
    assert.equal(
      statSync(join(release, "apps")).mode & 0o777,
      mask === "022" ? 0o755 : 0o700,
      `unzip should expose the umask-dependent directory mode for ${mask}`,
    );
    assert.equal(
      spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
        .stdout.split("\n")
        .some((entry) => entry.endsWith("/")),
      false,
      "fixture must omit explicit directory entries",
    );

    const normalize = runNormalizer(release);
    assert.equal(normalize.status, 0, normalize.stderr);

    const paths = [
      join(release, "apps"),
      join(release, "apps/web/src"),
      join(release, "apps/worker/src"),
      join(release, "deploy/scripts"),
      join(release, "deploy/systemd"),
      join(release, "apps/web/src/main.js"),
      join(release, "apps/worker/src/main.js"),
      join(release, "deploy/scripts/install-release.sh"),
      join(release, "deploy/systemd/web.service"),
    ];
    const expected = [0o750, 0o750, 0o750, 0o750, 0o750, 0o640, 0o640, 0o750, 0o640];
    for (const [index, path] of paths.entries()) {
      assert.equal(statSync(path).mode & 0o777, expected[index], path);
      assert.equal(statSync(path).mode & 0o007, 0, `${path} must not be accessible to others`);
    }

    const repeat = runNormalizer(release);
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.deepEqual(
      paths.map((path) => statSync(path).mode & 0o777),
      expected,
      "re-running normalization must preserve the same permissions",
    );
  }
});
