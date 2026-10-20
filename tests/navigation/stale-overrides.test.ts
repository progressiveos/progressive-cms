// PCMS-NAV-T006 — stale override conflict detection (Navigation spec §19).
// When a base item disappears, its derived overrides must become explicit
// machine-readable conflicts — never silently applied to another item.
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

async function withDerived(
  t: { after: (fn: () => void) => void },
  run: (
    nav: NavigationService,
    base: { id: string },
    derived: { id: string },
    items: {
      audit: NavigationItemNode;
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
  const group = await nav.insertItem({ setId: base.id, type: "group", label: "Company" });
  const audit = await nav.insertItem({
    setId: base.id,
    parentItemId: group.id,
    type: "internal_entry",
    label: "Audit",
    target: { entry_id: "01900000-0000-7000-8000-000000000001" },
  });
  const contact = await nav.insertItem({
    setId: base.id,
    type: "internal_entry",
    label: "Contact",
    target: { entry_id: "01900000-0000-7000-8000-000000000002" },
  });
  const derived = await nav.createSet({
    key: "main-mobile",
    title: "Mobile",
    derivedFromSetId: base.id,
  });
  await run(nav, base, derived, { audit, contact });
}

test("deleting the base item turns its override into NAV_OVERRIDE_STALE", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDerived(t, async (nav, base, derived, items) => {
    await nav.addOverride({
      setId: derived.id,
      targetItemId: items.contact.id,
      op: "relabel",
      payload: { label: "Контакты" },
    });
    assert.equal((await nav.materializeTree(derived.id)).length, 2);

    // Base editor deletes the item the override addresses.
    await nav.deleteItem({ setId: base.id, itemId: items.contact.id });

    await assert.rejects(
      () => nav.materializeTree(derived.id),
      (err: NavigationError) => {
        assert.equal(err.code, "NAV_OVERRIDE_STALE");
        assert.equal(err.details.override_id !== undefined, true);
        assert.equal(err.details.target_item_id, items.contact.id);
        return true;
      },
    );
    // Base tree itself still materializes fine — the conflict is derived-only.
    assert.equal((await nav.readTree(base.id)).length, 1);
  });
});

test("listStaleOverrides reports conflicts machine-readably, non-throwing", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDerived(t, async (nav, base, derived, items) => {
    await nav.addOverride({
      setId: derived.id,
      targetItemId: items.contact.id,
      op: "hide",
      payload: {},
    });
    await nav.addOverride({
      setId: derived.id,
      targetItemId: items.audit.id,
      op: "relabel",
      payload: { label: "Audit (RU)" },
    });
    assert.deepEqual(await nav.listStaleOverrides(derived.id), []);

    await nav.deleteItem({ setId: base.id, itemId: items.contact.id });
    const stale = await nav.listStaleOverrides(derived.id);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]?.target_item_id, items.contact.id);
    assert.equal(stale[0]?.op, "hide");
    assert.match(stale[0]?.override_id ?? "", /^[0-9a-f-]{36}$/);

    // Deleting the remaining base item makes the second override stale too.
    await nav.deleteItem({ setId: base.id, itemId: items.audit.id });
    assert.equal((await nav.listStaleOverrides(derived.id)).length, 2);
  });
});

test("overrides never silently re-target: another item with the same label is untouched", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDerived(t, async (nav, base, derived, items) => {
    await nav.addOverride({
      setId: derived.id,
      targetItemId: items.contact.id,
      op: "relabel",
      payload: { label: "Old contact label" },
    });
    await nav.deleteItem({ setId: base.id, itemId: items.contact.id });
    // A new item is inserted with the same label but a fresh stable ID.
    const replacement = await nav.insertItem({
      setId: base.id,
      type: "internal_entry",
      label: "Contact",
      target: { entry_id: "01900000-0000-7000-8000-000000000009" },
    });
    // The stale override must NOT apply to the replacement item.
    await assert.rejects(
      () => nav.materializeTree(derived.id),
      (err: NavigationError) => err.code === "NAV_OVERRIDE_STALE",
    );
    const stale = await nav.listStaleOverrides(derived.id);
    assert.deepEqual(
      stale.map((s) => s.target_item_id),
      [items.contact.id],
    );
    assert.notEqual(replacement.id, items.contact.id);
  });
});

test("independent sets have no stale overrides", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDerived(t, async (nav, base) => {
    assert.deepEqual(await nav.listStaleOverrides(base.id), []);
  });
});
