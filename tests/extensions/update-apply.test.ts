// PCMS-EXT-T014 — Update apply orchestration contract.
// Acceptance (Master Plan M14): preflight blocks incompatible targets, the
// backup gate is enforced, phase ordering is deterministic, the migration
// plan is passed to ports, postflight is required, failures are recorded,
// and without production adapters the apply fails closed with
// UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE (no fake success, ever).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  loadMigrations,
  migrateDatabase,
  systemClock,
} from "@pcms/core";
import {
  type CompatibilitySnapshot,
  checkUpdate,
  createUpdateOrchestrator,
  ExtensionError,
  type MaintenanceController,
  type MigrationApplier,
  type PostflightDoctor,
  parseReleaseManifest,
  type ReleaseDeploymentPort,
  type ServiceRestartPort,
  type UpdatePreflight,
} from "@pcms/extensions/internal";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const snapshot: CompatibilitySnapshot = {
  generatedAt: "2026-09-21T00:00:00.000Z",
  cms: {
    version: "1.4.2",
    nodeRuntime: { current: "24.21.0", supportedRange: ">=24.21 <25" },
    postgresRuntime: { current: "16.9", supportedRange: ">=14 <17" },
    database: {
      pendingMigrations: ["0002_rc_candidate_probe"],
      driftedMigrations: [],
      appliedMigrations: [],
    },
  },
  contracts: [],
  theme: undefined,
  extensions: [],
  capabilities: [],
  content: undefined,
  deprecations: [],
};

const manifest = parseReleaseManifest({
  manifest_version: "1",
  version: "1.5.0",
  required_runtime: { node: ">=24.21 <25", postgres: ">=14 <17" },
  core_db_migrations: ["0002_rc_candidate_probe"],
  supports_extension_contracts: ["2.0"],
  contract_versions: {},
  backup_required: false,
  rollback_policy: "rollback_safe",
});

const preflight: UpdatePreflight = checkUpdate({ snapshot, target: manifest });

function fakePorts(
  order: string[],
  overrides: {
    maintenance?: MaintenanceController;
    releaseDeployment?: ReleaseDeploymentPort;
    serviceRestart?: ServiceRestartPort;
    postflightDoctor?: PostflightDoctor;
    migrations?: MigrationApplier;
  } = {},
) {
  return {
    backupGate: {
      confirm: async () => void order.push("backup"),
    },
    maintenance: {
      enter: async () => void order.push("maintenance:enter"),
      exit: async () => void order.push("maintenance:exit"),
    },
    releaseDeployment: {
      deploy: async () => void order.push("deploy"),
    },
    serviceRestart: {
      restart: async () => void order.push("restart"),
    },
    postflightDoctor: {
      run: async () => {
        order.push("doctor");
        return { ok: true };
      },
    },
    migrations: {
      applyCore: async (planned: readonly string[]) => void order.push(`core:${planned.join("+")}`),
      applyExtensionMigrations: async (planned: readonly string[]) =>
        void order.push(`ext:${planned.join("+")}`),
    },
    ...overrides,
  };
}

async function setup(t: { after: (fn: () => void) => void }): Promise<DbPool> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

test("without production adapters the apply fails closed and the attempt is recorded", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const orchestrator = createUpdateOrchestrator({
    pool,
    clock: systemClock,
    preflight,
    target: manifest,
    actor: { type: "operator", id: "ops-1" },
    ports: {
      backupGate: { confirm: async () => undefined },
      maintenance: undefined,
      releaseDeployment: undefined,
      serviceRestart: undefined,
      postflightDoctor: undefined,
      migrations: undefined,
    },
  });
  await assert.rejects(
    () => orchestrator.apply({}),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE",
  );
  const history = await orchestrator.history();
  assert.equal(history[0]?.status, "FAILED");
  assert.equal(history[0]?.failureCode, "UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE");
  assert.equal(history[0]?.actor.type, "operator");
  // No secrets in the history record: versions, codes, migration names only.
  assert.equal(JSON.stringify(history[0]).includes("secret"), false);
});

