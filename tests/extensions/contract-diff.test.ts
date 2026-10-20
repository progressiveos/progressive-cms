// PCMS-EXT-T016 — Unified contract diff gate.
// Acceptance (Master Plan M14): additive minor passes, breaking minor
// fixture fails. The gate covers OpenAPI (existing M09 breakingDiff),
// MCP tools, the permission registry, the config schema and the theme
// compatibility corpus. Frozen fixtures are baselines; they are generated,
// never hand-edited.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PERMISSION_REGISTRY } from "@pcms/auth";
import { CONFIG_SCHEMA } from "@pcms/core";
import {
  breakingDiffFindings,
  type ContractDiffFinding,
  diffContractDocuments,
  keyedBy,
} from "@pcms/extensions/internal";
import { breakingDiff } from "../api/helpers/openapi-diff.js";

const openapi = () => JSON.parse(readFileSync("fixtures/api/openapi-v1.json", "utf8"));
const mcp = () => JSON.parse(readFileSync("fixtures/mcp/tool-contract-v1.json", "utf8"));
const themeCorpus = () =>
  JSON.parse(readFileSync("fixtures/themes/theme-compatibility-corpus.json", "utf8"));
const permissionsBaseline = () =>
  JSON.parse(readFileSync("fixtures/extensions/contract-baselines/permissions-v1.json", "utf8"));
const configBaseline = () =>
  JSON.parse(readFileSync("fixtures/extensions/contract-baselines/config-schema-v1.json", "utf8"));

function hasBreaking(findings: readonly ContractDiffFinding[]): boolean {
  return breakingDiffFindings(findings).length > 0;
}

/**
 * Canonicalizes the theme corpus into keyed objects (arrays are diffed
 * pairwise, so identity-keyed collections must be keyed before diffing):
 * themes by manifest name, persisted settings by themeId.
 */
function canonicalThemeCorpus(corpus: Record<string, unknown>): Record<string, unknown> {
  const themes = (corpus.themes as Record<string, unknown>[]).map((theme) => {
    const manifest = theme.manifest as Record<string, unknown> | undefined;
    return { ...theme, identity: String(manifest?.name ?? theme.note) };
  });
  const persisted = (corpus.persistedSettings as Record<string, unknown>[]).map((entry) => ({
    ...entry,
    identity: String(entry.themeId),
  }));
  return {
    ...corpus,
    themes: keyedBy(themes, "identity"),
    persistedSettings: keyedBy(persisted, "identity"),
  };
}

test("current canonical contracts match their frozen baselines (no breaking diff)", () => {
  assert.deepEqual(breakingDiff(openapi(), openapi()), []);
  assert.equal(hasBreaking(diffContractDocuments(mcp(), mcp())), false);
  assert.equal(
    hasBreaking(
      diffContractDocuments(
        canonicalThemeCorpus(themeCorpus()),
        canonicalThemeCorpus(themeCorpus()),
      ),
    ),
    false,
  );
  assert.equal(
    hasBreaking(
      diffContractDocuments(
        keyedBy(permissionsBaseline().permissions, "key"),
        keyedBy(PERMISSION_REGISTRY, "key"),
      ),
    ),
    false,
    "no permission may be removed or renamed since the baseline",
  );
  assert.equal(
    hasBreaking(diffContractDocuments(configBaseline().config_schema, CONFIG_SCHEMA)),
    false,
    "no config property may be removed or narrowed since the baseline",
  );
});

test("additive minor changes pass the gate everywhere", () => {
  // REST: adding an operation is additive.
  const restAdditive = openapi();
  restAdditive.paths["/entries"] = restAdditive.paths["/entries"] ?? {};
  assert.deepEqual(breakingDiff(openapi(), restAdditive), []);
  // MCP: adding a tool is additive.
  const mcpAdditive = mcp();
  const tools = mcpAdditive.tools ?? mcpAdditive;
  if (Array.isArray(tools)) {
    tools.push({
      name: "cms_future_tool",
      description: "additive",
      mutation: false,
      inputSchema: {},
    });
    assert.equal(hasBreaking(diffContractDocuments(mcp(), mcpAdditive)), false);
  }
  // Permissions: adding a key is allowed with review.
  const permissionsAdditive = keyedBy(
    [...PERMISSION_REGISTRY, { key: "future.new", since: "1.0", summary: "new" }],
    "key",
  );
  assert.equal(
    hasBreaking(diffContractDocuments(keyedBy(PERMISSION_REGISTRY, "key"), permissionsAdditive)),
    false,
  );
});

