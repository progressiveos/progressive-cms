// PCMS-EXT-T012 — Compatibility scanner acceptance corpus.
// Acceptance corpus (task brief §29/§T012): compatible current site, old
// supported block, unsupported block version, incompatible theme, missing
// capability, disabled required extension, extension migration drift,
// invalid extension config, deprecated field/tool usage, unknown extension
// payload preserved. Result is machine-readable and deterministic.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CompatibilityIssue,
  type CompatibilitySnapshot,
  scanCompatibility,
} from "@pcms/extensions/internal";

const base: CompatibilitySnapshot = {
  generatedAt: "2026-09-21T00:00:00.000Z",
  cms: {
    version: "1.0.0-rc.1",
    nodeRuntime: { current: "24.21.0", supportedRange: ">=24.21 <25" },
    postgresRuntime: { current: "16.9", supportedRange: ">=14 <17" },
    database: { pendingMigrations: [], driftedMigrations: [], appliedMigrations: [] },
  },
  contracts: [
    { key: "cms", version: "1.0.0-rc.1", source: "cms:release" },
    { key: "theme_contract", version: "1.0.0", source: "cms:themes" },
  ],
  theme: { contractVersion: "1.0.0", supportedContractRange: "^1.0.0" },
  extensions: [
    {
      id: "com.example.basics",
      deployed: true,
      installed: true,
      state: "ENABLED",
      manifestVersion: "1.0.0",
      extensionContractVersion: "2.0",
      cmsCompatibility: ">=1.0.0-rc.1 <2.0.0",
      fingerprintMatches: true,
      artifactDigest: null,
      requires: [{ capability: "theme-contract", range: "^1.0.0" }],
      provides: [{ capability: "com.example.basics.banner", version: "1.0.0" }],
      configIssues: [],
      migrations: { applied: [], pending: [], drifted: [] },
    },
  ],
  capabilities: [
    { key: "theme-contract", version: "1.0.0", provider: "cms:themes" },
    { key: "com.example.basics.banner", version: "1.0.0", provider: "com.example.basics" },
  ],
  content: {
    blockTypes: [
      {
        type: "core.rich-text",
        version: "1.0.0",
        supportedRange: "^1.0.0",
        currentVersion: "1.0.0",
        usageCount: 42,
      },
    ],
    unknownExtensionNamespaces: [],
    deprecatedUsages: [],
    truncated: false,
  },
  deprecations: [],
};

function code(issues: readonly CompatibilityIssue[], subject: string): string | undefined {
  return issues.find((issue) => issue.subject === subject)?.code;
}

test("compatible current site scans READY with no blocking issues", () => {
  const report = scanCompatibility(base);
  assert.equal(report.outcome, "READY");
  assert.deepEqual(report.issues, []);
});

test("installed extension Core range blocks an unsupported running version", () => {
  const report = scanCompatibility({
    ...base,
    cms: { ...base.cms, version: "2.0.0" },
  });
  assert.equal(code(report.issues, "com.example.basics"), "COMPAT_EXTENSION_CORE_UNSUPPORTED");
  assert.equal(report.outcome, "BLOCKED");
});

test("old supported block version is legacy-info, not blocking", () => {
  const report = scanCompatibility({
    ...base,
    content: {
      ...base.content!,
      blockTypes: [
        {
          type: "core.rich-text",
          version: "1.0.0",
          supportedRange: ">=1.0.0 <3.0.0",
          currentVersion: "2.1.0",
          usageCount: 42,
        },
      ],
    },
  });
  assert.equal(code(report.issues, "core.rich-text"), "COMPAT_BLOCK_VERSION_LEGACY");
  assert.equal(report.outcome, "READY_WITH_WARNINGS");
});

test("unsupported block version blocks", () => {
  const report = scanCompatibility({
    ...base,
    content: {
      ...base.content!,
      blockTypes: [
        {
          type: "core.gallery",
          version: "0.5.0",
          supportedRange: "^1.0.0",
          currentVersion: "1.4.0",
          usageCount: 3,
        },
      ],
    },
  });
  assert.equal(code(report.issues, "core.gallery"), "COMPAT_BLOCK_VERSION_UNSUPPORTED");
  assert.equal(report.outcome, "BLOCKED");
});

test("incompatible theme contract blocks", () => {
  const report = scanCompatibility({
    ...base,
    theme: { contractVersion: "2.0.0", supportedContractRange: "^1.0.0" },
  });
  assert.equal(code(report.issues, "active-theme"), "COMPAT_THEME_CONTRACT_UNSUPPORTED");
  assert.equal(report.outcome, "BLOCKED");
});

test("missing capability blocks the requiring extension", () => {
  const report = scanCompatibility({
    ...base,
    extensions: [
      ...base.extensions,
      {
        id: "com.example.needy",
        deployed: true,
        installed: true,
        state: "ENABLED",
        manifestVersion: "1.0.0",
        extensionContractVersion: "2.0",
        cmsCompatibility: ">=1.0.0-rc.1 <2.0.0",
        fingerprintMatches: true,
        artifactDigest: null,
        requires: [{ capability: "payments.provider", range: "^1.0.0" }],
        provides: [],
        configIssues: [],
        migrations: undefined,
      },
    ],
  });
  assert.equal(code(report.issues, "com.example.needy"), "COMPAT_CAPABILITY_MISSING");
  assert.equal(report.outcome, "BLOCKED");
});

