// Public documentation inclusion (CORE-RC19, simplified delivery).
//
// The owner's decision replaced the separate docs-bundle pipeline: the accepted
// public documentation is an ordinary Markdown folder, maintained and approved
// by Core-docs (the `progressive-cms-public-docs` repository) and handed to the
// release builder as a path. This module performs the MECHANICAL inclusion of
// that already-approved folder into the release tree — it does not choose,
// filter, adapt or author documentation.
//
// What is mechanical here:
//   * the source directory must exist and contain `index.md` at its root;
//   * every file must resolve INSIDE the source directory (no symlink escape,
//     no `..` traversal);
//   * a small extension allowlist keeps binaries and build junk out;
//   * nothing private (VCS metadata, dependency trees, caches, editor and OS
//     droppings) is copied;
//   * the copy is a byte-for-byte file copy — no rewriting, no manifest, no
//     hash pins, no separate version.
//
// Content correctness (accuracy, publicness, secrets, customer data) is
// Core-docs' review, performed before the handoff. Release integrity comes from
// the ordinary Progressive CMS ZIP checksum, not from a docs-specific pin.
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** Extensions the accepted folder may contain (text and small assets). */
const ALLOWED_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".liquid",
  ".css",
  ".js",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".avif",
  ".yml",
  ".yaml",
]);

/** Path segments that must never be copied, wherever they appear. */
const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  ".github",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  "dist",
  "build",
  ".DS_Store",
]);

/** Files that are tooling or drift magnets rather than documentation. */
function isForbiddenFile(name) {
  if (FORBIDDEN_SEGMENTS.has(name)) return true;
  if (name.startsWith(".")) return true;
  return /\.(?:pyc|pyo|log|tmp|swp|bak|orig|rej)$/i.test(name);
}

/**
 * Walks the accepted folder and returns the files to ship, as paths relative to
 * it. Throws on anything that would make the copy ambiguous or unsafe.
 */
export function collectDocsFiles(sourceDir) {
  const root = resolve(sourceDir);
  const rootReal = realpathSync(root);
  const files = [];

  const walk = (absoluteDir, relativeDir) => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const absolute = join(absoluteDir, entry.name);
      const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;

      if (isForbiddenFile(entry.name)) continue;

      // A symlink is followed only when it resolves inside the accepted folder:
      // a link pointing outside would smuggle in a file the reviewer never saw.
      if (entry.isSymbolicLink()) {
        const target = realpathSync(absolute);
        if (target !== rootReal && !target.startsWith(`${rootReal}${sep}`)) {
          throw new Error(
            `docs folder: ${relativePath} resolves outside the accepted folder (${target})`,
          );
        }
        const targetStat = lstatSync(target);
        if (targetStat.isDirectory()) walk(target, relativePath);
        else files.push(relativePath);
        continue;
      }

      if (entry.isDirectory()) {
        walk(absolute, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const dot = entry.name.lastIndexOf(".");
      const extension = dot === -1 ? "" : entry.name.slice(dot).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        throw new Error(
          `docs folder: ${relativePath} has an unsupported extension "${extension || "(none)"}"`,
        );
      }
      files.push(relativePath);
    }
  };

  walk(root, "");
  return files;
}

/**
 * Stages the accepted documentation folder under `destinationRoot`, returning a
 * summary for the build log. Pure file copy: the caller gets byte-identical
 * files and nothing else.
 */
export function stageDocsDirectory(sourceDir, destinationRoot) {
  const root = resolve(sourceDir);
  if (!lstatSync(root).isDirectory()) {
    throw new Error(`docs path is not a directory: ${root}`);
  }
  const indexPath = join(root, "index.md");
  if (!lstatSync(indexPath).isFile()) {
    throw new Error(`docs folder has no index.md at its root: ${root}`);
  }

  const files = collectDocsFiles(root);
  if (files.length === 0) throw new Error(`docs folder is empty: ${root}`);

  mkdirSync(destinationRoot, { recursive: true });
  let bytes = 0;
  for (const relativePath of files) {
    const from = join(root, relativePath);
    const to = join(destinationRoot, relativePath);
    mkdirSync(join(to, ".."), { recursive: true });
    cpSync(from, to);
    bytes += readFileSync(to).length;
  }
  // A content digest of the copied tree: recorded for traceability in the
  // release manifest record. It is NOT a gate and NOT an input pin — the
  // release artifact's own checksum remains the integrity mechanism.
  const digest = createHash("sha256");
  for (const relativePath of files) {
    digest.update(relativePath);
    digest.update(readFileSync(join(root, relativePath)));
  }
  return { files, bytes, contentHash: digest.digest("hex") };
}

/** Where the accepted folder is mounted inside the release tree. */
export const DOCS_RELEASE_DIR = "docs";

/** Relative-to-destination path helper (exported for tests and reporting). */
export function docsRelativePath(sourceDir, absolutePath) {
  return relative(resolve(sourceDir), absolutePath).split(sep).join("/");
}