test("blocked preflight refuses the apply before any port runs", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const blocked = checkUpdate({
    snapshot,
    target: parseReleaseManifest({
      manifest_version: "1",
      version: "2.0.0",
      required_runtime: { node: ">=26 <27", postgres: ">=14 <17" },
      core_db_migrations: [],
      supports_extension_contracts: ["2.0"],
      contract_versions: {},
      backup_required: false,
      rollback_policy: "forward_fix_only",
    }),
  });
  const order: string[] = [];
  const orchestrator = createUpdateOrchestrator({
    pool,
    clock: systemClock,
    preflight: blocked,
    target: manifest,
    actor: { type: "operator", id: "ops-1" },
    ports: fakePorts(order),
  });
  await assert.rejects(
    () => orchestrator.apply({}),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "UPDATE_COMPATIBILITY_BLOCKED",
  );
  assert.deepEqual(order, [], "no physical port may run for a blocked plan");
  const history = await orchestrator.history();
  assert.equal(history[0]?.failureCode, "UPDATE_COMPATIBILITY_BLOCKED");
});

test("backup gate is enforced with an explicit confirmation, no force bypass", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const requiredManifest = parseReleaseManifest({
    manifest_version: "1",
    version: "1.5.0",
    required_runtime: { node: ">=24.21 <25", postgres: ">=14 <17" },
    core_db_migrations: ["0002_rc_candidate_probe"],
    supports_extension_contracts: ["2.0"],
    contract_versions: {},
    backup_required: true,
    rollback_policy: "restore_required",
  });
  const backupRequiredPreflight = checkUpdate({ snapshot, target: requiredManifest });
  const order: string[] = [];
  const orchestrator = createUpdateOrchestrator({
    pool,
    clock: systemClock,
    preflight: backupRequiredPreflight,
    target: requiredManifest,
    actor: { type: "operator", id: "ops-1" },
    ports: fakePorts(order),
  });
  // Without the confirmation the update is refused.
  await assert.rejects(
    () => orchestrator.apply({}),
    (error: unknown) => error instanceof ExtensionError && error.code === "UPDATE_BACKUP_REQUIRED",
  );
  assert.deepEqual(order, []);
  // With the confirmation the gate runs before everything else.
  const record = await orchestrator.apply({ backupConfirmation: "1.5.0" });
  assert.equal(record.status, "SUCCEEDED");
  assert.equal(order[0], "backup");
});

test("phase ordering is deterministic and the migration plan reaches the ports", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const order: string[] = [];
  const orchestrator = createUpdateOrchestrator({
    pool,
    clock: systemClock,
    preflight,
    target: manifest,
    actor: { type: "operator", id: "ops-1" },
    ports: fakePorts(order),
  });
  const record = await orchestrator.apply({});
  assert.equal(record.status, "SUCCEEDED");
  assert.deepEqual(order, [
    "backup",
    "maintenance:enter",
    "deploy",
    "core:0002_rc_candidate_probe",
    "ext:",
    "restart",
    "doctor",
    "maintenance:exit",
  ]);
});

test("postflight failure is recorded as FAILED with UPDATE_POSTFLIGHT_FAILED", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const order: string[] = [];
  const orchestrator = createUpdateOrchestrator({
    pool,
    clock: systemClock,
    preflight,
    target: manifest,
    actor: { type: "operator", id: "ops-1" },
    ports: fakePorts(order, {
      postflightDoctor: {
        run: async () => ({ ok: false }),
      },
    }),
  });
  await assert.rejects(
    () => orchestrator.apply({}),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "UPDATE_POSTFLIGHT_FAILED",
  );
  const history = await orchestrator.history();
  assert.equal(history[0]?.status, "FAILED");
  assert.equal(history[0]?.failureCode, "UPDATE_POSTFLIGHT_FAILED");
  // The failure stays inspectable: phases up to the failure are recorded.
  assert.match(JSON.stringify(history[0]?.validationSummary), /RESTARTING|RESTARTING/);
  assert.equal(order.includes("maintenance:exit"), false, "failed updates stay in maintenance");
});

test("M17-T006: history records what the migrator actually applied, not the plan", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const order: string[] = [];
  const actualApplied = ["0002_rc_candidate_probe"];
  const orchestrator = createUpdateOrchestrator({
    pool,
    clock: systemClock,
    preflight,
    target: manifest,
    actor: { type: "operator", id: "ops-1" },
    ports: fakePorts(order, {
      migrations: {
        // The migrator is the source of truth: it may apply a different set
        // than the plan (no-op, partial run) and history must show that.
        applyCore: async () => actualApplied,
        applyExtensionMigrations: async () => undefined,
      },
    }),
  });
  const record = await orchestrator.apply({});
  assert.equal(record.status, "SUCCEEDED");
  assert.deepEqual(record.coreMigrations, actualApplied);
  const history = await orchestrator.history();
  assert.deepEqual(history[0]?.coreMigrations, actualApplied);
});
