// PCMS-EXT-T006 — Install/enable/disable preflight and lifecycle service.
// Acceptance (Master Plan M14): enable works only if manifest/config/
// migrations/capabilities are compatible; disable is blocked when a
// dependent active extension would break. Preflight issues are
// machine-readable (stable codes, blocking flags, remediation).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  blockingIssues,
  createCapabilityRegistry,
  createExtensionCatalog,
  createExtensionLifecycleService,
  type DeployedExtensionArtifact,
  defineExtensionArtifact,
  ExtensionError,
  type ExtensionLifecycleAuditEvent,
  type ExtensionLifecycleService,
  type ExtensionManifest,
  type ExtensionTransactionContext,
} from "@pcms/extensions/internal";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const fixedClock = { now: () => new Date("2026-09-21T00:00:00.000Z") };

function manifestDoc(overrides: Record<string, unknown> & { id: string }) {
  return {
    name: "Test extension",
    version: "1.0.0",
    extension_contract: "2.0",
    cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
    entrypoint: { type: "module" },
    registrations: {},
    ...overrides,
  };
}

const emptyRegistrations = {
  blocks: [],
  field_types: [],
  routes: [],
  event_subscriptions: [],
  validators: [],
  providers: [],
  operations: [],
  http_routes: [],
  views: [],
  sitemap_sources: [],
  search_sources: [],
  media_usage_sources: [],
  jobs: [],
  obligations: [],
} as const;

function obligationArtifact(
  id: string,
  lockKey: number,
  handler: (tx: ExtensionTransactionContext) => Promise<unknown> = async (tx) => {
    const { rows } = await tx.query<{ c: string }>(
      "SELECT count(*)::text AS c FROM ext_obligations",
    );
    return Number(rows[0]?.c ?? "0");
  },
): {
  readonly doc: Record<string, unknown>;
  readonly module: Record<string, unknown>;
  readonly migrationsDir?: string;
} {
  return {
    doc: {
      ...manifestDoc({ id }),
      registrations: {
        ...emptyRegistrations,
        obligations: [
          {
            obligation_id: "orders",
            count_handler: "countOutstanding",
            lock_key: lockKey,
          },
        ],
      },
    },
    module: { countOutstanding: handler },
  };
}

function buildService(
  pool: DbPool,
  artifacts: {
    doc: Record<string, unknown>;
    module?: Record<string, unknown>;
    migrationsDir?: string;
  }[],
  options: {
    systemCapabilities?: ReturnType<typeof createCapabilityRegistry>;
    audit?: (event: ExtensionLifecycleAuditEvent) => Promise<void>;
  } = {},
): ExtensionLifecycleService {
  const catalog = createExtensionCatalog();
  for (const artifact of artifacts) {
    catalog.register(
      defineExtensionArtifact({
        manifest: artifact.doc,
        module: artifact.module ?? {},
        migrationsDir: artifact.migrationsDir,
      }),
    );
  }
  return createExtensionLifecycleService({
    pool,
    clock: fixedClock,
    coreVersion: "1.0.0-rc.1",
    catalog,
    systemCapabilities: options.systemCapabilities ?? createCapabilityRegistry(),
    audit: options.audit,
  });
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

async function integration(t: { after: (fn: () => void) => void }) {
  if (!testDatabaseConfigured()) return null;
  return setup(t);
}

test("install → enable → disable lifecycle with machine-readable preflights", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");

  const system = createCapabilityRegistry();
  system.provide({ key: "theme-contract", version: "1.0.0", provider: "cms:themes" });
  const audits: ExtensionLifecycleAuditEvent[] = [];
  const service = buildService(
    pool,
    [
      {
        doc: manifestDoc({
          id: "com.example.a",
          requires: [{ capability: "theme-contract", range: "^1.0.0" }],
          provides: [{ capability: "com.example.a.core", version: "1.0.0" }],
          config_schema: {
            type: "object",
            additionalProperties: false,
            properties: { label: { type: "string" } },
          },
        }),
      },
    ],
    { systemCapabilities: system, audit: async (event) => void audits.push(event) },
  );

  // Invalid config blocks install with a stable code.
  await assert.rejects(
    () => service.install({ extensionId: "com.example.a", config: { nope: true } }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_CONFIG_INVALID",
  );

  const pre = await service.installPreflight("com.example.a", { label: "hello" });
  assert.equal(pre.outcome, "READY");

  const install = await service.install({
    extensionId: "com.example.a",
    config: { label: "hello" },
  });
  assert.equal(install.installation.state, "INSTALLED");

  // Install replay (same fingerprint + config) is a no-op.
  const replay = await service.install({
    extensionId: "com.example.a",
    config: { label: "hello" },
  });
  assert.equal(
    replay.installation.installedAt.getTime(),
    install.installation.installedAt.getTime(),
  );

  const enable = await service.enable("com.example.a");
  assert.equal(enable.installation.state, "ENABLED");
  // Enable replay is a no-op.
  const enableAgain = await service.enable("com.example.a");
  assert.equal(enableAgain.installation.state, "ENABLED");

  assert.deepEqual(await service.enabledIds(), ["com.example.a"]);
  const disable = await service.disable("com.example.a");
  assert.equal(disable.installation.state, "DISABLED");
  assert.deepEqual(await service.enabledIds(), []);

  const outcomes = audits.map((event) => `${event.operation}:${event.outcome}`);
  assert.deepEqual(outcomes, ["install:ok", "enable:ok", "enable:ok", "disable:ok"]);
});

test("enable is blocked while a required capability is missing", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const service = buildService(pool, [
    {
      doc: manifestDoc({
        id: "com.example.needy",
        requires: [{ capability: "search.provider", range: "^1.0.0" }],
      }),
    },
  ]);
  await service.install({ extensionId: "com.example.needy", config: {} });
  const pre = await service.enablePreflight("com.example.needy");
  assert.equal(pre.outcome, "BLOCKED");
  const blocking = blockingIssues(pre.issues);
  assert.equal(blocking[0]?.code, "EXTENSION_DEPENDENCY_UNSATISFIED");
  assert.equal(blocking[0]?.category, "capability");
  assert.ok(blocking[0]?.remediation);
  await assert.rejects(
    () => service.enable("com.example.needy"),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_DEPENDENCY_UNSATISFIED",
  );
});

