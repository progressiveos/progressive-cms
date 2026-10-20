// PCMS-CONT-T004 — Content Tree parent model + cycle protection.
// Acceptance: cannot create a parent cycle; move tests (Content spec §6).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContentError,
  type ContentTreeService,
  createContentTreeService,
  createEntriesService,
  type EntriesService,
  type EntryId,
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

interface Fixture {
  pool: DbPool;
  entries: EntriesService;
  tree: ContentTreeService;
}

async function withTreeFixture(
  t: { after: (fn: () => void) => void },
  run: (fixture: Fixture) => Promise<void>,
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
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await run({
    pool,
    entries: createEntriesService(pool),
    tree: createContentTreeService(pool),
  });
}

async function parentOf(pool: DbPool, id: EntryId): Promise<EntryId | null> {
  const row = await pool.query<{ parent_entry_id: string | null }>(
    "SELECT parent_entry_id FROM entries WHERE id = $1",
    [id],
  );
  return (row.rows[0]?.parent_entry_id as EntryId | undefined) ?? null;
}

test("deep chain reports ancestors root-first and supports moves within the tree", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withTreeFixture(t, async ({ entries, tree }) => {
    const root = await entries.createEntry({ contentTypeId: "page", createdBy: "actor-1" });
    const child = await entries.createEntry({
      contentTypeId: "page",
      createdBy: "actor-1",
      parentEntryId: root.id,
    });
    const grandchild = await entries.createEntry({
      contentTypeId: "service",
      createdBy: "actor-1",
      parentEntryId: child.id,
    });

    assert.deepEqual(await tree.getAncestors(grandchild.id), [root.id, child.id]);
    assert.deepEqual(await tree.getAncestors(child.id), [root.id]);
    assert.deepEqual(await tree.getAncestors(root.id), []);

    // Legal move: grandchild becomes a direct child of the root.
    await tree.moveEntry(grandchild.id, root.id);
    assert.deepEqual(await tree.getAncestors(grandchild.id), [root.id]);
  });
});

test("moveEntry rejects self-parenting with a stable cycle code", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withTreeFixture(t, async ({ entries, tree }) => {
    const root = await entries.createEntry({ contentTypeId: "page", createdBy: "actor-1" });
    await assert.rejects(
      tree.moveEntry(root.id, root.id),
      (error: unknown) => error instanceof ContentError && error.code === "ENTRY_CYCLE",
    );
  });
});

test("moveEntry rejects moves into the moved entry's own subtree", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withTreeFixture(t, async ({ entries, tree, pool }) => {
    const root = await entries.createEntry({ contentTypeId: "page", createdBy: "actor-1" });
    const child = await entries.createEntry({
      contentTypeId: "page",
      createdBy: "actor-1",
      parentEntryId: root.id,
    });
    const grandchild = await entries.createEntry({
      contentTypeId: "page",
      createdBy: "actor-1",
      parentEntryId: child.id,
    });

    // root → under grandchild would make root a descendant of itself.
    await assert.rejects(
      tree.moveEntry(root.id, grandchild.id),
      (error: unknown) => error instanceof ContentError && error.code === "ENTRY_CYCLE",
    );
    // The direct child also lies in root's future subtree — same violation.
    await assert.rejects(
      tree.moveEntry(root.id, child.id),
      (error: unknown) => error instanceof ContentError && error.code === "ENTRY_CYCLE",
    );
    // Nothing changed by the rejected moves.
    assert.equal(await parentOf(pool, root.id), null);
  });
});

test("moveEntry supports reparenting and moving back to root", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withTreeFixture(t, async ({ entries, tree, pool }) => {
    const a = await entries.createEntry({ contentTypeId: "page", createdBy: "actor-1" });
    const b = await entries.createEntry({ contentTypeId: "page", createdBy: "actor-1" });
    const child = await entries.createEntry({
      contentTypeId: "page",
      createdBy: "actor-1",
      parentEntryId: a.id,
    });

    await tree.moveEntry(child.id, b.id);
    assert.equal(await parentOf(pool, child.id), b.id);

    await tree.moveEntry(child.id, null);
    assert.equal(await parentOf(pool, child.id), null);
    assert.deepEqual(await tree.getAncestors(child.id), []);
  });
});

test("moveEntry reports missing entries/parents with stable codes", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withTreeFixture(t, async ({ entries, tree }) => {
    const existing = await entries.createEntry({ contentTypeId: "page", createdBy: "actor-1" });
    const missing = "00000000-0000-7000-8000-000000000000" as EntryId;

    await assert.rejects(
      tree.moveEntry(existing.id, missing),
      (error: unknown) => error instanceof ContentError && error.code === "PARENT_NOT_FOUND",
    );
    await assert.rejects(
      tree.moveEntry(missing, existing.id),
      (error: unknown) => error instanceof ContentError && error.code === "ENTRY_NOT_FOUND",
    );
  });
});

test("Content Tree is independent: the entries model has no URL/navigation columns", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withTreeFixture(t, async ({ pool, entries, tree }) => {
    const root = await entries.createEntry({ contentTypeId: "page", createdBy: "actor-1" });
    const child = await entries.createEntry({
      contentTypeId: "page",
      createdBy: "actor-1",
      parentEntryId: root.id,
    });
    await tree.moveEntry(child.id, null);
    // Moving in the Content Tree physically cannot rewrite URLs or navigation:
    // no such columns exist on the model (Content spec §6 — independent models).
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'entries'`,
    );
    const names = columns.rows.map((row) => row.column_name).sort();
    assert.deepEqual(names, [
      "archived_at",
      "content_type_id",
      "created_at",
      "created_by",
      // Structural folders (migration 1702): the editorial kind tag is an
      // identity attribute — still no URL or navigation columns on the model.
      "entry_kind",
      "id",
      // Opt-in multilingual (migration 1701): the language version tag and
      // translation-group anchor are identity attributes — still no URL or
      // navigation columns on the model.
      "locale",
      "parent_entry_id",
      // Theme Contract §12: per-entry template assignment (1703) — still an
      // identity attribute; no URL or navigation columns on the model.
      "template_key",
      "translation_group_id",
    ]);
  });
});
