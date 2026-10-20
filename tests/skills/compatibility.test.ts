// PCMS-SKILL-T001/T017 compatibility result: machine-readable compatible/
// warning/incompatible with stable issue codes (task brief §27/§71).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluateSkillCompatibility, type SkillServerSnapshot } from "@pcms/skills";

const SERVER: SkillServerSnapshot = {
  contractVersions: {
    cms: "1.0.0-rc.1",
    rest_api: "1.0.0",
    mcp: "2024-11-05",
    theme_contract: "1.0.0",
    block_document: 1,
    bundle: 1,
    pcpub: 1,
    pcmd: 1,
  },
  capabilities: [
    "content.read",
    "publication.read",
    "preview.create",
    "publication.schedule",
    "publication.publish",
    "media.import",
    "media.stock.search",
    "media.stock.import",
    "navigation.edit",
    "theme.read",
  ],
};

const CONTENT = JSON.parse(
  readFileSync("skills/progressive-cms-content-agent/manifest.json", "utf8"),
);

test("current server satisfies the shipped content manifest", () => {
  const evaluation = evaluateSkillCompatibility(CONTENT, SERVER);
  assert.equal(evaluation.result, "compatible");
  assert.deepEqual(evaluation.issues, []);
});

test("supported minor contract version is green (same major, in range)", () => {
  const evaluation = evaluateSkillCompatibility(
    { version: "1.0.0", requires: { contracts: { theme_contract: "^1.0.0" } } },
    { contractVersions: { theme_contract: "1.1.0" }, capabilities: [] },
  );
  assert.equal(evaluation.result, "compatible");
});

test("missing optional capability is a warning, not a stop", () => {
  const evaluation = evaluateSkillCompatibility(CONTENT, {
    ...SERVER,
    capabilities: ["content.read", "publication.read"],
  });
  assert.equal(evaluation.result, "warning");
  assert.ok(evaluation.issues.every((issue) => issue.code === "CAPABILITY_MISSING_OPTIONAL"));
});

test("missing required capability is incompatible", () => {
  const evaluation = evaluateSkillCompatibility(CONTENT, {
    ...SERVER,
    capabilities: ["content.read"],
  });
  assert.equal(evaluation.result, "incompatible");
  assert.ok(evaluation.issues.some((issue) => issue.code === "CAPABILITY_MISSING"));
});

test("major contract mismatch is incompatible", () => {
  const evaluation = evaluateSkillCompatibility(
    { version: "1.0.0", requires: { contracts: { theme_contract: "^1.0.0" } } },
    { contractVersions: { theme_contract: "2.0.0" }, capabilities: [] },
  );
  assert.equal(evaluation.result, "incompatible");
  assert.ok(evaluation.issues.some((issue) => issue.code === "CONTRACT_MAJOR_MISMATCH"));
});

test("missing contract and out-of-range minor variance behave per spec", () => {
  const missing = evaluateSkillCompatibility(
    { version: "1.0.0", requires: { contracts: { bundle: "1" } } },
    { contractVersions: {}, capabilities: [] },
  );
  assert.equal(missing.result, "incompatible");
  assert.ok(missing.issues.some((issue) => issue.code === "CONTRACT_MISSING"));

  const variance = evaluateSkillCompatibility(
    { version: "1.0.0", requires: { contracts: { rest_api: "~1.0.0" } } },
    { contractVersions: { rest_api: "1.3.0" }, capabilities: [] },
  );
  assert.equal(variance.result, "warning");
  assert.ok(variance.issues.some((issue) => issue.code === "CONTRACT_VARIANCE"));
});

test("R17: abbreviated contract versions match ranges without a false major mismatch", () => {
  // The shipped operator/extension-developer manifests declare "^2.0"/"^2"
  // while the server reports "1.0"/"1" — semver.parse() returns null for
  // those, which used to fail safe as CONTRACT_MAJOR_MISMATCH.
  const snapshot = {
    contractVersions: {
      rest_api: "1.0.0",
      extension_contract: "2.0",
      cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
      config_schema: 1,
      theme_contract: "1.0.0",
      mcp: "2024-11-05",
    },
    capabilities: ["site.validate"],
  };
  const operator = evaluateSkillCompatibility(
    {
      version: "1.0.0",
      requires: {
        contracts: { rest_api: "^1.0.0", extension_contract: "^2.0", config_schema: "^1" },
        minimum_capabilities: ["site.validate"],
      },
    },
    snapshot,
  );
  assert.equal(operator.result, "compatible", JSON.stringify(operator.issues));
  assert.equal(operator.issues.length, 0);

  const extensionDeveloper = evaluateSkillCompatibility(
    {
      version: "1.0.0",
      requires: { contracts: { extension_contract: "^2.0", rest_api: "^1.0.0" } },
    },
    snapshot,
  );
  assert.equal(extensionDeveloper.result, "compatible", JSON.stringify(extensionDeveloper.issues));

  // A real major bump is still incompatible.
  const bumped = evaluateSkillCompatibility(
    { version: "3.0.0", requires: { contracts: { extension_contract: "^3" } } },
    { contractVersions: { extension_contract: "2" }, capabilities: [] },
  );
  assert.equal(bumped.result, "incompatible");
  assert.ok(bumped.issues.some((issue) => issue.code === "CONTRACT_MAJOR_MISMATCH"));

  // A missing required contract stays incompatible.
  const missing = evaluateSkillCompatibility(
    { version: "1.0.0", requires: { contracts: { extension_contract: "^2" } } },
    { contractVersions: {}, capabilities: [] },
  );
  assert.equal(missing.result, "incompatible");
  assert.ok(missing.issues.some((issue) => issue.code === "CONTRACT_MISSING"));

  // Exact match for non-semver contracts is preserved (no date coercion).
  const staleDate = evaluateSkillCompatibility(
    { version: "1.0.0", requires: { contracts: { mcp: "2024-11-05" } } },
    { contractVersions: { mcp: "2024-12-01" }, capabilities: [] },
  );
  assert.equal(staleDate.result, "incompatible");
});

