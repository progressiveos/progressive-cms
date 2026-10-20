// PCMS-NAV-T002 — NavigationSet + versionable tree model against PostgreSQL.
// Acceptance: create/read draft tree (Navigation spec §3/§4/§56).
// Runs the real product migrations on a disposable database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createNavigationService,
  MAX_ITEMS_PER_SET,
  type NavigationError,
  type NavigationService,
} from "@pcms/navigation";
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

async function withNav(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool, nav: NavigationService) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  const migrations = await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  assert.equal(migrations.current, "0001_public_baseline");
  await run(pool, createNavigationService(pool));
}

test("creates a set with a stable identity and reads it back", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "main", title: "Main menu" });
    assert.match(set.id, /^[0-9a-f-]{36}$/);
    assert.equal(set.key, "main");
    assert.equal(set.derivedFromSetId, null);
    assert.equal(set.archivedAt, null);

    const byKey = await nav.findSetByKey("main");
    assert.equal(byKey?.id, set.id);
    const listed = await nav.listSets();
    assert.deepEqual(
      listed.map((s) => s.key),
      ["main"],
    );
  });
});

test("set keys are unique among live sets and reused after archive", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    await nav.createSet({ key: "footer", title: "Footer" });
    await assert.rejects(
      () => nav.createSet({ key: "footer", title: "Again" }),
      (err: NavigationError) => {
        return err.code === "NAV_SET_KEY_TAKEN";
      },
    );
    const archived = await nav.archiveSet((await nav.findSetByKey("footer"))!.id);
    assert.ok(archived.archivedAt !== null);
    const recreated = await nav.createSet({ key: "footer", title: "Footer" });
    assert.notEqual(recreated.id, archived.id);
    assert.equal((await nav.listSets()).length, 1);
  });
});

test("inserts a nested draft tree and reads it back ordered", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "main", title: "Main" });
    const services = await nav.insertItem({
      setId: set.id,
      type: "group",
      label: "Services",
    });
    const audit = await nav.insertItem({
      setId: set.id,
      parentItemId: services.id,
      type: "internal_entry",
      label: "Audit",
      target: { entry_id: "01900000-0000-7000-8000-000000000001" },
    });
    const second = await nav.insertItem({
      setId: set.id,
      parentItemId: services.id,
      type: "internal_entry",
      label: "Consulting",
      target: { entry_id: "01900000-0000-7000-8000-000000000002" },
    });
    assert.equal(second.children.length, 0);

    const tree = await nav.readTree(set.id);
    const [root] = tree;
    assert.ok(root !== undefined);
    assert.equal(root.id, services.id);
    assert.equal(root.type, "group");
    assert.deepEqual(
      root.children.map((c) => c.id),
      [audit.id, second.id],
    );
    assert.deepEqual(root.children[0]?.target, {
      entry_id: "01900000-0000-7000-8000-000000000001",
    });
    assert.equal(await nav.countItems(set.id), 3);
  });
});

test("insert position opens a gap without losing siblings", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "main", title: "Main" });
    const a = await nav.insertItem({ setId: set.id, type: "separator" });
    const b = await nav.insertItem({ setId: set.id, type: "separator" });
    const c = await nav.insertItem({ setId: set.id, type: "separator", at: 1 });
    const tree = await nav.readTree(set.id);
    assert.deepEqual(
      tree.map((n) => n.id),
      [a.id, c.id, b.id],
    );
  });
});

test("system depth cap rejects overly deep insertions (spec §12)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "deep", title: "Deep" });
    let parent: { id: string } | null = null;
    for (let level = 1; level <= 10; level += 1) {
      parent = await nav.insertItem({
        setId: set.id,
        parentItemId: parent?.id ?? null,
        type: "group",
        label: `L${level}`,
      });
    }
    await assert.rejects(
      () =>
        nav.insertItem({ setId: set.id, parentItemId: parent!.id, type: "group", label: "L11" }),
      (err: NavigationError) => err.code === "NAV_DEPTH_UNSUPPORTED",
    );
  });
});

test("per-set item bound cannot be exceeded", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (pool, nav) => {
    const set = await nav.createSet({ key: "big", title: "Big" });
    await pool.query(
      `INSERT INTO navigation_items (id, set_id, parent_item_id, sibling_order, item_type)
       SELECT gen_random_uuid(), $1, NULL, g, 'separator' FROM generate_series(0, $2 - 1) g`,
      [set.id, MAX_ITEMS_PER_SET],
    );
    await assert.rejects(
      () => nav.insertItem({ setId: set.id, type: "separator" }),
      (err: NavigationError) => err.code === "NAV_TREE_TOO_LARGE",
    );
  });
});

test("sealed revisions freeze the working tree immutably", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "main", title: "Main" });
    await nav.insertItem({ setId: set.id, type: "group", label: "One" });
    const r1 = await nav.sealRevision(set.id);
    assert.equal(r1.revision, 1);
    assert.equal(r1.payload.length, 1);

    await nav.insertItem({ setId: set.id, type: "group", label: "Two" });
    const r2 = await nav.sealRevision(set.id);
    assert.equal(r2.revision, 2);
    assert.equal(r2.payload.length, 2);

    const revisions = await nav.listRevisions(set.id);
    assert.deepEqual(
      revisions.map((r) => r.revision),
      [1, 2],
    );
    const again = await nav.getRevision(set.id, 1);
    assert.equal(again?.payload.length, 1); // frozen
    assert.equal(await nav.getRevision(set.id, 3), null);
  });
});

test("unknown set ids surface NAV_SET_NOT_FOUND with a stable code", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    await assert.rejects(
      () => nav.getSet("01900000-0000-7000-8000-00000000dead"),
      (err: NavigationError) => err.code === "NAV_SET_NOT_FOUND",
    );
    await assert.rejects(
      () => nav.readTree("not-a-uuid"),
      (err: NavigationError) => err.code === "NAV_SET_NOT_FOUND",
    );
  });
});
