import { spawnSync } from "node:child_process";

export const PUBLIC_LICENSE_FILES = Object.freeze([
  "LICENSE",
  "NOTICE",
  "TRADEMARKS.md",
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_NATIVE_NOTICES.txt",
  "THIRD_PARTY_NATIVE_SOURCES.json",
]);

const ROOT_FILES = new Set([
  ...PUBLIC_LICENSE_FILES,
  "build-metadata.json",
  "package-lock.json",
  "package.json",
  "release-manifest.json",
  "update-manifest.json",
]);

// Approved standalone Skills: exact resources, not a recursive extension allowlist.
export const OFFICIAL_DOCS_SKILL_FILES = Object.freeze([
  "skills/progressive-cms-site-builder/SKILL.md",
  "skills/progressive-cms-site-builder/agents/openai.yaml",
  "skills/progressive-cms-site-builder/assets/NOTICE.txt",
  "skills/progressive-cms-site-builder/assets/examples/block-document-empty.json",
  "skills/progressive-cms-site-builder/assets/examples/block-document-v1.json",
  "skills/progressive-cms-site-builder/assets/examples/contact-form.json",
  "skills/progressive-cms-site-builder/assets/examples/content-types.json",
  "skills/progressive-cms-site-builder/assets/examples/create-news.json",
  "skills/progressive-cms-site-builder/assets/examples/create-page.json",
  "skills/progressive-cms-site-builder/assets/examples/patch-news.json",
  "skills/progressive-cms-site-builder/assets/examples/richtext-v2-table.json",
  "skills/progressive-cms-site-builder/assets/theme-starter/README.md",
  "skills/progressive-cms-site-builder/assets/theme-starter/assets/forms.js",
  "skills/progressive-cms-site-builder/assets/theme-starter/assets/theme.css",
  "skills/progressive-cms-site-builder/assets/theme-starter/blocks/form.liquid",
  "skills/progressive-cms-site-builder/assets/theme-starter/blocks/heading.liquid",
  "skills/progressive-cms-site-builder/assets/theme-starter/blocks/text.liquid",
  "skills/progressive-cms-site-builder/assets/theme-starter/components/breadcrumbs.liquid",
  "skills/progressive-cms-site-builder/assets/theme-starter/components/feeds.liquid",
  "skills/progressive-cms-site-builder/assets/theme-starter/components/footer.liquid",
  "skills/progressive-cms-site-builder/assets/theme-starter/components/header.liquid",
  "skills/progressive-cms-site-builder/assets/theme-starter/fixtures/example.json",
  "skills/progressive-cms-site-builder/assets/theme-starter/templates/article.liquid",
  "skills/progressive-cms-site-builder/assets/theme-starter/templates/page.liquid",
  "skills/progressive-cms-site-builder/assets/theme-starter/theme.json",
  "skills/progressive-cms-site-builder/assets/theme-starter/tokens/base.json",
  "skills/progressive-cms-site-builder/manifest.json",
  "skills/progressive-cms-site-builder/references/api-operations.json",
  "skills/progressive-cms-site-builder/references/checks.md",
  "skills/progressive-cms-site-builder/references/content-and-theme.md",
  "skills/progressive-cms-site-builder/references/release.md",
  "skills/progressive-cms-site-builder/references/workflow.md",
  "skills/progressive-cms-152fz/SKILL.md",
  "skills/progressive-cms-152fz/agents/openai.yaml",
  "skills/progressive-cms-152fz/assets/acceptance.md",
  "skills/progressive-cms-152fz/manifest.json",
  "skills/progressive-cms-152fz/references/api-operations.json",
  "skills/progressive-cms-152fz/references/pcms-workflow.md",
  "skills/progressive-cms-152fz/references/personal-data-tools.md",
  "skills/progressive-cms-152fz/references/sources.md",
  "skills/progressive-cms-152fz/references/technical-controls.md",
  "skills/progressive-cms-seo/SKILL.md",
  "skills/progressive-cms-seo/agents/openai.yaml",
  "skills/progressive-cms-seo/assets/acceptance.md",
  "skills/progressive-cms-seo/manifest.json",
  "skills/progressive-cms-seo/references/api-operations.json",
  "skills/progressive-cms-seo/references/audit.md",
  "skills/progressive-cms-seo/references/pcms-workflow.md",
  "skills/progressive-cms-seo/references/sources.md",
]);
const officialSkillFiles = new Set(OFFICIAL_DOCS_SKILL_FILES);
const officialSkillIds = new Set(OFFICIAL_DOCS_SKILL_FILES.map((path) => path.split("/")[1]));

const PUBLIC_SKILLS = new Set([
  ...officialSkillIds,
  "progressive-cms-content-agent",
  "progressive-cms-extension-developer",
  "progressive-cms-operator",
  "progressive-cms-theme-developer",
  "progressive-cms-web-research",
]);

const TEST_DIRECTORIES = new Set([
  "test",
  "tests",
  "testing",
  "__tests__",
  "__snapshots__",
  "snapshots",
  "__mocks__",
  "spec",
  "specs",
]);

