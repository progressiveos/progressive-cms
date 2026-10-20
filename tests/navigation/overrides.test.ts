// PCMS-NAV-T005 — base/derived navigation override model.
// Acceptance: hide/relabel/move/insert tests (Navigation spec §17/§18).
// Overrides address base items by stable Item ID; a derived set never
// copies the base tree.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  applyOverrides,
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

const ENTRY_A = "01900000-0000-7000-8000-000000000001";
const ENTRY_B = "01900000-0000-7000-8000-000000000002";

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

/** Depth-first search — derived overrides may nest items anywhere. */
function findNodeById(
  nodes: readonly NavigationItemNode[],
  id: string,
): NavigationItemNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNodeById(node.children, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function withDerived(
  t: { after: (fn: () => void) => void },
  run: (
    nav: NavigationService,
    base: { id: string },
    derived: { id: string },
    items: {
      services: NavigationItemNode;
      audit: NavigationItemNode;
      cases: NavigationItemNode;
      contact: NavigationItemNode;
    },
  ) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const nav = createNavigationService(pool);
  const base = await nav.createSet({ key: "main", title: "Main" });
  const services = await nav.insertItem({ setId: base.id, type: "group", label: "Services" });
  const audit = await nav.insertItem({
    setId: base.id,
    parentItemId: services.id,
    type: "internal_entry",
    label: "Audit",
    target: { entry_id: ENTRY_A },
  });
  const cases = await nav.insertItem({ setId: base.id, type: "group", label: "Cases" });
  const contact = await nav.insertItem({
    setId: base.id,
    type: "internal_entry",
    label: "Contact",
    target: { entry_id: ENTRY_B },
  });
  const derived = await nav.createSet({
    key: "main-mobile",
    title: "Mobile",
    derivedFromSetId: base.id,
  });
  await run(nav, base, derived, { services, audit, cases, contact });
}

test("base tree is untouched; derived set materializes without overrides", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDerived(t, async (nav, base, derived, items) => {
    const baseTree = await nav.readTree(base.id);
    assert.equal(baseTree.length, 3);
    const derivedTree = await nav.materializeTree(derived.id);
    assert.deepEqual(
      derivedTree.map((n) => n.id),
      baseTree.map((n) => n.id),
    );
    assert.equal((await nav.listOverrides(derived.id)).length, 0);
    assert.ok(items.services);
  });
});

test("hide/show override removes an item from the derived tree only", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDerived(t, async (nav, base, derived, items) => {
    await nav.addOverride({
      setId: derived.id,
      targetItemId: items.cases.id,
      op: "hide",
      payload: {},
    });
    const tree = await nav.materializeTree(derived.id);
    assert.deepEqual(
      tree.map((n) => n.label),
      ["Services", "Contact"],
    );
    // Base keeps the item — no mutation of the shared tree.
    assert.equal((await nav.readTree(base.id)).length, 3);

    await nav.addOverride({
      setId: derived.id,
      targetItemId: items.cases.id,
      op: "show",
      payload: {},
    });
    const restored = await nav.materializeTree(derived.id);
    assert.equal(restored.length, 3);
  });
});

test("hide removes the hidden subtree (children drop with the parent)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDerived(t, async (nav, _base, derived, items) => {
    await nav.addOverride({
      setId: derived.id,
      targetItemId: items.services.id,
      op: "hide",
      payload: {},
    });
    const tree = await nav.materializeTree(derived.id);
    assert.deepEqual(
      tree.flatMap((n) => [n.label, ...n.children.map((c) => c.label)]).filter(Boolean),
      ["Cases", "Contact"],
    );
  });
});

test("relabel changes the derived label, base label stays", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDerived(t, async (nav, base, derived, items) => {
    await nav.addOverride({
      setId: derived.id,
      targetItemId: items.contact.id,
      op: "relabel",
      payload: { label: "Написать нам" },
    });
    const tree = await nav.materializeTree(derived.id);
    const contact = tree.find((n) => n.id === items.contact.id);
    assert.equal(contact?.label, "Написать нам");
    const baseTree = await nav.readTree(base.id);
    assert.equal(baseTree.find((n) => n.id === items.contact.id)?.label, "Contact");
  });
});

test("reorder and move overrides restructure the derived tree", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDerived(t, async (nav, _base, derived, items) => {
    await nav.addOverride({
      setId: derived.id,
      targetItemId: items.contact.id,
      op: "reorder",
      payload: { at: 0 },
    });
    await nav.addOverride({
      setId: derived.id,
      targetItemId: items.audit.id,
      op: "move",
      payload: { parent_item_id: null, at: 2 },
    });
    const tree = await nav.materializeTree(derived.id);
    assert.deepEqual(
      tree.map((n) => n.label),
      ["Contact", "Services", "Audit", "Cases"],
    );
    // Audit was lifted out of Services; Services has no children anymore.
    assert.equal(tree.find((n) => n.label === "Services")?.children.length, 0);
    assert.deepEqual(findNodeById(tree, items.audit.id)?.target, { entry_id: ENTRY_A });
  });
});