test("an extension outside the running Core range cannot be installed", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const service = buildService(pool, [
    {
      doc: manifestDoc({
        id: "com.example.core-range",
        cms_compatibility: ">=2.0.0 <3.0.0",
      }),
    },
  ]);
  const preflight = await service.installPreflight("com.example.core-range", {});
  assert.equal(preflight.outcome, "BLOCKED");
  assert.equal(blockingIssues(preflight.issues)[0]?.code, "EXTENSION_CORE_INCOMPATIBLE");
  await assert.rejects(
    () => service.install({ extensionId: "com.example.core-range", config: {} }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_CORE_INCOMPATIBLE",
  );
});

test("enable is blocked when migration drift is detected", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  // Install (applies migrations), then drift the ledger by hand.
  const service = buildService(pool, [
    {
      doc: manifestDoc({ id: "com.example.migy", migrations: { dir: "migrations" } }),
      migrationsDir: "tests/extensions/fixtures/migrations-a",
    },
  ]);
  await service.install({ extensionId: "com.example.migy", config: {} });
  await pool.query(
    `UPDATE pcms_extension_migrations SET checksum = 'deadbeef' WHERE extension_id = 'com.example.migy' AND name = '0001_create_state'`,
  );
  const pre = await service.enablePreflight("com.example.migy");
  assert.equal(pre.outcome, "BLOCKED");
  assert.equal(blockingIssues(pre.issues)[0]?.code, "EXTENSION_MIGRATION_DRIFT");
});

test("disable is blocked while another enabled extension depends on the capability", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const service = buildService(pool, [
    {
      doc: manifestDoc({
        id: "com.example.provider",
        provides: [{ capability: "com.example.provider.core", version: "1.0.0" }],
      }),
    },
    {
      doc: manifestDoc({
        id: "com.example.consumer",
        requires: [{ capability: "com.example.provider.core", range: "^1.0.0" }],
      }),
    },
  ]);
  await service.install({ extensionId: "com.example.provider", config: {} });
  await service.install({ extensionId: "com.example.consumer", config: {} });
  await service.enable("com.example.provider");
  await service.enable("com.example.consumer");

  const pre = await service.disablePreflight("com.example.provider");
  assert.equal(pre.outcome, "BLOCKED");
  assert.deepEqual(pre.impactedExtensions, ["com.example.consumer"]);
  assert.equal(blockingIssues(pre.issues)[0]?.code, "EXTENSION_DISABLE_BLOCKED");
  await assert.rejects(
    () => service.disable("com.example.provider"),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_DISABLE_BLOCKED",
  );

  // After the consumer is disabled, the provider can be disabled.
  await service.disable("com.example.consumer");
  const after = await service.disablePreflight("com.example.provider");
  assert.equal(after.outcome, "READY");
  await service.disable("com.example.provider");
  assert.deepEqual(await service.enabledIds(), []);
});

