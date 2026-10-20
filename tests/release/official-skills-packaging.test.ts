import assert from "node:assert/strict";
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import {
  checkReleaseZip,
  readPreparedOfficialSkillFiles,
} from "../../scripts/check-release-zip.mjs";
import {
  checkReleaseZipEntries,
  isAllowedReleasePath,
  OFFICIAL_DOCS_SKILL_FILES,
  PUBLIC_LICENSE_FILES,
} from "../../scripts/release-content-policy.mjs";

const { ZipFile } = createRequire(import.meta.url)("yazl");
const releaseId = "packaging-policy-test";
const context = {
  packageNames: new Set<string>(),
  extensionDirs: new Set<string>(),
  themeDirs: new Set<string>(),
  docsIncluded: true,
};
const paths = OFFICIAL_DOCS_SKILL_FILES;

test("official resource classification admits exactly 32/9/8 resources and only the declared starter fixture", () => {
  assert.equal(paths.length, 49);
  for (const [id, count] of [
    ["progressive-cms-site-builder", 32],
    ["progressive-cms-152fz", 9],
    ["progressive-cms-seo", 8],
  ] as const)
    assert.equal(paths.filter((path) => path.startsWith(`skills/${id}/`)).length, count);
  assert.deepEqual(
    checkReleaseZipEntries(
      paths.map((path) => `${releaseId}/${path}`),
      releaseId,
      context,
    ),
    [],
  );
  for (const path of [
    "skills/progressive-cms-site-builder/assets/theme-starter/fixtures/private.json",
    "skills/progressive-cms-site-builder/assets/examples/arbitrary.json",
    "skills/progressive-cms-site-builder/references/internal.md",
    "skills/progressive-cms-152fz/assets/fixture.json",
    "skills/progressive-cms-seo/scripts/private.js",
    "skills/progressive-cms-seo/references/../../private.md",
    "skills/progressive-cms-seo//SKILL.md",
    "skills\\progressive-cms-site-builder\\SKILL.md",
    "skills/progressive-cms-site-builder/assets/theme-starter/tests/example.json",
    "themes/reference-theme-v1/fixtures/example.json",
  ]) {
    assert.equal(isAllowedReleasePath(path, context), false, path);
    assert.ok(checkReleaseZipEntries([`${releaseId}/${path}`], releaseId, context).length, path);
  }
});