const TEST_RUNNER_PACKAGES = new Set([
  "@playwright/test",
  "@testing-library/dom",
  "@testing-library/react",
  "ava",
  "cypress",
  "jest",
  "mocha",
  "playwright",
  "tap",
  "vitest",
]);

function isTestRunnerPackage(name) {
  return (
    TEST_RUNNER_PACKAGES.has(name) ||
    name.startsWith("@jest/") ||
    name.startsWith("@vitest/") ||
    name.startsWith("@testing-library/")
  );
}

function isAllowedSkillPath(path) {
  const parts = path.split("/");
  if (parts[0] !== "skills") return false;
  if (parts[1] === "references") {
    return parts.length === 3 && ["INDEX.md", "common-operating-rules.md"].includes(parts[2]);
  }
  if (parts[1] === "schemas") return parts.length === 3 && parts[2].endsWith(".json");
  if (!PUBLIC_SKILLS.has(parts[1])) return false;
  if (officialSkillIds.has(parts[1])) return officialSkillFiles.has(path);
  if (parts.length === 3) {
    return ["SKILL.md", "manifest.json", "bootstrap-prompt.txt"].includes(parts[2]);
  }
  return parts.length === 4 && parts[2] === "references" && parts[3].endsWith(".md");
}

export function isAllowedReleasePath(path, context) {
  if (path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".."))
    return false;
  if (ROOT_FILES.has(path)) return true;
  if (path === "extensions/catalog.js") return true;
  if (path === "config/pcms.example.json") return true;
  if (path === "fixtures/content/reference-content-types.json") return true;
  if (isAllowedSkillPath(path)) return true;

  const parts = path.split("/");
  if (parts[0] === "apps") {
    return (
      (parts[1] === "admin" && parts[2] === "dist") || parts[1] === "web" || parts[1] === "worker"
    );
  }
  if (parts[0] === "packages") return context.packageNames.has(parts[1]);
  if (
    parts[0] === "extensions" &&
    context.extensionDirs.has(parts[1]) &&
    parts[2] === "node_modules"
  )
    return true;
  if (parts[0] === "extensions" && context.extensionDirs.has(parts[1])) {
    const rest = parts.slice(2);
    if (rest.length === 1 && ["LICENSE", "NOTICE"].includes(rest[0])) return true;
    if (rest[0] === "manifest.json") return rest.length === 1;
    if (rest[0] === "src") return rest.length > 1;
    if (rest[0] === "migrations") return rest.length === 2 && rest[1].endsWith(".sql");
    if (rest[0] === "agent") return rest.length > 1 && /\.(?:md|php|txt|json)$/.test(rest.at(-1));
    return false;
  }
  if (parts[0] === "db")
    return parts[1] === "migrations" && parts.length === 3 && parts[2].endsWith(".sql");
  if (parts[0] === "themes" && context.themeDirs.has(parts[1])) {
    const rest = parts.slice(2);
    if (rest.length === 1 && rest[0] === "theme.json") return true;
    if (rest[0] === "fixtures") return rest.length === 2 && rest[1] === "README.md";
    return ["assets", "blocks", "components", "templates", "tokens"].includes(rest[0]);
  }
  if (parts[0] === "deploy") {
    return (
      (parts[1] === "scripts" &&
        [
          "backup-site.sh",
          "install-release.sh",
          "install-restart-bridge.sh",
          "restore-site.sh",
        ].includes(parts[2])) ||
      (parts[1] === "systemd" && parts.length === 3 && /\.(?:service|path)$/.test(parts[2])) ||
      (parts[1] === "nginx" && parts.length === 3 && parts[2].endsWith(".conf")) ||
      (parts[1] === "nginx" && parts.length === 3 && parts[2].endsWith(".conf.example")) ||
      (parts[1] === "polkit" && parts.length === 3 && parts[2].endsWith(".rules")) ||
      (parts[1] === "sites" &&
        parts.length === 3 &&
        parts[2] === "pcms.production.template.json") ||
      (parts[1] === "maintenance" && parts.length === 3 && parts[2] === "emergency.html")
    );
  }
  if (parts[0] === "node_modules") return true;
  if (parts[0] === "extensions" && parts[2] === "node_modules") return true;
  // CORE-RC19 (simplified delivery): the accepted public documentation folder is
  // shipped as ordinary documentation at `docs/`. Core-docs owns its content and
  // resolves it before handoff; the builder copies it mechanically. Ordinary
  // documentation uses the release ZIP checksum; official standalone Skills also
  // require the prepared-source byte gate. No separate docs manifest or version.
  // `scripts/stage-docs-dir.mjs` is what keeps the
  // copy mechanical (index.md present, no traversal, no private or binary files).
  //
  // Every other root is constrained by its SECOND segment (`packages/<name>`,
  // `themes/<name>`), so a `..` cannot slip through them. This branch is a bare
  // prefix, so it rejects traversal segments itself rather than relying on the
  // archive-level check to run first. Official standalone Skill copies also have
  // an exact inventory and byte comparison against prepared Docs in the ZIP gate.
  if (parts[0] === "docs") {
    if (parts.some((part) => part === ".." || part === ".")) return false;
    return context.docsIncluded === true;
  }
  return false;
}

