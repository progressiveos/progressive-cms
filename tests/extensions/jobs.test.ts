// PREPUBLIC §4 — Extension Jobs on the shared M07 queue: platform enqueue
// (namespacing, payload-version stamp, origin, idempotency scoping) and the
// worker handler composition (lifecycle gate, version policy before
// invocation, diagnostics). Real PostgreSQL via the jobs tables.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createExtensionPlatformServices,
  type DeployedExtensionArtifact,
} from "@pcms/extensions/internal";
import { createJobsService, type JobRecord } from "@pcms/jobs";
import { createExtensionJobHandlers } from "../../packages/api/src/extension-jobs.js";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

function artifact(
  id: string,
  jobs: readonly {
    job_id: string;
    handler: string;
    payload_version: number;
    accepts_payload_versions?: readonly number[];
  }[],
  module: Record<string, unknown>,
): DeployedExtensionArtifact {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      extension_contract: "2.0",
      cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
      requires: [],
      provides: [],
      permissions: [],
      config_schema: undefined,
      migrations: undefined,
      data_policy: "retain",
      entrypoint: { type: "module" },
      registrations: {
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
        jobs,
      },
    } as never,
    module,
    migrationsDir: "/tmp/none",
    extensionsDir: "/tmp/none",
    contentSha256: "0".repeat(64),
  };
}

interface Fixture {
  readonly pool: DbPool;
  readonly jobs: ReturnType<typeof createJobsService>;
  /** Enqueues through the extension platform port (the exact contract an
   * extension handler sees) and returns the job record. */
  readonly platformEnqueue: (
    extensionId: string,
    request: { job: string; payload?: unknown; idempotencyKey?: string },
  ) => Promise<JobRecord>;
}

async function setup(t: import("node:test").TestContext): Promise<Fixture> {
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 4 });
  t.after(() => void pool.end());
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const jobs = createJobsService(pool, { clock: { now: () => new Date() } });
  const manifests = new Map<
    string,
    readonly { job_id: string; handler: string; payload_version: number }[]
  >();
  let lastEnqueued: JobRecord | null = null;
  const platformEnqueue = async (
    extensionId: string,
    request: { job: string; payload?: unknown; idempotencyKey?: string },
  ): Promise<JobRecord> => {
    const platform = createExtensionPlatformServices({
      pool,
      authorize: async () => {},
      actor: { kind: "actor", id: "tester", type: "user" },
      requestId: "req_test",
      extensionId,
      auditWriter: async () => {},
      outboxAppender: async () => {},
      jobs: {
        resolveRegistration: (jobId: string) => {
          const registration = (manifests.get(extensionId) ?? []).find(
            (candidate) => candidate.job_id === jobId,
          );
          if (registration === undefined) return null;
          return {
            queueType: `${extensionId}/${jobId}`,
            payloadVersion: registration.payload_version,
          };
        },
        enqueue: async (input): Promise<void> => {
          const { job: record } = await jobs.enqueue({
            type: input.type,
            payload: input.payload,
            ...(input.idempotencyKey === null ? {} : { idempotencyKey: input.idempotencyKey }),
            ...(input.runAt === undefined ? {} : { runAt: input.runAt }),
            ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
            origin: input.origin,
            ...(input.payloadVersion === null ? {} : { payloadVersion: input.payloadVersion }),
          });
          lastEnqueued = record;
        },
      },
    });
    manifests.set(extensionId, [{ job_id: "work", handler: "run", payload_version: 2 }]);
    lastEnqueued = null;
    await platform.jobs.enqueue(request);
    if (lastEnqueued === null) throw new Error("enqueue sink was not invoked");
    return lastEnqueued;
  };
  return { pool, jobs, platformEnqueue };
}

const metadataValue = async (pool: DbPool, key: string): Promise<string | null> => {
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM pcms_kernel_metadata WHERE key = $1",
    [key],
  );
  return rows[0]?.value ?? null;
};