test("breaking minor fixtures fail: REST field/path removal", () => {
  const mutated = openapi();
  const paths = Object.keys(mutated.paths ?? {});
  assert.ok(paths.length > 0, "openapi fixture has paths");
  delete mutated.paths[paths[0] as string];
  const changes = breakingDiff(openapi(), mutated);
  assert.ok(
    changes.some((change) => change.kind === "operation_removed"),
    "operation removal must be detected as breaking",
  );
});

test("breaking minor fixtures fail: MCP tool removal", () => {
  const mutated = mcp();
  const tools = mutated.tools ?? mutated;
  assert.ok(Array.isArray(tools), "mcp fixture carries a tool array");
  tools.splice(0, 1);
  const findings = breakingDiffFindings(
    diffContractDocuments(mcp(), keyedBy(mcp().tools ?? [], "name") && keyedBy(tools, "name")),
  );
  assert.ok(findings.length > 0, "MCP tool removal must be detected");
  assert.equal(findings[0]?.code, "CONTRACT_ITEM_REMOVED");
});

test("breaking minor fixtures fail: permission rename", () => {
  const renamed = PERMISSION_REGISTRY.map((entry) =>
    entry.key === "extensions.manage" ? { ...entry, key: "extensions.manage_renamed" } : entry,
  );
  const findings = breakingDiffFindings(
    diffContractDocuments(keyedBy(PERMISSION_REGISTRY, "key"), keyedBy(renamed, "key")),
  );
  assert.ok(findings.length > 0);
  assert.match(findings[0]?.message ?? "", /extensions\.manage/);
});

test("breaking minor fixtures fail: theme corpus item removal", () => {
  const canonical = canonicalThemeCorpus(themeCorpus());
  const mutated = canonicalThemeCorpus(themeCorpus());
  const themes = mutated.themes as Record<string, unknown>;
  const firstTheme = Object.keys(themes)[0] as string;
  delete themes[firstTheme];
  const findings = breakingDiffFindings(diffContractDocuments(canonical, mutated));
  assert.ok(
    findings.some((finding) => finding.code === "CONTRACT_ITEM_REMOVED"),
    "removal of a theme-required corpus item must be detected as breaking",
  );
});

test("breaking minor fixtures fail: config property removal and type narrowing", () => {
  // Removal.
  const removed = JSON.parse(JSON.stringify(CONFIG_SCHEMA)) as Record<string, unknown>;
  const properties = removed.properties as Record<string, unknown>;
  delete properties.log;
  let findings = breakingDiffFindings(diffContractDocuments(CONFIG_SCHEMA, removed));
  assert.ok(findings.some((finding) => finding.code === "CONTRACT_ITEM_REMOVED"));

  // Type narrowing: log.level enum loses a value (secure behavior change).
  const narrowed = JSON.parse(JSON.stringify(CONFIG_SCHEMA)) as Record<string, unknown>;
  const logProps = ((narrowed.properties as Record<string, unknown>).log as Record<string, unknown>)
    .properties as Record<string, unknown>;
  const level = logProps.level as Record<string, unknown>;
  level.enum = (level.enum as string[]).slice(0, -1);
  findings = breakingDiffFindings(diffContractDocuments(CONFIG_SCHEMA, narrowed));
  assert.ok(
    findings.some((finding) => finding.code === "CONTRACT_ENUM_NARROWED"),
    "enum narrowing (secure values) must be detected",
  );

  // New required config key without default breaks.
  const withRequired = JSON.parse(JSON.stringify(CONFIG_SCHEMA)) as Record<string, unknown>;
  (withRequired.required as string[]).push("newMandatorySection");
  findings = breakingDiffFindings(diffContractDocuments(CONFIG_SCHEMA, withRequired));
  assert.ok(
    findings.some((finding) => finding.code === "CONTRACT_REQUIRED_ADDED"),
    "required added must be detected as breaking",
  );
});
