// PCMS-OPS-T008 — health live/ready: liveness independent of PostgreSQL,
// readiness honestly probing dependencies, public bodies leak nothing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildWebRuntime } from "../../apps/web/src/main.js";
import { cmsProcessEnv } from "../helpers/process-env.js";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

async function runtimeFor(
  t: { after: (fn: () => void) => void },
  db: { host: string; port: number; database: string; user: string; password: string | undefined },
): Promise<Awaited<ReturnType<typeof buildWebRuntime>>> {
  const dir = mkdtempSync(join(tmpdir(), "pcms-health-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const config = {
    nodeEnv: "test",
    http: { port: 0 },
    db: {
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.user,
      sslMode: "disable",
      passwordSecretRef: "db.password",
    },
    log: { level: "info" },
    secrets: { "db.password": { env: "PCMS_SECRET_DB_PASSWORD" } },
  };
  const configPath = join(dir, "pcms.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  const runtime = await buildWebRuntime({
    file: configPath,
    env: cmsProcessEnv({ PCMS_SECRET_DB_PASSWORD: db.password ?? "" }),
  });
  t.after(() => {
    void runtime.pool.end();
  });
  return runtime;
}

test("live answers 200 and readiness probes the real database", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const runtime = await runtimeFor(t, db.connection);

  const live = await runtime.fastify.inject({ method: "GET", url: "/health/live" });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), { status: "live" });

  const ready = await runtime.fastify.inject({ method: "GET", url: "/health/ready" });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { status: "ready" });
});

test("readiness reports not_ready (503) while live stays 200 when the DB is down", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  // nothing listens on port 1 — dependencies unusable
  const runtime = await runtimeFor(t, { ...db.connection, port: 1 });

  const live = await runtime.fastify.inject({ method: "GET", url: "/health/live" });
  assert.equal(live.statusCode, 200, "liveness must not depend on PostgreSQL");
  assert.deepEqual(live.json(), { status: "live" });

  const ready = await runtime.fastify.inject({ method: "GET", url: "/health/ready" });
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.json(), { status: "not_ready" });
});

test("public health responses expose no internals", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const runtime = await runtimeFor(t, { ...db.connection, port: 1 }); // failing dependency

  for (const url of ["/health/live", "/health/ready"]) {
    const response = await runtime.fastify.inject({ method: "GET", url });
    const body = response.body;
    for (const forbidden of ["password", "host", "user", "db", "error", "check", "config"]) {
      assert.equal(
        body.toLowerCase().includes(forbidden),
        false,
        `${url} must not contain "${forbidden}": ${body}`,
      );
    }
    assert.match(response.headers["content-type"] ?? "", /application\/json/);
  }
});