test("enable fails closed when the deployed manifest no longer matches the install", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const system = createCapabilityRegistry();
  system.provide({ key: "theme-contract", version: "1.0.0", provider: "cms:themes" });
  const mkService = (version: string) => {
    const catalog = createExtensionCatalog();
    catalog.register(
      defineExtensionArtifact({
        manifest: manifestDoc({
          id: "com.example.upgraded",
          version,
          requires: [{ capability: "theme-contract", range: "^1.0.0" }],
        }),
        module: {},
      }),
    );
    return createExtensionLifecycleService({
      pool,
      clock: fixedClock,
      coreVersion: "1.0.0-rc.1",
      catalog,
      systemCapabilities: system,
    });
  };
  const service = mkService("1.1.0");
  await service.install({ extensionId: "com.example.upgraded", config: {} });
  // Trusted deployment ships a newer manifest; installation fingerprint is stale.
  const afterDeploy = mkService("1.2.0");
  const pre = await afterDeploy.enablePreflight("com.example.upgraded");
  assert.equal(pre.outcome, "BLOCKED");
  assert.equal(blockingIssues(pre.issues)[0]?.code, "EXTENSION_DEPLOYMENT_INVALID");
});

test("operations on undeployed extensions fail closed with EXTENSION_NOT_DEPLOYED", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const service = buildService(pool, []);
  await assert.rejects(
    () => service.installPreflight("com.example.ghost", {}),
    (error: unknown) => error instanceof ExtensionError && error.code === "EXTENSION_NOT_DEPLOYED",
  );
  await assert.rejects(
    () => service.enable("com.example.ghost"),
    (error: unknown) => error instanceof ExtensionError && error.code === "EXTENSION_NOT_DEPLOYED",
  );
});

// ---- D07 — lifecycle obligations guard ----