test("extension jobs: platform enqueue namespaces, stamps version, scopes idempotency", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, platformEnqueue } = await setup(t);
  const record = await platformEnqueue("shop", { job: "work", payload: { sku: "A-1" } });
  assert.equal(record.type, "shop/work");
  assert.equal(record.payloadVersion, 2, "registration payload_version stamped");
  assert.equal(record.origin, "extension:shop");
  assert.deepEqual(record.payload, { sku: "A-1" });

  // Idempotency keys scope to the extension (no cross-extension capture).
  const first = await platformEnqueue("shop", {
    job: "work",
    payload: {},
    idempotencyKey: "daily",
  });
  const second = await platformEnqueue("shop", {
    job: "work",
    payload: {},
    idempotencyKey: "daily",
  });
  assert.equal(first.id, second.id, "idempotent re-enqueue returns the same job");
  const { rows: count } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM jobs WHERE idempotency_key = $1",
    ["extjob:shop:daily"],
  );
  assert.equal(Number(count[0]?.n), 1, "one active job per extension-scoped key");
});

test("extension jobs: unknown registration fails closed at enqueue", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { platformEnqueue } = await setup(t);
  await assert.rejects(
    () => platformEnqueue("shop", { job: "nope", payload: {} }),
    (error: unknown) => String((error as Error).message).includes("EXTENSION_JOB_UNKNOWN"),
  );
});

test("extension jobs: handler executes through platform.transaction; job facts arrive", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, jobs, platformEnqueue } = await setup(t);
  const artifactShop = artifact("shop", [{ job_id: "work", handler: "run", payload_version: 2 }], {
    async run(
      ctx: never,
      payload: { key: string },
      job: { attempts: number; payloadVersion: number | null },
    ) {
      const platform = ctx as {
        platform: {
          transaction: <R>(
            run: (tx: {
              query: (
                sql: string,
                params?: readonly unknown[],
              ) => Promise<{ rows: Record<string, unknown>[] }>;
            }) => Promise<R>,
          ) => Promise<R>;
        };
      };
      return platform.platform.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO pcms_kernel_metadata (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
          [`extjob:${payload.key}`, `v${String(job.payloadVersion)}:attempt${job.attempts}`],
        );
      });
    },
  });
  const handlers = createExtensionJobHandlers({
    pool,
    catalog: {
      get: (id) => (id === "shop" ? artifactShop : undefined),
      list: () => [artifactShop],
    },
    enabledIds: async () => ["shop"],
    site: { key: "default", defaultLocale: "en" },
  });
  const handler = handlers["shop/work"];
  assert.ok(handler !== undefined, "queue type resolves to a handler");
  const record = await platformEnqueue("shop", { job: "work", payload: { key: "t1" } });
  await handler(record.payload, { job: record, attempt: 1 });
  assert.equal(await metadataValue(pool, "extjob:t1"), "v2:attempt1");
});

test("extension jobs: payload-version policy dead-letters BEFORE invocation", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, platformEnqueue } = await setup(t);
  let invoked = 0;
  const artifactShop = artifact("shop", [{ job_id: "work", handler: "run", payload_version: 2 }], {
    async run() {
      invoked += 1;
    },
  });
  const handlers = createExtensionJobHandlers({
    pool,
    catalog: {
      get: (id) => (id === "shop" ? artifactShop : undefined),
      list: () => [artifactShop],
    },
    enabledIds: async () => ["shop"],
    site: { key: "default", defaultLocale: "en" },
  });
  const jobRecord = await platformEnqueue("shop", { job: "work", payload: { key: "t2" } });
  // The queue row carries a stamp the deployed handler does not accept
  // (simulated: an older deployment enqueued v1, the code moved to v2-only).
  const stampedV1: JobRecord = { ...jobRecord, payloadVersion: 1 };
  const versionHandler = handlers["shop/work"]!;
  const outcome = await versionHandler(stampedV1.payload, { job: stampedV1, attempt: 3 });
  assert.ok(outcome !== undefined && typeof outcome === "object", "permanent classification");
  const permanent = outcome as { outcome: "permanent"; error: Error };
  assert.equal(permanent.outcome, "permanent");
  assert.equal(invoked, 0, "handler never ran");
  assert.match(permanent.error.message, /EXTENSION_JOB_PAYLOAD_VERSION_UNSUPPORTED/);
  assert.equal(await metadataValue(pool, "extjob:t2"), null);
});

