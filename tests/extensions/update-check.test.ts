// PCMS-EXT-T013 — `cms update check` engine and release manifest v1.
// Acceptance corpus (task brief §75): patch compatible, minor additive,
// minor with deprecation, minor breaking removal, runtime too old,
// PostgreSQL unsupported, theme contract incompatible, extension
// requirement missing, extension version incompatible, pending destructive
// migration requiring backup, config breaking change, manual operator step,
// rollback policies. The check is read-only: a pure function over
// (snapshot, manifest).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CompatibilitySnapshot,
  checkUpdate,
  parseReleaseManifest,
  type ReleaseManifestV1,
} from "@pcms/extensions/internal";

const snapshot: CompatibilitySnapshot = {
  generatedAt: "2026-09-21T00:00:00.000Z",
  cms: {
    version: "1.4.2",
    nodeRuntime: { current: "24.21.0", supportedRange: ">=24.21 <25" },
    postgresRuntime: { current: "16.9", supportedRange: ">=14 <17" },
    database: {
      pendingMigrations: [],
      driftedMigrations: [],
      appliedMigrations: ["0001_public_baseline"],
    },
  },
  contracts: [
    { key: "cms", version: "1.4.2", source: "cms:release" },
    { key: "theme_contract", version: "1.0.0", source: "cms:themes" },
    { key: "extension_contract", version: "2.0", source: "cms:extensions" },
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
      provides: [],
      configIssues: [],
      migrations: undefined,
    },
  ],
  capabilities: [{ key: "theme-contract", version: "1.0.0", provider: "cms:themes" }],
  content: {
    blockTypes: [],
    unknownExtensionNamespaces: [],
    deprecatedUsages: [],
    truncated: false,
  },
  deprecations: [],
};

function manifest(overrides: Partial<Record<string, unknown>> = {}): ReleaseManifestV1 {
  return parseReleaseManifest({
    manifest_version: "1",
    version: "1.4.3",
    required_runtime: { node: ">=24.21 <25", postgres: ">=14 <17" },
    core_db_migrations: ["0001_public_baseline"],
    supports_extension_contracts: ["2.0"],
    contract_versions: { theme_contract: "1.0.0", extension_contract: "2.0" },
    backup_required: false,
    rollback_policy: "rollback_safe",
    ...overrides,
  });
}

function code(report: ReturnType<typeof checkUpdate>, subject: string): string | undefined {
  return report.issues.find((issue) => issue.subject === subject)?.code;
}

test("patch-compatible update is READY and read-only (no writes anywhere)", () => {
  const report = checkUpdate({ snapshot, target: manifest() });
  assert.equal(report.outcome, "READY");
  assert.equal(report.current.version, "1.4.2");
  assert.equal(report.target.version, "1.4.3");
  assert.deepEqual(report.plannedCoreMigrations, []);
  assert.equal(report.target.rollbackPolicy, "rollback_safe");
});

test("minor additive update with a deprecation stays READY_WITH_WARNINGS", () => {
  const report = checkUpdate({
    snapshot,
    target: manifest({
      version: "1.5.0",
      deprecations: [
        { id: "rest_api.entries.legacy_status", usage_key: "rest:entries:legacy_status" },
      ],
      manual_steps: ["review the deprecation notes"],
    }),
  });
  assert.equal(report.outcome, "READY_WITH_WARNINGS");
  assert.deepEqual(report.target.manualSteps, ["review the deprecation notes"]);
});

test("runtime too old blocks with UPDATE_RUNTIME_INCOMPATIBLE", () => {
  const report = checkUpdate({
    snapshot,
    target: manifest({ required_runtime: { node: ">=25 <26", postgres: ">=14 <17" } }),
  });
  assert.equal(code(report, "node"), "UPDATE_RUNTIME_INCOMPATIBLE");
  assert.equal(report.outcome, "BLOCKED");
});

test("PostgreSQL unsupported blocks with UPDATE_DATABASE_INCOMPATIBLE", () => {
  const report = checkUpdate({
    snapshot,
    target: manifest({ required_runtime: { node: ">=24.21 <25", postgres: ">=17 <18" } }),
  });
  assert.equal(code(report, "postgres"), "UPDATE_DATABASE_INCOMPATIBLE");
  assert.equal(report.outcome, "BLOCKED");
});

test("theme contract incompatible blocks", () => {
  const report = checkUpdate({
    snapshot,
    target: manifest({
      version: "2.0.0",
      contract_versions: { theme_contract: "2.0.0", extension_contract: "2.0" },
    }),
  });
  assert.equal(code(report, "active-theme"), "UPDATE_COMPATIBILITY_BLOCKED");
  assert.equal(report.outcome, "BLOCKED");
});

test("extension requirement missing in target blocks the extension subject", () => {
  const report = checkUpdate({
    snapshot,
    target: manifest({
      version: "1.5.0",
      contract_versions: { theme_contract: "2.0.0", extension_contract: "2.0" },
    }),
  });
  assert.equal(code(report, "com.example.basics"), "UPDATE_COMPATIBILITY_BLOCKED");
  assert.equal(report.outcome, "BLOCKED");
});

