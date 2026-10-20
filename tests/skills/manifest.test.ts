// PCMS-SKILL-T001 acceptance: manifest schema v1 — valid content/theme
// manifests parse; invalid semver, unknown contract, missing id and invalid
// capability declarations are rejected with stable codes (task brief §26).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PERMISSION_REGISTRY } from "@pcms/auth";
import {
  loadInstalledSkills,
  parseSkillManifest,
  SKILL_MANIFEST_V1_SCHEMA,
  SYSTEM_CONTRACT_KEYS,
  validateSkillManifest,
} from "@pcms/skills";

const KNOWN_SCOPES = new Set(PERMISSION_REGISTRY.map((permission) => permission.key));
const FIXTURES = "fixtures/skills/manifests";
const fixture = (name: string) => JSON.parse(readFileSync(`${FIXTURES}/${name}.json`, "utf8"));

test("valid content and theme fixture manifests parse", () => {
  for (const name of ["valid-content", "valid-theme"]) {
    const result = validateSkillManifest(fixture(name), { knownScopes: KNOWN_SCOPES });
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
  }
});

test("invalid semver is rejected (real SemVer, no hand-rolled parser)", () => {
  const result = validateSkillManifest(fixture("invalid-semver"));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "VERSION_NOT_SEMVER"));
});

test("unknown required contract is rejected", () => {
  const result = validateSkillManifest(fixture("unknown-contract"));
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === "UNKNOWN_CONTRACT" && issue.path === "requires.contracts.content_contract",
    ),
  );
});

test("missing id is rejected", () => {
  const result = validateSkillManifest(fixture("missing-id"));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === "id"));
});

test("invalid capability declaration is rejected against the actual registry", () => {
  const result = validateSkillManifest(fixture("invalid-capability"), {
    knownScopes: KNOWN_SCOPES,
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "UNKNOWN_SCOPE"));
});

test("SYSTEM_CONTRACT_KEYS stay in sync with the extensions registry (no drift)", async () => {
  const extensions = await import("@pcms/extensions/internal");
  assert.deepEqual([...SYSTEM_CONTRACT_KEYS], [...extensions.CONTRACT_VERSION_KEYS]);
});

test("published schema JSON matches the code constant (no drift)", () => {
  const published = JSON.parse(
    readFileSync("skills/schemas/skill-manifest-v1.schema.json", "utf8"),
  );
  assert.deepEqual(published, SKILL_MANIFEST_V1_SCHEMA);
});

test("shipped first-party skill manifests parse with registry-checked scopes", () => {
  for (const path of [
    "skills/progressive-cms-content-agent/manifest.json",
    "skills/progressive-cms-theme-developer/manifest.json",
    "skills/progressive-cms-operator/manifest.json",
  ]) {
    const result = validateSkillManifest(JSON.parse(readFileSync(path, "utf8")), {
      knownScopes: KNOWN_SCOPES,
    });
    assert.equal(result.ok, true, `${path}: ${JSON.stringify(result)}`);
  }
});

test("installed-skill loader parses the skills/ root and fails loudly on junk", () => {
  const loaded = loadInstalledSkills("skills");
  const ids = loaded.skills.map((skill) => skill.manifest.id).sort();
  const expected = [
    "progressive-cms-content-agent",
    "progressive-cms-extension-developer",
    "progressive-cms-operator",
    "progressive-cms-theme-developer",
    "progressive-cms-web-research",
  ];
  // Public Docs adds three root Skills; the final ZIP gate requires their exact resources.
  if (existsSync("skills/progressive-cms-site-builder/manifest.json"))
    expected.push("progressive-cms-152fz", "progressive-cms-seo", "progressive-cms-site-builder");
  assert.deepEqual(ids, expected.sort());
  assert.equal(loaded.problems.length, 0);
  assert.throws(() => parseSkillManifest(fixture("missing-id")));
});