function fixture(t: { after(work: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "pcms-official-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prepared = join(root, "accepted-docs");
  const content = new Map(
    paths.map((path) => [path, Buffer.from(`${path}\r\nSynthetic public resource π\n`)]),
  );
  for (const [path, bytes] of content) {
    mkdirSync(dirname(join(prepared, path)), { recursive: true });
    writeFileSync(join(prepared, path), bytes);
  }
  const entries = new Map<string, Buffer>([
    ...PUBLIC_LICENSE_FILES.map((path): [string, Buffer] => [path, readFileSync(path)]),
    ["package-lock.json", Buffer.from('{"packages":{"":{}}}')],
    [
      "fixtures/content/reference-content-types.json",
      Buffer.from('{"contentTypes":[],"fixtures":[]}'),
    ],
    ["docs/index.md", Buffer.from("# Public docs\n")],
  ]);
  for (const [path, bytes] of content) {
    entries.set(path, bytes);
    entries.set(`docs/${path}`, bytes);
  }
  let number = 0;
  const pack = async (extra?: { duplicate?: string }) => {
    const file = join(root, `policy-${++number}.zip`);
    const zip = new ZipFile();
    for (const [path, bytes] of entries) zip.addBuffer(bytes, `${releaseId}/${path}`);
    if (extra?.duplicate)
      zip.addBuffer(entries.get(extra.duplicate), `${releaseId}/${extra.duplicate}`);
    const writing = pipeline(zip.outputStream, createWriteStream(file));
    zip.end();
    await writing;
    return file;
  };
  return { prepared, entries, pack, ctx: { ...context, preparedDocsDir: prepared } };
}

test("artifact gate requires all 49 native resources and both copies match accepted prepared bytes", async (t) => {
  const f = fixture(t);
  assert.equal(readPreparedOfficialSkillFiles(f.prepared).size, 49);
  assert.deepEqual(checkReleaseZip(await f.pack(), releaseId, f.ctx), []);
  for (const path of paths) f.entries.delete(path);
  const failures = checkReleaseZip(await f.pack(), releaseId, f.ctx);
  assert.equal(failures.length, 49, "omitting entire Skill directories cannot pass");
  for (const path of paths)
    assert.ok(
      failures.some((issue) => issue.startsWith(`${path}:`)),
      path,
    );
});

test("ZIP gate rejects missing docs copy and equal-but-stale root/docs copies", async (t) => {
  const f = fixture(t);
  const path = paths[0];
  assert.ok(path);
  f.entries.delete(`docs/${path}`);
  assert.match(
    checkReleaseZip(await f.pack(), releaseId, f.ctx).join("\n"),
    /must appear exactly once/,
  );
  f.entries.set(path, Buffer.from("old bytes\n"));
  f.entries.set(`docs/${path}`, Buffer.from("old bytes\n"));
  const failures = checkReleaseZip(await f.pack(), releaseId, f.ctx);
  assert.equal(failures.filter((issue) => issue.includes("bytes differ")).length, 2);
});

test("ZIP gate requires first-party license and redistribution notices", async (t) => {
  const f = fixture(t);
  for (const path of PUBLIC_LICENSE_FILES) f.entries.delete(path);
  const failures = checkReleaseZip(await f.pack(), releaseId, f.ctx);
  assert.equal(failures.length, PUBLIC_LICENSE_FILES.length);
  assert.ok(failures.every((issue) => issue.includes("required public license/notice")));
});

test("ZIP gate is mandatory and rejects duplicate, extra docs resources and internal content", async (t) => {
  const f = fixture(t);
  const path = paths[0];
  assert.ok(path);
  const duplicate = checkReleaseZip(await f.pack({ duplicate: path }), releaseId, f.ctx);
  assert.match(duplicate.join("\n"), /must appear exactly once/);
  const absentSource = checkReleaseZip(await f.pack(), releaseId, context);
  assert.match(absentSource.join("\n"), /prepared Docs directory is required/);
  const extra = "docs/skills/progressive-cms-seo/references/internal.md";
  f.entries.set(extra, Buffer.from("private\n"));
  assert.match(
    checkReleaseZip(await f.pack(), releaseId, f.ctx).join("\n"),
    /unexpected official Skill resource/,
  );
  f.entries.delete(extra);
  const css = "skills/progressive-cms-site-builder/assets/theme-starter/assets/theme.css";
  const privateBytes = Buffer.from("/* work2:private 10.0.0.1 */\n");
  writeFileSync(join(f.prepared, css), privateBytes);
  f.entries.set(css, privateBytes);
  f.entries.set(`docs/${css}`, privateBytes);
  assert.match(
    checkReleaseZip(await f.pack(), releaseId, f.ctx).join("\n"),
    /private address|private Incus target/,
  );
});

test("prepared source inventory rejects missing, extra, and symlink resources", (t) => {
  const f = fixture(t);
  const path = paths[0];
  assert.ok(path);
  const absolute = join(f.prepared, path);
  const original = readFileSync(absolute);
  rmSync(absolute);
  assert.throws(
    () => readPreparedOfficialSkillFiles(f.prepared),
    /required prepared resource is missing/,
  );
  writeFileSync(absolute, original);
  const extra = join(f.prepared, "skills/progressive-cms-seo/references/private.md");
  writeFileSync(extra, "private");
  assert.throws(
    () => readPreparedOfficialSkillFiles(f.prepared),
    /unexpected official Skill resource/,
  );
  rmSync(extra);
  rmSync(absolute);
  const target = paths[1];
  assert.ok(target);
  symlinkSync(join(f.prepared, target), absolute);
  assert.throws(() => readPreparedOfficialSkillFiles(f.prepared), /symlinks/);
});