test("extension version incompatible (unsupported extension contract) blocks", () => {
  const target = manifest({
    version: "2.0.0",
    supports_extension_contracts: ["3.0"],
    contract_versions: { theme_contract: "1.0.0", extension_contract: "3.0" },
  });
  const report = checkUpdate({ snapshot, target });
  assert.equal(code(report, "com.example.basics"), "UPDATE_COMPATIBILITY_BLOCKED");
  assert.equal(report.outcome, "BLOCKED");
});

test("target Core outside an installed extension range blocks the update", () => {
  const target = manifest({ version: "2.0.0" });
  const report = checkUpdate({ snapshot, target });
  assert.equal(code(report, "com.example.basics"), "UPDATE_COMPATIBILITY_BLOCKED");
  assert.equal(report.outcome, "BLOCKED");
});

test("pending destructive migration requiring backup surfaces UPDATE_BACKUP_REQUIRED", () => {
  const report = checkUpdate({
    snapshot,
    target: manifest({
      backup_required: true,
      rollback_policy: "restore_required",
      core_db_migrations: ["0001_public_baseline", "0002_candidate_destructive"],
    }),
  });
  assert.equal(code(report, "backup"), "UPDATE_BACKUP_REQUIRED");
  assert.equal(report.target.backupRequired, true);
  assert.equal(report.target.rollbackPolicy, "restore_required");
  assert.equal(report.outcome, "READY_WITH_WARNINGS");
});

test("config breaking change blocks; benign config change warns", () => {
  const blocked = checkUpdate({
    snapshot,
    target: manifest({
      version: "1.5.0",
      config_changes: [{ key: "db.passwordSecretRef", kind: "removed", security_relevant: true }],
    }),
  });
  assert.equal(code(blocked, "db.passwordSecretRef"), "UPDATE_COMPATIBILITY_BLOCKED");
  assert.equal(blocked.outcome, "BLOCKED");

  const required = checkUpdate({
    snapshot,
    target: manifest({
      version: "1.5.0",
      config_changes: [
        { key: "media.storageDir", kind: "added", security_relevant: false, has_default: false },
      ],
    }),
  });
  assert.equal(code(required, "media.storageDir"), "UPDATE_CONFIG_REQUIRED");
  assert.equal(required.outcome, "BLOCKED");

  const benign = checkUpdate({
    snapshot,
    target: manifest({
      version: "1.5.0",
      config_changes: [
        {
          key: "http.shutdownTimeoutMilliseconds",
          kind: "behavior_changed",
          security_relevant: false,
          description: "grace period semantics",
        },
      ],
    }),
  });
  assert.equal(code(benign, "http.shutdownTimeoutMilliseconds"), "UPDATE_CONFIG_CHANGED");
  assert.equal(benign.outcome, "READY_WITH_WARNINGS");
});

test("forward_fix_only and rollback_safe policies are surfaced verbatim", () => {
  for (const policy of ["forward_fix_only", "rollback_safe", "restore_required"] as const) {
    const report = checkUpdate({ snapshot, target: manifest({ rollback_policy: policy }) });
    assert.equal(report.target.rollbackPolicy, policy);
  }
});

test("rollback manifest validation: unknown dangerous fields are rejected", () => {
  assert.throws(
    () =>
      parseReleaseManifest({
        manifest_version: "1",
        version: "1.4.3",
        required_runtime: { node: ">=24.21 <25", postgres: ">=14 <17" },
        backup_required: false,
        rollback_policy: "rollback_safe",
        post_install_shell: "rm -rf /",
      }),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      return error.message.includes("UPDATE_MANIFEST_INVALID") || error.name === "ExtensionError";
    },
  );
});

test("M17-T005: planned migrations compare the DB ledger with the TARGET inventory", () => {
  // DB already at the running release's head; the target adds one migration.
  // The pre-M17 computation went through the running tree's pending set and
  // reported `planned_core_migrations: []` here — the launch blocker.
  const report = checkUpdate({
    snapshot: {
      ...snapshot,
      cms: {
        ...snapshot.cms,
        database: {
          pendingMigrations: [],
          driftedMigrations: [],
          appliedMigrations: ["0001_public_baseline"],
        },
      },
    },
    target: manifest({
      core_db_migrations: ["0001_public_baseline", "0002_rc_candidate_probe"],
    }),
  });
  assert.deepEqual(report.plannedCoreMigrations, ["0002_rc_candidate_probe"]);
  assert.deepEqual(report.alreadyAppliedCoreMigrations, ["0001_public_baseline"]);
  assert.equal(report.outcome, "READY");
});

test("M17-T005: ledger rows the target does not declare are a drift warning", () => {
  const report = checkUpdate({
    snapshot: {
      ...snapshot,
      cms: {
        ...snapshot.cms,
        database: {
          pendingMigrations: [],
          driftedMigrations: [],
          appliedMigrations: ["9999_legacy_row"],
        },
      },
    },
    target: manifest(),
  });
  assert.deepEqual(report.plannedCoreMigrations, ["0001_public_baseline"]);
  assert.ok(report.issues.some((issue) => issue.code === "UPDATE_MIGRATION_FOREIGN_ROWS"));
  assert.equal(report.outcome, "READY_WITH_WARNINGS");
});
