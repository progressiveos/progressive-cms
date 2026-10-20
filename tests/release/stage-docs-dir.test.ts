// CORE-RC19 (simplified delivery) — mechanical inclusion of the accepted
// public documentation folder.
//
// The owner's decision replaced the docs-bundle pipeline: the approved folder is
// ordinary Markdown, handed to the builder as a path, copied into `docs/` as-is.
// These tests pin the MECHANICAL properties the builder guarantees, because
// content correctness is Core-docs' review, not the builder's:
//
//   * a real directory with `index.md` at its root is required;
//   * the copy is byte-for-byte, includes the subfolders, and lands under docs/;
//   * nothing private or build-related is dragged in, and files are not invented;
//   * a link or path that escapes the accepted folder is refused;
//   * the allowlist admits `docs/` only when a folder was staged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isAllowedReleasePath } from "../../scripts/release-content-policy.mjs";
import {
  collectDocsFiles,
  DOCS_RELEASE_DIR,
  stageDocsDirectory,
} from "../../scripts/stage-docs-dir.mjs";

/** Builds an accepted-looking documentation folder in a temp directory. */
function acceptedFolder(
  t: { after: (fn: () => void) => void },
  files: Readonly<Record<string, string>> = {
    "index.md": "# Docs\n",
    "installation.md": "# Installation\n",
    "source/api.md": "# API\n",
    "skills/catalog.json": '{"skills":[]}',
  },
): string {
  const root = mkdtempSync(join(tmpdir(), "pcms-docs-dir-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

test("an accepted folder is copied byte-for-byte into docs/, index.md included", (t) => {
  const source = acceptedFolder(t);
  const destination = join(source, "..", `${Date.now()}-staged`);
  t.after(() => rmSync(destination, { recursive: true, force: true }));

  const summary = stageDocsDirectory(source, destination);
  assert.deepEqual([...summary.files].sort(), [
    "index.md",
    "installation.md",
    "skills/catalog.json",
    "source/api.md",
  ]);
  // The entry point exists on disk as well as in the summary.
  assert.equal(readFileSync(join(destination, "index.md"), "utf8"), "# Docs\n");
  // Nested content keeps its structure and its bytes.
  assert.equal(readFileSync(join(destination, "source/api.md"), "utf8"), "# API\n");
  assert.equal(readFileSync(join(destination, "skills/catalog.json"), "utf8"), '{"skills":[]}');
  assert.ok(summary.bytes > 0);
  assert.match(summary.contentHash, /^[0-9a-f]{64}$/);
});

test("the copy is deterministic: the same folder yields the same digest", (t) => {
  const source = acceptedFolder(t);
  const dirA = join(source, "..", `a-${Date.now()}`);
  const dirB = join(source, "..", `b-${Date.now()}`);
  t.after(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
  const first = stageDocsDirectory(source, dirA);
  const second = stageDocsDirectory(source, dirB);
  assert.equal(first.contentHash, second.contentHash);
  assert.deepEqual(first.files, second.files);
});

test("a folder without index.md at its root is refused", (t) => {
  // A missing entry point means an agent has nothing to start from.
  const source = acceptedFolder(t, { "introduction.md": "# Intro\n" });
  assert.throws(() => stageDocsDirectory(source, join(source, "..", "out-missing")), /index\.md/);
});

test("a nested index.md does not satisfy the root requirement", (t) => {
  const source = acceptedFolder(t, { "source/index.md": "# Nested\n" });
  assert.throws(() => stageDocsDirectory(source, join(source, "..", "out-nested")), /index\.md/);
});

test("a folder with nothing to ship is refused", (t) => {
  const filtered = mkdtempSync(join(tmpdir(), "pcms-docs-filtered-"));
  t.after(() => rmSync(filtered, { recursive: true, force: true }));
  writeFileSync(join(filtered, "index.md"), "# Docs\n");
  writeFileSync(join(filtered, ".DS_Store"), "junk");
  // Only the real file survives filtering — the droppings do not count as content.
  assert.deepEqual(collectDocsFiles(filtered), ["index.md"]);

  // With no `index.md` and no other allowed file, staging has nothing to do.
  const onlyJunk = mkdtempSync(join(tmpdir(), "pcms-docs-junk-"));
  t.after(() => rmSync(onlyJunk, { recursive: true, force: true }));
  writeFileSync(join(onlyJunk, ".DS_Store"), "junk");
  assert.throws(() => stageDocsDirectory(onlyJunk, join(onlyJunk, "..", "out-junk")), /index\.md/);
});

test("private, dependency and build files are never copied", (t) => {
  const source = acceptedFolder(t, {
    "index.md": "# Docs\n",
    "note.md": "# Note\n",
    ".DS_Store": "junk",
    ".env": "SECRET=1",
    ".git/config": "[core]",
    "node_modules/pkg/index.js": "module.exports = 1",
    "__pycache__/mod.pyc": "bytecode",
    "build/out.md": "# built\n",
  });
  const files = collectDocsFiles(source);
  assert.deepEqual([...files].sort(), ["index.md", "note.md"]);
});

test("an unsupported binary file is refused rather than shipped silently", (t) => {
  // A stray archive or executable in the folder is a signal that the reviewed
  // set and the delivered set differ, so the build must stop instead of
  // quietly dropping it.
  const source = acceptedFolder(t, { "index.md": "# Docs\n", "bundle.zip": "PK\u0003\u0004" });
  assert.throws(() => collectDocsFiles(source), /unsupported extension/);
});

test("a symlink escaping the accepted folder is refused", (t) => {
  const source = acceptedFolder(t);
  const outside = join(source, "..", `outside-${Date.now()}.md`);
  t.after(() => rmSync(outside, { force: true }));
  writeFileSync(outside, "# Not reviewed\n");
  symlinkSync(outside, join(source, "smuggled.md"));
  assert.throws(() => collectDocsFiles(source), /outside the accepted folder/);
});

test("a symlink staying inside the accepted folder is followed", (t) => {
  const source = acceptedFolder(t, { "index.md": "# Docs\n", "real.md": "# Real\n" });
  symlinkSync(join(source, "real.md"), join(source, "alias.md"));
  const files = collectDocsFiles(source);
  assert.ok(files.includes("alias.md"));
  assert.ok(files.includes("real.md"));
});

test("the release allowlist admits docs/ only when a folder was staged", () => {
  const context = {
    packageNames: new Set(["core"]),
    extensionDirs: new Set<string>(),
    themeDirs: new Set<string>(),
  };
  // Without the flag, nothing under docs/ may enter a release.
  assert.equal(isAllowedReleasePath("docs/index.md", context), false);
  assert.equal(
    isAllowedReleasePath("docs/source/api.md", { ...context, docsIncluded: true }),
    true,
  );
  // The flag does not open anything else.
  assert.equal(
    isAllowedReleasePath("docs/../secret.md", { ...context, docsIncluded: true }),
    false,
  );
  assert.equal(isAllowedReleasePath("tools/x.md", { ...context, docsIncluded: true }), false);
  assert.equal(
    isAllowedReleasePath("docs/init-package/AGENTS.md", { ...context, docsIncluded: true }),
    true,
    "the staged folder is copied verbatim, so its own layout is allowed",
  );
});

test("the copy carries no extra files beyond the accepted set", (t) => {
  const source = acceptedFolder(t);
  const destination = join(source, "..", `exact-${Date.now()}`);
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  const summary = stageDocsDirectory(source, destination);
  // Compare the whole staged tree against the summary the build reports.
  const listed = execFileSync("find", [destination, "-type", "f", "-printf", "%P\n"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(listed, [...summary.files].sort());
});

test("the mount point is the plain docs/ directory", () => {
  // No versioned subtree: the folder lands where it was approved to land.
  assert.equal(DOCS_RELEASE_DIR, "docs");
});
