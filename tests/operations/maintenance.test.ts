// PCMS-OPS-T118 — Maintenance Mode core surfaces: state service (singleton
// upsert, honest absence on pre-M15 databases) and the REST operations
// (permission gating, toggle audit). Browser-level maintenance behavior is
// covered by tests/browser/admin/maintenance.spec.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  loadMigrations,
  migrateDatabase,
  systemClock,
} from "@pcms/core";
import { readMaintenanceState, updateMaintenanceState } from "@pcms/operations";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

async function createMigratedPool(t: import("node:test").TestContext): Promise<DbPool> {
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

test("maintenance state: seeded defaults, partial updates stamp actor", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await createMigratedPool(t);

  const initial = await readMaintenanceState(pool);
  assert.ok(initial !== null);
  assert.equal(initial.enabled, false, "fresh install starts PUBLIC");
  assert.ok(initial.title.length > 0);
  assert.ok(initial.promoUrl.startsWith("https://"));

  const updated = await updateMaintenanceState(pool, systemClock, { enabled: true }, "user:op-1");
  assert.equal(updated.enabled, true);
  assert.equal(updated.updatedBy, "user:op-1");

  const edited = await updateMaintenanceState(
    pool,
    systemClock,
    { title: "Плановые работы" },
    "user:op-2",
  );
  assert.equal(edited.title, "Плановые работы");
  assert.equal(edited.enabled, true, "a settings edit never flips the toggle");
  assert.equal(edited.updatedBy, "user:op-2");
});

test("maintenance state: absent table reads as null (pre-M15 database)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 1 });
  t.after(() => {
    void pool.end();
  });
  assert.equal(await readMaintenanceState(pool), null);
});

test("maintenance REST: gated on site.maintenance, audited on toggle", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await createApiFixture(t);
  const api = await import("@pcms/api");
  const owner = apiContextOf(ownerActor());

  const read = await api.getMaintenanceStateOp(fixture.app, owner);
  assert.equal(read.enabled, false);

  const enabled = await api.updateMaintenanceStateOp(fixture.app, owner, { enabled: true });
  assert.equal(enabled.enabled, true);

  // An actor without site.maintenance cannot read or toggle (default deny).
  const editor = apiContextOf(scopedActor(["content.read"], "editor-1"));
  await assert.rejects(() => api.getMaintenanceStateOp(fixture.app, editor));
  await assert.rejects(() => api.updateMaintenanceStateOp(fixture.app, editor, { enabled: false }));

  // Toggle is audited in the M08 security-event stream.
  const events = await fixture.app.pool.query<{ event_type: string }>(
    "SELECT event_type FROM auth_security_events WHERE event_type LIKE 'MAINTENANCE%' ORDER BY created_at",
  );
  assert.deepEqual(
    events.rows.map((row) => row.event_type),
    ["MAINTENANCE_ENABLED"],
  );
});
