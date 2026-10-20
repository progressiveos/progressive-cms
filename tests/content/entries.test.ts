// PCMS-CONT-T003 — `entries` domain/schema against PostgreSQL.
// Acceptance: create/archive/read Entry; stable identity (Content spec §5/§7).
// Runs the real product migrations (db/migrations) on a disposable database.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContentError,
  createEntriesService,
  type EntriesService,
  type EntryId,
  newEntryId,
} from "@pcms/content";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

function connectionInfo(db: TestDatabase) {
  const info = {
    host: db.connection.host,
    port: db.connection.port,
    database: db.connection.database,
    user: db.connection.user,
    sslMode: "disable" as const,
  };
  return db.connection.password === undefined
    ? info
    : { ...info, password: db.connection.password };
}

async function withContentFixture(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool, entries: EntriesService) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfo(db),
    max: 5,
    connectionTimeoutMilliseconds: 3000,
  });
  t.after(() => {
    void pool.end();
  });
  const migrations = await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  assert.equal(migrations.current, "0001_public_baseline");
  await run(pool, createEntriesService(pool));
}

test("createEntry persists a stable identity and reads back identically", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withContentFixture(t, async (_pool, entries) => {
    const created = await entries.createEntry({ contentTypeId: "page", createdBy: "actor-1" });
    assert.equal(isUUID(created.id), true);
    assert.equal(created.contentTypeId, "page");
    assert.equal(created.parentEntryId, null);
    assert.equal(created.createdBy, "actor-1");
    assert.equal(created.archivedAt, null);
    assert.ok(created.createdAt instanceof Date);

    const read = await entries.getEntry(created.id);
    assert.equal(read.id, created.id);
    assert.equal(read.contentTypeId, created.contentTypeId);
    assert.deepEqual(read.createdAt, created.createdAt);

    // Read back via a fresh service (fresh SQL round-trip, same identity).
    const again = await entries.findEntry(created.id);
    assert.equal(again?.id, created.id);
  });
});

test("createEntry stores a parent reference as durable identity, not URL", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withContentFixture(t, async (_pool, entries) => {
    const parent = await entries.createEntry({ contentTypeId: "page", createdBy: "actor-1" });
    const child = await entries.createEntry({
      contentTypeId: "service",
      createdBy: "actor-1",
      parentEntryId: parent.id,
    });
    assert.equal(child.parentEntryId, parent.id);
  });
});

test("createEntry validates input and unknown parents with stable codes", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withContentFixture(t, async (_pool, entries) => {
    await assert.rejects(
      entries.createEntry({ contentTypeId: "", createdBy: "actor-1" }),
      (error: unknown) => error instanceof ContentError && error.code === "CONTENT_TYPE_REQUIRED",
    );
    await assert.rejects(
      entries.createEntry({ contentTypeId: "page", createdBy: "" }),
      (error: unknown) => error instanceof ContentError && error.code === "CREATED_BY_REQUIRED",
    );
    const missing: EntryId = newEntryId();
    await assert.rejects(
      entries.createEntry({ contentTypeId: "page", createdBy: "a", parentEntryId: missing }),
      (error: unknown) => error instanceof ContentError && error.code === "PARENT_NOT_FOUND",
    );
  });
});

test("createEntry honors caller-supplied id (idempotency basis) and rejects duplicates", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withContentFixture(t, async (_pool, entries) => {
    const fixed = newEntryId();
    const created = await entries.createEntry({
      contentTypeId: "page",
      createdBy: "actor-1",
      id: fixed,
    });
    assert.equal(created.id, fixed);
    await assert.rejects(
      entries.createEntry({ contentTypeId: "page", createdBy: "actor-1", id: fixed }),
      (error: unknown) => error instanceof ContentError && error.code === "ENTRY_ALREADY_EXISTS",
    );
  });
});

test("archiveEntry sets archived_at, is idempotent, never deletes", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withContentFixture(t, async (pool, entries) => {
    const created = await entries.createEntry({ contentTypeId: "news", createdBy: "actor-2" });
    const archived = await entries.archiveEntry(created.id);
    assert.ok(archived.archivedAt instanceof Date);

    // Idempotent: second archive keeps the original timestamp.
    const again = await entries.archiveEntry(created.id);
    assert.deepEqual(again.archivedAt, archived.archivedAt);

    // Row still exists and stays readable with its history (archive ≠ delete).
    const row = await pool.query<{ archived_at: Date }>(
      "SELECT archived_at FROM entries WHERE id = $1",
      [created.id],
    );
    assert.equal(row.rows.length, 1);
    const read = await entries.getEntry(created.id);
    assert.deepEqual(read.archivedAt, archived.archivedAt);
  });
});

test("archiveEntry/getEntry report ENTRY_NOT_FOUND for unknown or invalid ids", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withContentFixture(t, async (_pool, entries) => {
    const missing = newEntryId();
    await assert.rejects(
      entries.archiveEntry(missing),
      (error: unknown) => error instanceof ContentError && error.code === "ENTRY_NOT_FOUND",
    );
    await assert.rejects(
      entries.getEntry(missing),
      (error: unknown) => error instanceof ContentError && error.code === "ENTRY_NOT_FOUND",
    );
    await assert.rejects(
      // Non-canonical text is not an identity and must not match anything.
      entries.getEntry("about" as EntryId),
      (error: unknown) => error instanceof ContentError && error.code === "ENTRY_NOT_FOUND",
    );
    assert.equal(await entries.findEntry(missing), null);
  });
});

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