async function obligationPool(t: { after: (fn: () => void) => void }): Promise<{
  pool: DbPool;
  db: Awaited<ReturnType<typeof createTestDatabase>>;
}> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 4 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ext_obligations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at timestamptz DEFAULT now()
    )`,
  );
  return { pool, db };
}

test("D07: outstanding obligations block disable", async (t) => {
  const { pool } = await obligationPool(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL unset");
  const service = buildService(pool, [obligationArtifact("com.example.shop", 4242)]);
  await service.install({ extensionId: "com.example.shop", config: {} });
  await service.enable("com.example.shop");

  // One outstanding obligation.
  await pool.query("INSERT INTO ext_obligations DEFAULT VALUES");

  const pre = await service.disablePreflight("com.example.shop");
  assert.equal(pre.outcome, "READY", "preflight itself is read-only and does not lock");
  await assert.rejects(
    () => service.disable("com.example.shop"),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_OBLIGATIONS_OUTSTANDING",
  );
  // State unchanged.
  assert.equal((await service.getInstallation("com.example.shop"))?.state, "ENABLED");
});

test("D07: no outstanding obligations allows disable", async (t) => {
  const { pool } = await obligationPool(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL unset");
  const service = buildService(pool, [obligationArtifact("com.example.shop", 4242)]);
  await service.install({ extensionId: "com.example.shop", config: {} });
  await service.enable("com.example.shop");

  const result = await service.disable("com.example.shop");
  assert.equal(result.installation.state, "DISABLED");
  assert.deepEqual(await service.enabledIds(), []);
});

test("D07: obligation check unavailable (lock held) fails closed — not disabled", async (t) => {
  const { pool, db } = await obligationPool(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL unset");
  const service = buildService(pool, [obligationArtifact("com.example.shop", 4242)]);
  await service.install({ extensionId: "com.example.shop", config: {} });
  await service.enable("com.example.shop");

  // Another transaction holds the advisory lock (a business operation is
  // creating an obligation right now). Use a separate pool so the lock is
  // held on a different PostgreSQL session than the lifecycle transaction.
  const otherPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  try {
    await otherPool.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(4242)");
      await assert.rejects(
        () => service.disable("com.example.shop"),
        (error: unknown) =>
          error instanceof ExtensionError &&
          error.code === "EXTENSION_OBLIGATION_CHECK_UNAVAILABLE",
      );
      // State unchanged — not disabled.
      assert.equal((await service.getInstallation("com.example.shop"))?.state, "ENABLED");
    });
  } finally {
    await otherPool.end();
  }
});

test("D07: concurrent obligation creation vs disable — only one wins", async (t) => {
  const { pool, db } = await obligationPool(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL unset");
  const service = buildService(pool, [obligationArtifact("com.example.shop", 4242)]);
  await service.install({ extensionId: "com.example.shop", config: {} });
  await service.enable("com.example.shop");

  // Business transaction A: creates an obligation under the same lock.
  const businessPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  try {
    await businessPool.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(4242)");
      await client.query("INSERT INTO ext_obligations DEFAULT VALUES");
      // Do NOT commit yet — disable must serialize with this.

      // Lifecycle transaction B: tries the same lock → must fail closed.
      await assert.rejects(
        () => service.disable("com.example.shop"),
        (error: unknown) =>
          error instanceof ExtensionError &&
          error.code === "EXTENSION_OBLIGATION_CHECK_UNAVAILABLE",
      );

      // Business commits the obligation.
      await client.query("COMMIT");
    });
  } finally {
    await businessPool.end();
  }

  // Now the obligation is durable — disable must be blocked by count.
  await assert.rejects(
    () => service.disable("com.example.shop"),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_OBLIGATIONS_OUTSTANDING",
  );
  assert.equal((await service.getInstallation("com.example.shop"))?.state, "ENABLED");
});

// Deterministic proof that the obligation check and the lifecycle transition
// share ONE transaction. With a separate check transaction the advisory lock
// is released before the state write, which is exactly the race the guard
// exists to close.
function countingPool(pool: DbPool): { pool: DbPool; transactions: () => number } {
  let count = 0;
  const proxy = new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "withTransaction") {
        return (run: (client: unknown) => Promise<unknown>) => {
          count += 1;
          return target.withTransaction(run as never);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  }) as DbPool;
  return { pool: proxy, transactions: () => count };
}

test("D07: disable performs the obligation check and the state write in ONE transaction", async (t) => {
  const { pool } = await obligationPool(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL unset");
  const counted = countingPool(pool);
  const service = buildService(counted.pool, [obligationArtifact("com.example.shop", 4246)]);
  await service.install({ extensionId: "com.example.shop", config: {} });
  await service.enable("com.example.shop");

  const before = counted.transactions();
  const result = await service.disable("com.example.shop");
  assert.equal(result.installation.state, "DISABLED");
  assert.equal(
    counted.transactions() - before,
    1,
    "check + transition must share one transaction (no window between lock release and write)",
  );
});

test("D07: uninstall performs the obligation check and the removal in ONE transaction", async (t) => {
  const { pool } = await obligationPool(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL unset");
  const counted = countingPool(pool);
  const service = buildService(counted.pool, [obligationArtifact("com.example.shop", 4247)]);
  await service.install({ extensionId: "com.example.shop", config: {} });
  await service.enable("com.example.shop");
  await service.disable("com.example.shop");

  const before = counted.transactions();
  await service.uninstall({ extensionId: "com.example.shop" });
  assert.equal(counted.transactions() - before, 1, "check + removal must share one transaction");
});

test("D07: extensions without obligations keep the previous lifecycle", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL unset");
  const service = buildService(pool, [
    {
      doc: manifestDoc({ id: "com.example.plain" }),
    },
  ]);
  await service.install({ extensionId: "com.example.plain", config: {} });
  await service.enable("com.example.plain");
  const result = await service.disable("com.example.plain");
  assert.equal(result.installation.state, "DISABLED");
});

// An untrustworthy count must never authorize a lifecycle change: undefined,
// NaN, a negative number, Infinity or a non-number all mean "cannot prove the
// obligation set is empty" → fail closed.
for (const [label, value] of [
  ["undefined", undefined],
  ["NaN", Number.NaN],
  ["negative", -1],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["string", "0"],
  ["fractional", 0.5],
] as const) {
  test(`D07: guard returning ${label} blocks disable (fail closed)`, async (t) => {
    const { pool } = await obligationPool(t);
    if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL unset");
    const service = buildService(pool, [
      obligationArtifact("com.example.shop", 4243, async () => value),
    ]);
    await service.install({ extensionId: "com.example.shop", config: {} });
    await service.enable("com.example.shop");

    await assert.rejects(
      () => service.disable("com.example.shop"),
      (error: unknown) =>
        error instanceof ExtensionError && error.code === "EXTENSION_OBLIGATION_CHECK_INVALID",
    );
    assert.equal(
      (await service.getInstallation("com.example.shop"))?.state,
      "ENABLED",
      "an invalid count must not disable the extension",
    );
  });
}

test("D07: guard returning a valid 0 allows disable", async (t) => {
  const { pool } = await obligationPool(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL unset");
  const service = buildService(pool, [obligationArtifact("com.example.shop", 4243, async () => 0)]);
  await service.install({ extensionId: "com.example.shop", config: {} });
  await service.enable("com.example.shop");
  const result = await service.disable("com.example.shop");
  assert.equal(result.installation.state, "DISABLED");
});

test("D07: guard failure (throwing handler) blocks uninstall as well", async (t) => {
  const { pool } = await obligationPool(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL unset");
  let fail = false;
  const service = buildService(pool, [
    obligationArtifact("com.example.shop", 4244, async () => {
      if (fail) throw new Error("obligation store unavailable");
      return 0;
    }),
  ]);
  await service.install({ extensionId: "com.example.shop", config: {} });
  await service.enable("com.example.shop");
  await service.disable("com.example.shop"); // guard healthy → allowed
  fail = true;
  await assert.rejects(
    () => service.uninstall({ extensionId: "com.example.shop" }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_OBLIGATION_CHECK_FAILED",
  );
  assert.equal(
    (await service.getInstallation("com.example.shop"))?.state,
    "DISABLED",
    "a failed guard must not uninstall",
  );
});

test("D07: uninstall re-checks ENABLED inside the transaction (concurrent enable)", async (t) => {
  const { pool } = await obligationPool(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL unset");

  // Deterministic interleaving: the uninstall preflight must observe
  // DISABLED, then a concurrent enable must commit BEFORE the uninstall
  // transaction runs. A proxy on the pool fires the enable exactly once, on
  // the first withTransaction call, so the outcome does not depend on timing.
  let armed = false;
  const proxy = new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "withTransaction") {
        return async (run: (client: never) => Promise<unknown>) => {
          if (armed) {
            armed = false;
            // A concurrent enable commits on its own connection.
            await target.query(
              "UPDATE pcms_extension_installations SET state = 'ENABLED' WHERE extension_id = $1",
              ["com.example.shop"],
            );
          }
          return target.withTransaction(run as never);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  }) as DbPool;

  const service = buildService(proxy, [obligationArtifact("com.example.shop", 4248)]);
  await service.install({ extensionId: "com.example.shop", config: {} });
  await service.disable("com.example.shop");

  const pre = await service.uninstallPreflight("com.example.shop");
  assert.equal(pre.outcome, "READY", "preflight legitimately sees DISABLED");

  armed = true; // the enable commits right before the uninstall transaction
  await assert.rejects(
    () => service.uninstall({ extensionId: "com.example.shop" }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_UNINSTALL_BLOCKED",
  );
  assert.equal(
    (await service.getInstallation("com.example.shop"))?.state,
    "ENABLED",
    "an enabled extension must never be uninstalled",
  );
});

// Sequential state observation, not a concurrency test: after disable commits,
// a business transaction that takes the same lock sees DISABLED and refuses to
// create an obligation. The concurrent interleavings are covered by the
// lock-held and concurrent-creation tests above.
test("D07: after disable commits, a business operation sees DISABLED and creates nothing", async (t) => {
  const { pool, db } = await obligationPool(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL unset");
  const service = buildService(pool, [obligationArtifact("com.example.shop", 4245)]);
  await service.install({ extensionId: "com.example.shop", config: {} });
  await service.enable("com.example.shop");

  // Lifecycle goes first: no obligations, so disable commits and holds the
  // state transition and the obligation lock in the same transaction.
  const disabled = await service.disable("com.example.shop");
  assert.equal(disabled.installation.state, "DISABLED");

  // Business operation runs afterwards under the same advisory lock and
  // re-reads the lifecycle state INSIDE its protected transaction.
  const businessPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  try {
    await businessPool.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(4245)");
      const state = await client.query<{ state: string }>(
        "SELECT state FROM pcms_extension_installations WHERE extension_id = $1",
        ["com.example.shop"],
      );
      const current: string = state.rows[0]?.state ?? "";
      assert.equal(current, "DISABLED");
      // Contract: refuse the business write unless the extension is ENABLED.
      if (current !== "DISABLED") {
        await client.query("INSERT INTO ext_obligations DEFAULT VALUES");
      }
    });
  } finally {
    await businessPool.end();
  }

  const obligations = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM ext_obligations",
  );
  assert.equal(Number(obligations.rows[0]?.n), 0, "no obligation created after disable");
  assert.equal((await service.getInstallation("com.example.shop"))?.state, "DISABLED");
});