test("R17 acceptance: shipped operator/extension-developer manifests pass the real bootstrap snapshot", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  // The contract versions exposed by the first public release candidate.
  const snapshot = {
    contractVersions: {
      cms: "1.0.0-rc.1",
      rest_api: "1.0.0",
      extension_contract: "2.0",
      cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
      config_schema: "1",
      theme_contract: "1.0.0",
      mcp: "2024-11-05",
      block_document: "1",
      search_index: "2",
      bundle: "1",
    },
    capabilities: ["site.validate", "extensions.manage"],
  };
  for (const id of ["progressive-cms-operator", "progressive-cms-extension-developer"]) {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "skills", id, "manifest.json"), "utf8"),
    ) as {
      version: string;
      requires: { cms: string; contracts: Record<string, string>; minimum_capabilities: string[] };
    };
    const evaluation = evaluateSkillCompatibility(manifest, snapshot);
    // The seam's contract: no false major mismatch and no missing-contract
    // stop. Optional-capability warnings depend on the actor snapshot and
    // are not a compatibility failure.
    assert.notEqual(
      evaluation.result,
      "incompatible",
      `${id}: ${JSON.stringify(evaluation.issues)}`,
    );
    assert.ok(
      evaluation.issues.every(
        (issue) => issue.code !== "CONTRACT_MAJOR_MISMATCH" && issue.code !== "CONTRACT_MISSING",
      ),
      `${id}: ${JSON.stringify(evaluation.issues)}`,
    );
  }
});
test("non-semver contract versions (MCP date protocol) match exactly", () => {
  const same = evaluateSkillCompatibility(
    { version: "1.0.0", requires: { contracts: { mcp: "2024-11-05" } } },
    { contractVersions: { mcp: "2024-11-05" }, capabilities: [] },
  );
  assert.equal(same.result, "compatible");
  const bumped = evaluateSkillCompatibility(
    { version: "1.0.0", requires: { contracts: { mcp: "2024-11-05" } } },
    { contractVersions: { mcp: "2025-03-26" }, capabilities: [] },
  );
  assert.equal(bumped.result, "incompatible");
});

// CORE-RC19 G — a shipped manifest's `requires.cms` must actually match the
// versions the product ships. SemVer excludes a prerelease unless a comparator
// in the SAME tuple carries one, so a plain `>=0.1.98 <2.0.0` silently rejects
// every `1.0.0-rc.*` — i.e. every release candidate felt like an incompatible
// server to the agent that had just installed the skill.
test("shipped manifests accept every supported Core line, including release candidates", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const manifests: readonly { file: readonly string[]; accepts: readonly string[] }[] = [
    {
      file: ["skills", "progressive-cms-content-agent", "manifest.json"],
      // The skill's baseline compatibility is v1: it must keep accepting the
      // whole Core 1.0 line, release candidates included.
      accepts: ["1.0.0-rc.1", "1.0.0-rc.18", "1.0.0-rc.19", "1.0.0", "1.9.0"],
    },
    {
      file: ["docs", "init-package", "skills", "progressive-cms-site-builder", "manifest.json"],
      // Documented as live-verified on 0.1.x as well as Core 1.0.
      accepts: ["0.1.98", "0.1.210", "1.0.0-rc.1", "1.0.0-rc.19", "1.0.0"],
    },
  ];
  const rejected = ["0.0.1", "2.0.0", "2.0.0-rc.1", "3.0.0"];
  // A full snapshot: this gate is about the `cms` RANGE, so the contract and
  // capability requirements must be satisfied for the range to be what decides.
  const contracts = {
    rest_api: "1.0.0",
    mcp: "2024-11-05",
    theme_contract: "1.0.0",
    block_document: "1",
    bundle: "1",
    pcpub: "1",
    pcmd: "1",
    search_index: "2",
    config_schema: "1",
  };
  const capabilities = [
    "site.validate",
    "content.read",
    "content.create",
    "content.edit",
    "publication.read",
    "publication.publish",
    "media.read",
    "media.write",
    "media.import",
    "preview.create",
    "navigation.read",
    "navigation.edit",
    "seo.read",
    "theme.read",
    "theme.write",
    "theme.validate",
  ];
  for (const { file, accepts } of manifests) {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), ...file), "utf8")) as {
      version: string;
      requires: { cms: string };
    };
    for (const cms of accepts) {
      const evaluation = evaluateSkillCompatibility(
        { version: manifest.version, requires: manifest.requires as never },
        { contractVersions: { ...contracts, cms }, capabilities },
      );
      assert.notEqual(
        evaluation.result,
        "incompatible",
        `${file.join("/")} must accept ${cms}: ${JSON.stringify(evaluation.issues)}`,
      );
    }
    for (const cms of rejected) {
      const evaluation = evaluateSkillCompatibility(
        { version: manifest.version, requires: manifest.requires as never },
        { contractVersions: { ...contracts, cms }, capabilities },
      );
      assert.equal(evaluation.result, "incompatible", `${file.join("/")} must reject ${cms}`);
    }
  }
});