test("capability satisfied only by a disabled extension is a hard error", () => {
  const report = scanCompatibility({
    ...base,
    extensions: [
      {
        id: "com.example.dependent",
        deployed: true,
        installed: true,
        state: "ENABLED",
        manifestVersion: "1.0.0",
        extensionContractVersion: "2.0",
        cmsCompatibility: ">=1.0.0-rc.1 <2.0.0",
        fingerprintMatches: true,
        artifactDigest: null,
        requires: [{ capability: "com.example.provider.core", range: "^1.0.0" }],
        provides: [],
        configIssues: [],
        migrations: undefined,
      },
      {
        id: "com.example.provider",
        deployed: true,
        installed: true,
        state: "DISABLED",
        manifestVersion: "1.0.0",
        extensionContractVersion: "2.0",
        cmsCompatibility: ">=1.0.0-rc.1 <2.0.0",
        fingerprintMatches: true,
        artifactDigest: null,
        requires: [],
        provides: [{ capability: "com.example.provider.core", version: "1.0.0" }],
        configIssues: [],
        migrations: undefined,
      },
    ],
    capabilities: [
      { key: "theme-contract", version: "1.0.0", provider: "cms:themes" },
      {
        key: "com.example.provider.core",
        version: "1.0.0",
        provider: "com.example.provider",
      },
    ],
  });
  assert.equal(code(report.issues, "com.example.dependent"), "COMPAT_CAPABILITY_PROVIDER_DISABLED");
  assert.equal(report.outcome, "BLOCKED");
});

test("extension migration drift and invalid config both block", () => {
  const report = scanCompatibility({
    ...base,
    extensions: [
      {
        id: "com.example.broken",
        deployed: true,
        installed: true,
        state: "INSTALLED",
        manifestVersion: "1.0.0",
        extensionContractVersion: "2.0",
        cmsCompatibility: ">=1.0.0-rc.1 <2.0.0",
        fingerprintMatches: true,
        artifactDigest: null,
        requires: [],
        provides: [],
        configIssues: [{ path: "token", message: "required" }],
        migrations: { applied: [], pending: [], drifted: ["0001_create_state"] },
      },
    ],
  });
  assert.equal(code(report.issues, "com.example.broken"), "COMPAT_EXTENSION_CONFIG_INVALID");
  assert.ok(report.issues.some((issue) => issue.code === "COMPAT_EXTENSION_MIGRATION_DRIFT"));
  assert.equal(report.outcome, "BLOCKED");
});

test("deprecated usage surfaces as a warning with remediation", () => {
  const report = scanCompatibility({
    ...base,
    content: {
      ...base.content!,
      deprecatedUsages: [{ usageKey: "block:core.old-hero", location: "home/hero" }],
    },
    deprecations: [
      {
        id: "content.blocks.old_hero",
        contract: "content",
        item: "block type core.old-hero",
        introduced: "0.9.0",
        deprecated_in: "1.0.0",
        replacement: "core.hero",
        planned_removal_major: 2,
        status: "active",
        usage_key: "block:core.old-hero",
      },
    ],
  });
  const issue = report.issues.find((entry) => entry.code === "COMPAT_DEPRECATED_USAGE");
  assert.ok(issue);
  assert.match(issue.message, /major 2/);
  assert.match(issue.message, /core\.hero/);
  assert.equal(issue.blocking, false);
  assert.equal(report.outcome, "READY_WITH_WARNINGS");
});

test("unknown extension payload namespace is preserved as info, never an error", () => {
  const report = scanCompatibility({
    ...base,
    content: {
      ...base.content!,
      unknownExtensionNamespaces: ["vendor.crm"],
    },
  });
  const issue = report.issues.find((entry) => entry.code === "COMPAT_UNKNOWN_EXTENSION_NAMESPACE");
  assert.ok(issue);
  assert.equal(issue?.severity, "info");
  assert.equal(issue?.blocking, false);
  assert.equal(report.outcome, "READY_WITH_WARNINGS");
});

test("runtime and database problems block with dedicated codes", () => {
  const report = scanCompatibility({
    ...base,
    cms: {
      ...base.cms,
      nodeRuntime: { current: "22.0.0", supportedRange: ">=24.21 <25" },
      database: {
        pendingMigrations: ["0001_public_baseline"],
        driftedMigrations: [],
        appliedMigrations: [],
      },
    },
  });
  assert.ok(report.issues.some((issue) => issue.code === "COMPAT_RUNTIME_UNSUPPORTED"));
  assert.ok(report.issues.some((issue) => issue.code === "COMPAT_DB_MIGRATION_PENDING"));
  assert.equal(report.outcome, "BLOCKED");
});

test("the report is deterministic and fully machine-readable", () => {
  const first = scanCompatibility(base);
  const second = scanCompatibility(base);
  assert.deepEqual(first, second);
  for (const issue of first.issues) {
    for (const key of ["code", "severity", "blocking", "category", "subject", "message"] as const) {
      assert.ok(issue[key] !== undefined, `issue field ${key} must be present`);
    }
    assert.ok(
      ["info", "warning", "error"].includes(issue.severity),
      "severity must be from the stable set",
    );
  }
});