function dependencyName(parts) {
  const index = parts.lastIndexOf("node_modules");
  if (index < 0) return null;
  const first = parts[index + 1];
  if (first === undefined || first === ".bin") return null;
  return first.startsWith("@") ? `${first}/${parts[index + 2] ?? ""}` : first;
}

function testPathViolation(path) {
  const parts = path.split("/");
  const modulesIndex = parts.lastIndexOf("node_modules");
  const packageEnd =
    modulesIndex >= 0 && parts[modulesIndex + 1]?.startsWith("@")
      ? modulesIndex + 3
      : modulesIndex + 2;
  const payloadParts = modulesIndex >= 0 ? parts.slice(packageEnd) : parts;
  const allowedFixturePaths =
    // Public authoring/render input for the standalone theme starter, not QA data.
    path === "skills/progressive-cms-site-builder/assets/theme-starter/fixtures/example.json" ||
    path === "fixtures/content/reference-content-types.json" ||
    /^themes\/[^/]+\/fixtures\/README\.md$/.test(path);
  if (!allowedFixturePaths && payloadParts.includes("fixtures")) return "fixture payload";
  const testDirectory = payloadParts.find((part) => TEST_DIRECTORIES.has(part));
  if (testDirectory) return `test directory "${testDirectory}"`;
  if (payloadParts.includes("__fixtures__")) return "test fixture directory";
  if (payloadParts.includes("__mocks__")) return "mock directory";
  const file = parts.at(-1) ?? "";
  if (/\.(?:test|spec)\..+$/i.test(file)) return "test/spec file";
  if (/\.(?:snap|snapshot)(?:\.[^.]+)?$/i.test(file)) return "test snapshot file";
  if (/^(?:playwright|vitest|jest|mocha|cypress)\.config\./i.test(file))
    return "test runner config";
  const pkg = dependencyName(parts);
  if (pkg && isTestRunnerPackage(pkg)) return `test runner dependency "${pkg}"`;
  return null;
}

export function checkReleaseZipEntries(entries, releaseId, context) {
  const failures = [];
  const prefix = `${releaseId}/`;
  for (const raw of entries) {
    if (raw === prefix) continue;
    const name = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (
      !name ||
      name.includes("\\") ||
      name.split("/").some((part) => part === ".." || part === ".")
    ) {
      failures.push(`${raw}: unsafe archive path`);
      continue;
    }
    if (!name.startsWith(prefix)) {
      failures.push(`${raw}: entry is outside the ${releaseId}/ root`);
      continue;
    }
    const path = name.slice(prefix.length);
    const allowedParent =
      raw.endsWith("/") &&
      entries.some(
        (entry) =>
          !entry.endsWith("/") &&
          entry.startsWith(raw) &&
          isAllowedReleasePath(entry.slice(prefix.length), context),
      );
    if (!allowedParent && !isAllowedReleasePath(path, context))
      failures.push(`${path}: outside release component allowlist`);
    if (allowedParent) continue; // Children are checked individually, including official authoring fixtures.
    // The docs subtree has its own content-integrity gate (the bundle verifier)
    // and is documentation by construction — the test-payload heuristic must
    // not reject a legitimate `source/specs/…` page.
    if (!path.startsWith("docs/")) {
      const testIssue = testPathViolation(path);
      if (testIssue) failures.push(`${path}: ${testIssue}`);
    }
  }
  if (entries.length === 0) failures.push("archive has no entries");
  return failures;
}

export function readReleaseZipEntries(zipPath) {
  const result = spawnSync("unzip", ["-Z1", zipPath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`cannot list release ZIP with unzip -Z1: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

export function findInternalReleaseReferences(content) {
  const markers = [
    [
      "private address",
      /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3})\b/,
    ],
    ["private Incus target", /\bwork2:[A-Za-z0-9._-]+/i],
    ["internal task reference", /\bPCMS-OPS-T\d+\b/i],
    ["internal architecture reference", /\b(?:M16-RECONCILE-RP|ADR-\d{4})\b/i],
    ["internal runbook/spec reference", /\b(?:RUNBOOK\s+§|Operations spec\s+§)/i],
    [
      "private site reference",
      /\b(?:p-cms\.com|spangar(?:\.x8z\.ru)?|wb-st\.ru|152fz\.p-os\.ru)\b/i,
    ],
    ["excluded deployment manual reference", /\bdeploy\/docs\/(?:INSTALL|UPDATE)\.md\b/i],
    ["excluded operator manual reference", /\b(?:INSTALL-HUMAN|BACKUP_RESTORE)\.md\b/i],
  ];
  return markers.filter(([, pattern]) => pattern.test(content)).map(([label]) => label);
}

export const releaseTestDirectoryNames = TEST_DIRECTORIES;
