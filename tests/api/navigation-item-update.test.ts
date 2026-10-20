// Navigation item update (owner UX gap A): an existing menu item must be
// editable in the working tree — label, type and target — through the same
// payload validation as insert. Versioned snapshots stay immutable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { createNavigationService, type NavigationService } from "@pcms/navigation";
import {
  assertBaseReachable,
  connectionInfo,
  createTestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

async function poolFor(t: { after: (fn: () => void) => void }): Promise<DbPool> {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

async function serviceWithMenu(t: { after: (fn: () => void) => void }) {
  const pool = await poolFor(t);
  const navigation: NavigationService = createNavigationService(pool);
  const set = await navigation.createSet({ key: "main", title: "Основное меню" });
  const item = await navigation.insertItem({
    setId: set.id,
    type: "internal_entry",
    label: "Блог",
    target: { kind: "internal_entry", entry_id: "01a00000-0000-7000-8000-00000000000a" },
  });
  return { navigation, setId: set.id, item };
}

test("navigation updateItem: label/target editable, item id preserved", {
  skip: DB_SKIP,
}, async (t) => {
  const { navigation, setId, item } = await serviceWithMenu(t);
  const updated = await navigation.updateItem({
    setId,
    itemId: item.id,
    type: "external_url",
    label: "Наш блог",
    target: {
      kind: "external_url",
      url: "https://site.example.test/blog/",
      target: "_self",
      rel: ["noopener"],
    },
  });
  assert.equal(updated.id, item.id, "edit must keep the stable item id");
  assert.equal(updated.label, "Наш блог");
  assert.equal(updated.type, "external_url");
});

test("navigation updateItem: rejects invalid target payload like insert", {
  skip: DB_SKIP,
}, async (t) => {
  const { navigation, setId, item } = await serviceWithMenu(t);
  await assert.rejects(
    () =>
      navigation.updateItem({
        setId,
        itemId: item.id,
        type: "external_url",
        label: "x",
        target: { kind: "external_url", url: "", target: "_self", rel: [] },
      }),
    (error: unknown) => (error as { code?: string }).code === "NAV_ITEM_PAYLOAD_INVALID",
  );
  await assert.rejects(
    () => navigation.updateItem({ setId, itemId: item.id, type: "external_url", label: "y" }),
    (error: unknown) => (error as { code?: string }).code === "NAV_ITEM_PAYLOAD_INVALID",
  );
});
