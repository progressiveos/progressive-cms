// PCMS-SKILL-T012: the safety-level/scope map references ONLY actual
// permission-registry keys, and the skill texts never mention a permission
// that does not exist. A registry append cannot silently diverge from the
// skills; a skill cannot invent permissions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PERMISSION_REGISTRY } from "@pcms/auth";
import { SKILL_SAFETY_LEVELS } from "@pcms/skills";

const REGISTRY = new Set(PERMISSION_REGISTRY.map((permission) => permission.key));
const MAP = JSON.parse(readFileSync("skills/schemas/safety-scope-map-v1.json", "utf8")) as {
  version: string;
  operations: readonly {
    skill: string;
    operation: string;
    safety_level: string;
    required_permissions: readonly string[];
    optional_permissions: readonly string[];
  }[];
};

test("safety map uses only registered permissions", () => {
  for (const entry of MAP.operations) {
    for (const scope of [...entry.required_permissions, ...entry.optional_permissions]) {
      assert.ok(
        REGISTRY.has(scope),
        `${entry.skill}/${entry.operation}: "${scope}" is not in PERMISSION_REGISTRY`,
      );
    }
  }
});

test("safety map levels are the canonical enum; each skill covers its levels", () => {
  const levels = new Set(MAP.operations.map((entry) => entry.safety_level));
  for (const level of levels) {
    assert.ok(
      (SKILL_SAFETY_LEVELS as readonly string[]).includes(level),
      `unknown safety level ${level}`,
    );
  }
  for (const skill of ["progressive-cms-content-agent", "progressive-cms-theme-developer"]) {
    const manifest = JSON.parse(readFileSync(`skills/${skill}/manifest.json`, "utf8")) as {
      safety_levels: readonly string[];
    };
    for (const level of manifest.safety_levels) {
      assert.ok(
        MAP.operations.some((entry) => entry.skill === skill && entry.safety_level === level),
        `${skill} declares safety level ${level} without a mapped operation`,
      );
    }
  }
});

test("dangerous operations map to elevated scopes (publish/activate/apply)", () => {
  const find = (operation: string) => MAP.operations.find((entry) => entry.operation === operation);
  assert.deepEqual(find("changeset apply")?.required_permissions, [
    "content.edit",
    "publication.publish",
  ]);
  assert.deepEqual(find("theme activation")?.required_permissions, ["theme.activate"]);
  assert.deepEqual(find("apply content schema change")?.required_permissions, [
    "content_schema.apply",
  ]);
});

test("skill texts never mention an unregistered permission", () => {
  // Permission-shaped tokens (dotted lowercase) in the skill surfaces must be
  // registry keys. Exempt: file names and dotted BOOTSTRAP RESPONSE paths —
  // those are discovery fields, not permissions.
  const FILE_SUFFIX = /\.(json|md|txt)$/i;
  const BOOTSTRAP_PATHS = new Set([
    "safety.environment",
    "bootstrap.skills",
    "capabilities.pcpub.external_entries.supported",
    "bootstrap.safety.environment",
    "bootstrap.publication.preview.available",
    "contracts.theme_contract",
    "theme.json.theme_contract",
  ]);
  for (const path of [
    "skills/progressive-cms-content-agent/SKILL.md",
    "skills/progressive-cms-theme-developer/SKILL.md",
    "skills/README.md",
    "skills/references/common-operating-rules.md",
  ]) {
    const text = readFileSync(path, "utf8");
    const candidates = new Set(text.match(/\b[a-z][a-z_]*(?:\.[a-z_]+)+\b/g) ?? []);
    for (const candidate of candidates) {
      if (FILE_SUFFIX.test(candidate) || BOOTSTRAP_PATHS.has(candidate)) continue;
      assert.ok(
        REGISTRY.has(candidate),
        `${path}: mentions "${candidate}" which is not a registered permission`,
      );
    }
  }
});
