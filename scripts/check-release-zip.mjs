import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkReleaseZipEntries,
  findInternalReleaseReferences,
  OFFICIAL_DOCS_SKILL_FILES,
  PUBLIC_LICENSE_FILES,
  readReleaseZipEntries,
} from "./release-content-policy.mjs";

const officialFiles = new Set(OFFICIAL_DOCS_SKILL_FILES);
const officialIds = new Set(OFFICIAL_DOCS_SKILL_FILES.map((path) => path.split("/")[1]));

/** Mechanical inventory of accepted prepared resources, never content rewriting. */
export function readPreparedOfficialSkillFiles(docsDir) {
  if (!docsDir) throw new Error("prepared Docs directory is required for the official Skills gate");
  if (!lstatSync(docsDir).isDirectory() || !lstatSync(join(docsDir, "skills")).isDirectory())
    throw new Error("prepared Docs and skills must be regular directories");
  const files = new Map();
  const walk = (path) => {
    const absolute = join(docsDir, path);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink())
      throw new Error(`${path}: symlinks are not official Skill resources`);
    if (stat.isDirectory()) {
      if (!OFFICIAL_DOCS_SKILL_FILES.some((file) => file.startsWith(`${path}/`)))
        throw new Error(`${path}: unexpected official Skill directory`);
      for (const name of readdirSync(absolute)) walk(`${path}/${name}`);
    } else {
      if (!stat.isFile() || !officialFiles.has(path))
        throw new Error(`${path}: unexpected official Skill resource`);
      files.set(path, readFileSync(absolute));
    }
  };
  for (const id of officialIds) walk(`skills/${id}`);
  for (const path of OFFICIAL_DOCS_SKILL_FILES) {
    if (!files.has(path)) throw new Error(`${path}: required prepared resource is missing`);
  }
  return files;
}

function checkOfficialSkills(zipPath, releaseId, entries, docsDir) {
  let expected;
  try {
    expected = readPreparedOfficialSkillFiles(docsDir);
  } catch (error) {
    return [`official Skills: ${error.message}`];
  }
  const failures = [];
  const counts = new Map();
  const prefix = `${releaseId}/`;
  for (const name of entries) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (!name.startsWith(prefix)) continue;
    const path = name.slice(prefix.length).replace(/^docs\//, "");
    if (
      path.startsWith("skills/") &&
      officialIds.has(path.split("/")[1]) &&
      !officialFiles.has(path)
    )
      failures.push(`${name}: unexpected official Skill resource`);
  }
  for (const [path, bytes] of expected) {
    for (const copy of [path, `docs/${path}`]) {
      const entry = `${prefix}${copy}`;
      if (counts.get(entry) !== 1) {
        failures.push(`${copy}: required official Skill resource must appear exactly once`);
        continue;
      }
      const actual = spawnSync("unzip", ["-p", zipPath, entry], { maxBuffer: 4 * 1024 * 1024 });
      if (actual.status !== 0 || !bytes.equals(actual.stdout))
        failures.push(`${copy}: official Skill bytes differ from accepted prepared Docs`);
    }
  }
  return failures;
}

export function checkReleaseZip(zipPath, releaseId, context) {
  const entries = readReleaseZipEntries(zipPath);
  const failures = checkReleaseZipEntries(entries, releaseId, context);
  failures.push(...checkOfficialSkills(zipPath, releaseId, entries, context.preparedDocsDir));
  const prefix = `${releaseId}/`;
  for (const path of PUBLIC_LICENSE_FILES) {
    if (entries.filter((entry) => entry === `${prefix}${path}`).length !== 1)
      failures.push(`${path}: required public license/notice must appear exactly once`);
  }
  const publicTextEntries = entries.filter(
    (entry) =>
      entry.startsWith(prefix) &&
      /^(?:deploy|config|skills|extensions)\//.test(entry.slice(prefix.length)) &&
      !entry.split("/").includes("node_modules") &&
      (/\.(?:md|txt|json|sql|sh|service|path|conf|example|rules|html)$/i.test(entry) ||
        (entry.startsWith(`${prefix}skills/`) && /\.(?:yaml|yml|js|css|liquid)$/i.test(entry))),
  );
  for (const entry of publicTextEntries) {
    const content = spawnSync("unzip", ["-p", zipPath, entry], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (content.status !== 0) {
      failures.push(`${entry.slice(prefix.length)}: cannot read release text asset`);
      continue;
    }
    for (const issue of findInternalReleaseReferences(content.stdout)) {
      failures.push(`${entry.slice(prefix.length)}: ${issue}`);
    }
  }
  const lock = spawnSync("unzip", ["-p", zipPath, `${releaseId}/package-lock.json`], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (lock.status !== 0) {
    failures.push("package-lock.json: missing from ZIP or unreadable");
    return failures;
  }
  try {
    const lockfile = JSON.parse(lock.stdout);
    if (Object.keys(lockfile.packages?.[""].devDependencies ?? {}).length > 0) {
      failures.push("package-lock.json: developer dependencies remain in the public lockfile");
    }
    for (const [path, dependency] of Object.entries(lockfile.packages ?? {})) {
      if (dependency.dev === true || dependency.devOptional === true) {
        failures.push(`${path}: dev-only dependency remains in the public lockfile`);
      }
    }
  } catch {
    failures.push("package-lock.json: invalid JSON");
  }
  const contentTypes = spawnSync(
    "unzip",
    ["-p", zipPath, `${releaseId}/fixtures/content/reference-content-types.json`],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (contentTypes.status !== 0) {
    failures.push("fixtures/content/reference-content-types.json: missing from ZIP or unreadable");
  } else {
    try {
      const corpus = JSON.parse(contentTypes.stdout);
      if (
        !Array.isArray(corpus.contentTypes) ||
        !Array.isArray(corpus.fixtures) ||
        corpus.fixtures.length > 0
      ) {
        failures.push(
          "fixtures/content/reference-content-types.json: invalid runtime-only schema corpus",
        );
      }
    } catch {
      failures.push("fixtures/content/reference-content-types.json: invalid JSON");
    }
  }
  return failures;
}

export function assertReleaseZipClean(zipPath, releaseId, context) {
  const failures = checkReleaseZip(zipPath, releaseId, context);
  if (failures.length > 0) {
    const shown = failures
      .slice(0, 40)
      .map((failure) => `  - ${failure}`)
      .join("\n");
    const remainder = failures.length > 40 ? `\n  ... and ${failures.length - 40} more` : "";
    throw new Error(
      `release ZIP failed content allowlist (${failures.length} issue(s)):\n${shown}${remainder}`,
    );
  }
  return readReleaseZipEntries(zipPath).length;
}