test("extension jobs: accepts_payload_versions is the explicit migration policy", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, platformEnqueue } = await setup(t);
  const artifactShop = artifact(
    "shop",
    [{ job_id: "work", handler: "run", payload_version: 2, accepts_payload_versions: [1] }],
    {
      async run(_ctx: unknown, payload: { key: string }) {
        await pool.query(
          "INSERT INTO pcms_kernel_metadata (key, value) VALUES ($1, 'legacy-ok') ON CONFLICT (key) DO UPDATE SET value = 'legacy-ok'",
          [`extjob:${payload.key}`],
        );
      },
    },
  );
  const handlers = createExtensionJobHandlers({
    pool,
    catalog: {
      get: (id) => (id === "shop" ? artifactShop : undefined),
      list: () => [artifactShop],
    },
    enabledIds: async () => ["shop"],
    site: { key: "default", defaultLocale: "en" },
  });
  const record = await platformEnqueue("shop", { job: "work", payload: { key: "t3" } });
  const stampedV1: JobRecord = { ...record, payloadVersion: 1 };
  const legacyHandler = handlers["shop/work"]!;
  const outcome = await legacyHandler(stampedV1.payload, { job: stampedV1, attempt: 1 });
  assert.equal(outcome, undefined, "legacy payload version accepted by policy");
  assert.equal(await metadataValue(pool, "extjob:t3"), "legacy-ok");
});

test("extension jobs: disabled extension PARKS the job — survives, continues after re-enable", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, jobs, platformEnqueue } = await setup(t);
  const artifactShop = artifact("shop", [{ job_id: "work", handler: "run", payload_version: 2 }], {
    async run(_ctx: unknown, payload: { key: string }) {
      await pool.query(
        "INSERT INTO pcms_kernel_metadata (key, value) VALUES ($1, 'ran-after-enable') ON CONFLICT (key) DO UPDATE SET value = 'ran-after-enable'",
        [`extjob:${payload.key}`],
      );
    },
  });
  const buildHandlers = (enabled: readonly string[]) =>
    createExtensionJobHandlers({
      pool,
      catalog: {
        get: (id) => (id === "shop" ? artifactShop : undefined),
        list: () => [artifactShop],
      },
      enabledIds: async () => enabled,
      site: { key: "default", defaultLocale: "en" },
    });
  const disabled = buildHandlers([]);
  const record = await platformEnqueue("shop", { job: "work", payload: { key: "t4" } });
  // Simulate a worker claim (state RUNNING, attempt counter incremented).
  await pool.query("UPDATE jobs SET state = 'RUNNING', attempts = 1 WHERE id = $1", [record.id]);
  const claimed: JobRecord = { ...record, attempts: 1, state: "RUNNING" as const };
  const disabledHandler = disabled["shop/work"]!;
  const outcome = await disabledHandler(claimed.payload, { job: claimed, attempt: 1 });
  assert.ok(outcome !== undefined && typeof outcome === "object", "parked classification");
  assert.equal((outcome as { outcome?: string }).outcome, "parked");
  // Park through the real store: the attempt is compensated, the job stays
  // queued with the reason, no attempt burned.
  const parkedReason = (outcome as { reason?: string }).reason;
  await jobs.park(claimed.id, {
    delayMilliseconds: 0,
    ...(parkedReason === undefined ? {} : { reason: parkedReason }),
  });
  const parked = await jobs.getJob(pool, claimed.id);
  assert.equal(parked?.state, "PENDING", "parked job is still queued");
  assert.equal(parked?.attempts, 0, "parking does not burn attempts");
  assert.match(parked?.lastError ?? "", /EXTENSION_DISABLED/);
  assert.equal(await metadataValue(pool, "extjob:t4"), null, "handler never ran while disabled");

  // Re-enable: the SAME job continues (no re-enqueue needed).
  const enabledHandler = buildHandlers(["shop"])["shop/work"]!;
  const reclaimed = { ...(parked as JobRecord), attempts: 1, state: "RUNNING" as const };
  await enabledHandler(reclaimed.payload, { job: reclaimed, attempt: 1 });
  assert.equal(await metadataValue(pool, "extjob:t4"), "ran-after-enable");
});
