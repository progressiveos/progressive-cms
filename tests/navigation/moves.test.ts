// PCMS-NAV-T004 — stable item IDs, reorder/move, cycle protection.
// Acceptance: deep reorder tests (Navigation spec §4/§13/§14).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createNavigationService,
  type NavigationError,
  type NavigationItemNode,
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
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await run(pool, createNavigationService(pool));
}

function ids(nodes: readonly NavigationItemNode[]): string[] {
  return nodes.map((n) => n.id);
}

test("reordering within a parent preserves stable item IDs (spec §4)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "main", title: "Main" });
    const a = await nav.insertItem({ setId: set.id, type: "group", label: "A" });
    const b = await nav.insertItem({ setId: set.id, type: "group", label: "B" });
    const c = await nav.insertItem({ setId: set.id, type: "group", label: "C" });

    await nav.moveItem({ setId: set.id, itemId: c.id, parentItemId: null, at: 0 });
    assert.deepEqual(ids(await nav.readTree(set.id)), [c.id, a.id, b.id]);

    // Moving to the end (at omitted) appends after remaining siblings.
    await nav.moveItem({ setId: set.id, itemId: c.id, parentItemId: null });
    assert.deepEqual(ids(await nav.readTree(set.id)), [a.id, b.id, c.id]);

    // IDs never change across any number of reorder operations.
    await nav.moveItem({ setId: set.id, itemId: a.id, parentItemId: null, at: 2 });
    assert.deepEqual(ids(await nav.readTree(set.id)), [b.id, c.id, a.id]);
  });
});

test("subtree moves keep the nested structure and IDs intact", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "main", title: "Main" });
    const services = await nav.insertItem({ setId: set.id, type: "group", label: "Services" });
    const audit = await nav.insertItem({
      setId: set.id,
      parentItemId: services.id,
      type: "internal_entry",
      label: "Audit",
      target: { entry_id: "01900000-0000-7000-8000-000000000001" },
    });
    const cases = await nav.insertItem({ setId: set.id, type: "group", label: "Cases" });
    const deep = await nav.insertItem({
      setId: set.id,
      parentItemId: audit.id,
      type: "anchor",
      label: "Details",
      target: { anchor: "details", entry_id: null },
    });

    await nav.moveItem({ setId: set.id, itemId: services.id, parentItemId: cases.id, at: 0 });
    const tree = await nav.readTree(set.id);
    assert.deepEqual(ids(tree), [cases.id]);
    const casesNode = tree[0];
    assert.ok(casesNode !== undefined);
    assert.deepEqual(ids(casesNode.children), [services.id]);
    // The moved subtree keeps its full internal structure and IDs.
    const servicesNode = casesNode.children[0];
    assert.ok(servicesNode !== undefined);
    assert.deepEqual(ids(servicesNode.children), [audit.id]);
    assert.equal(servicesNode.children[0]?.children[0]?.id, deep.id);
  });
});

test("cycles are rejected: item cannot become its own ancestor (spec §14)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "main", title: "Main" });
    const a = await nav.insertItem({ setId: set.id, type: "group", label: "A" });
    const b = await nav.insertItem({
      setId: set.id,
      parentItemId: a.id,
      type: "group",
      label: "B",
    });
    const c = await nav.insertItem({
      setId: set.id,
      parentItemId: b.id,
      type: "group",
      label: "C",
    });

    await assert.rejects(
      () => nav.moveItem({ setId: set.id, itemId: a.id, parentItemId: a.id }),
      (err: NavigationError) => err.code === "NAV_MOVE_CYCLE",
    );
    await assert.rejects(
      () => nav.moveItem({ setId: set.id, itemId: a.id, parentItemId: c.id }),
      (err: NavigationError) => err.code === "NAV_MOVE_CYCLE",
    );
    // The failed moves left the tree untouched.
    assert.deepEqual(ids(await nav.readTree(set.id)), [a.id]);
  });
});

test("moves that would exceed the depth cap are rejected atomically", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "deep", title: "Deep" });
    let tail: NavigationItemNode | null = null;
    const chain: NavigationItemNode[] = [];
    for (let level = 1; level <= 6; level += 1) {
      tail = await nav.insertItem({
        setId: set.id,
        parentItemId: tail?.id ?? null,
        type: "group",
        label: `L${level}`,
      });
      chain.push(tail);
    }
    const other = await nav.insertItem({ setId: set.id, type: "group", label: "Other" });
    let otherTail: NavigationItemNode = other;
    for (let level = 1; level <= 5; level += 1) {
      otherTail = await nav.insertItem({
        setId: set.id,
        parentItemId: otherTail.id,
        type: "group",
        label: `O${level}`,
      });
    }
    // Moving the 6-deep chain under the 6-deep other branch would reach 12.
    await assert.rejects(
      () => nav.moveItem({ setId: set.id, itemId: chain[0]!.id, parentItemId: otherTail.id }),
      (err: NavigationError) => err.code === "NAV_DEPTH_UNSUPPORTED",
    );
    assert.deepEqual(ids(await nav.readTree(set.id)).sort(), [chain[0]!.id, other.id].sort());
  });
});

test("delete removes the whole subtree and frees the IDs forever", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "main", title: "Main" });
    const keep = await nav.insertItem({ setId: set.id, type: "group", label: "Keep" });
    const drop = await nav.insertItem({ setId: set.id, type: "group", label: "Drop" });
    await nav.insertItem({ setId: set.id, parentItemId: drop.id, type: "group", label: "Child" });
    await nav.deleteItem({ setId: set.id, itemId: drop.id });
    const tree = await nav.readTree(set.id);
    assert.deepEqual(ids(tree), [keep.id]);
    assert.equal(await nav.countItems(set.id), 1);
    await assert.rejects(
      () => nav.deleteItem({ setId: set.id, itemId: drop.id }),
      (err: NavigationError) => err.code === "NAV_ITEM_NOT_FOUND",
    );
  });
});

test("moves of unknown items fail with NAV_ITEM_NOT_FOUND", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "main", title: "Main" });
    await assert.rejects(
      () =>
        nav.moveItem({
          setId: set.id,
          itemId: "01900000-0000-7000-8000-00000000dead",
          parentItemId: null,
        }),
      (err: NavigationError) => err.code === "NAV_ITEM_NOT_FOUND",
    );
  });
});