test("insert override adds a derived-only item with a stable ID", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDerived(t, async (nav, base, derived, items) => {
    await nav.addOverride({
      setId: derived.id,
      targetItemId: items.contact.id,
      op: "insert",
      payload: {
        item: {
          type: "action",
          label: "Позвонить",
          target: { kind: "phone", phone: "+74951234567" },
        },
        parent_item_id: null,
        at: 3,
      },
    });
    const tree = await nav.materializeTree(derived.id);
    assert.equal(tree.length, 4);
    const inserted = tree[3];
    assert.equal(inserted?.label, "Позвонить");
    assert.equal(inserted?.type, "action");
    // Base tree unchanged.
    assert.equal((await nav.readTree(base.id)).length, 3);
    // The inserted item id is stable across materializations.
    const again = await nav.materializeTree(derived.id);
    assert.equal(again[3]?.id, inserted?.id);
  });
});

test("replace_target override repoints an internal entry (spec §17)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDerived(t, async (nav, _base, derived, items) => {
    await nav.addOverride({
      setId: derived.id,
      targetItemId: items.audit.id,
      op: "replace_target",
      payload: { target: { entry_id: ENTRY_B } },
    });
    const tree = await nav.materializeTree(derived.id);
    const audit = findNodeById(tree, items.audit.id);
    assert.deepEqual(audit?.target, { entry_id: ENTRY_B });
  });
});

test("override ledger validates targets and payloads on write", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDerived(t, async (nav, _base, derived, items) => {
    // Independent sets take no overrides.
    await assert.rejects(
      () =>
        nav.addOverride({
          setId: _base.id,
          targetItemId: items.contact.id,
          op: "hide",
          payload: {},
        }),
      (err: NavigationError) => err.code === "NAV_SET_NOT_DERIVED",
    );
    // Target must live in the base set.
    await assert.rejects(
      () =>
        nav.addOverride({
          setId: derived.id,
          targetItemId: "01900000-0000-7000-8000-00000000beef",
          op: "hide",
          payload: {},
        }),
      (err: NavigationError) => err.code === "NAV_OVERRIDE_TARGET_MISSING",
    );
    // Unknown op / malformed payloads.
    await assert.rejects(
      () =>
        nav.addOverride({
          setId: derived.id,
          targetItemId: items.contact.id,
          op: "recolour" as never,
          payload: {},
        }),
      (err: NavigationError) => err.code === "NAV_OVERRIDE_INVALID",
    );
    await assert.rejects(
      () =>
        nav.addOverride({
          setId: derived.id,
          targetItemId: items.contact.id,
          op: "relabel",
          payload: {},
        }),
      (err: NavigationError) => err.code === "NAV_OVERRIDE_INVALID",
    );
    // Insert items pass the same validation as regular items.
    await assert.rejects(
      () =>
        nav.addOverride({
          setId: derived.id,
          targetItemId: items.contact.id,
          op: "insert",
          payload: {
            item: {
              type: "external_url",
              label: "bad",
              target: { url: "javascript:x", target: "_self", rel: [] },
            },
          },
        }),
      (err: NavigationError) => err.code === "NAV_ITEM_PAYLOAD_INVALID",
    );
  });
});

test("derived sets cannot derive from derived sets", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDerived(t, async (nav, _base, derived) => {
    await assert.rejects(
      () => nav.createSet({ key: "main-mobile-v2", title: "V2", derivedFromSetId: derived.id }),
      (err: NavigationError) => err.code === "NAV_SET_BASE_DERIVED",
    );
  });
});

test("pure override algebra: applyOverrides covers the operation set", () => {
  const base = [
    {
      id: "a",
      type: "group" as const,
      label: "A",
      target: null,
      visibility: "always" as const,
      uiIntent: null,
      children: [
        {
          id: "b",
          type: "separator" as const,
          label: null,
          target: null,
          visibility: "always" as const,
          uiIntent: null,
          children: [],
        },
      ],
    },
    {
      id: "c",
      type: "separator" as const,
      label: null,
      target: null,
      visibility: "always" as const,
      uiIntent: null,
      children: [],
    },
  ];
  const result = applyOverrides(base, [
    { id: "o1", targetItemId: "c", op: "reorder", payload: { at: 0 } },
    { id: "o2", targetItemId: "a", op: "relabel", payload: { label: "Alpha" } },
  ]);
  assert.deepEqual(
    result.map((n) => [n.id, n.label]),
    [
      ["c", null],
      ["a", "Alpha"],
    ],
  );
  assert.equal(result[1]?.children[0]?.id, "b");
});
