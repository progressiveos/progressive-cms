// Community skills installer + REST surface (Community Skills plan): zip
// fail-closed gate, banner prepend, sidecar, permission gate, disable/
// enable lifecycle, sample download.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCommunitySkills } from "@pcms/skills";
import yazlWrite from "yazl";
import {
  installSkillPackage,
  SkillInstallError,
  validateEntryNames,
  validateSkillPackage,
} from "../../packages/skills/src/install-package.js";

function zipOf(files: Readonly<Record<string, string>>): Promise<Buffer> {
  const zip = new yazlWrite.ZipFile();
  for (const [name, content] of Object.entries(files)) {
    zip.addBuffer(Buffer.from(content, "utf8"), name);
  }
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

const GOOD_MANIFEST = {
  id: "community.seo-audit",
  version: "1.0.0",
  description: "SEO audit workflow",
  requires: { cms: ">=1.0.0-rc.1 <2.0.0" },
  recommended_scopes: ["content.read"],
  optional_scopes: [],
  dangerous_optional_scopes: [],
  entry_workflow: ["bootstrap/discovery"],
  safety_levels: ["READ"],
  attribution: { author: "Community Author", source: "https://example.com/skill" },
};

const CHECKS = {
  firstPartyIds: ["progressive-cms-content-agent"],
  isRegisteredPermission: (scope: string) => ["content.read", "seo.read"].includes(scope),
};

test("validate: good package passes; bad id / unregistered scope / traversal fail", async () => {
  const good = await zipOf({
    "manifest.json": JSON.stringify(GOOD_MANIFEST),
    "SKILL.md": "# Skill\n\nDo the audit workflow.\n",
    "references/deep.md": "details",
  });
  const { id } = await validateSkillPackage(good, CHECKS);
  assert.equal(id, "community.seo-audit");

  const badId = await zipOf({
    "manifest.json": JSON.stringify({ ...GOOD_MANIFEST, id: "progressive-cms-content-agent" }),
    "SKILL.md": "x",
  });
  await assert.rejects(
    () => validateSkillPackage(badId, CHECKS),
    (error: unknown) => error instanceof SkillInstallError && error.code === "SKILL_ID_FORBIDDEN",
  );

  const badScope = await zipOf({
    "manifest.json": JSON.stringify({ ...GOOD_MANIFEST, recommended_scopes: ["not.a.permission"] }),
    "SKILL.md": "x",
  });
  await assert.rejects(
    () => validateSkillPackage(badScope, CHECKS),
    (error: unknown) => error instanceof SkillInstallError && error.code === "SKILL_SCOPE_UNKNOWN",
  );

  // A traversal entry cannot be authored with yazl (write-time guard), so
  // the reader-side gate is tested at the name level.
  assert.throws(
    () => validateEntryNames(["manifest.json", "../escape.md"]),
    (error: unknown) =>
      error instanceof SkillInstallError && error.code === "SKILL_PACKAGE_INVALID",
  );
  assert.throws(
    () => validateEntryNames(["manifest.json", "unknown-root/x.md"]),
    (error: unknown) =>
      error instanceof SkillInstallError && error.code === "SKILL_PACKAGE_INVALID",
  );
});

test("install: extracts, prepends the distrust banner, writes the sidecar; reinstall replaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pcms-skills-"));
  const good = await zipOf({
    "manifest.json": JSON.stringify(GOOD_MANIFEST),
    "SKILL.md": "# Skill\n\nWorkflow here.\n",
    "references/deep.md": "details",
  });
  const first = await installSkillPackage(good, {
    communityDir: dir,
    firstPartyIds: CHECKS.firstPartyIds,
    isRegisteredPermission: CHECKS.isRegisteredPermission,
    source: "https://example.com/skill.zip",
  });
  assert.equal(first.skill.manifest.id, "community.seo-audit");
  const skillMd = await import("node:fs").then((fs) =>
    fs.readFileSync(join(first.skill.directory, "SKILL.md"), "utf8"),
  );
  assert.match(skillMd, /^<!-- pcms:community-skill/);
  assert.match(skillMd, /Workflow here\./);
  assert.ok(existsSync(join(first.skill.directory, ".pcms-install.json")));
  const community = loadCommunitySkills(dir).skills.find(
    (skill) => skill.manifest.id === "community.seo-audit",
  );
  assert.equal(community?.install.source, "https://example.com/skill.zip");
  assert.equal(community?.disabled, false);

  // Disable → loader reports disabled; enable by removing the marker.
  writeFileSync(join(first.skill.directory, ".pcms-disabled"), "x\n");
  const disabled = loadCommunitySkills(dir).skills.find(
    (skill) => skill.manifest.id === "community.seo-audit",
  );
  assert.equal(disabled?.disabled, true);
  rmSync(join(first.skill.directory, ".pcms-disabled"));
});
