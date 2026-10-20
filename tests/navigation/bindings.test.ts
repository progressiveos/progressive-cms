// PCMS-NAV-T007 — placement bindings + theme depth/type validation.
// Acceptance: shared and independent menus validated (Navigation spec §15–§20;
// Theme Contract §22–§24). Placement descriptors are plain data mirroring the
// theme manifest — the composition layer extracts them from @pcms/themes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createNavigationService,
  createPlacementBindingService,
  type NavigationService,
  type PlacementBindingIssue,
  type PlacementBindingService,
  type PlacementDescriptor,
} from "@pcms/navigation";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const ENTRY_A = "01900000-0000-7000-8000-000000000001";

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

/** Mirrors the reference theme's header placements (theme.json). */
const HEADER_DESCRIPTORS: readonly PlacementDescriptor[] = [
  {
    id: "header.primary",
    label: "header.primary",
    description: null,
    required: true,
    maxDepth: 3,
    supportedItemTypes: ["internal_entry", "external_url", "group"],
    fallback: null,
  },
  {
    id: "header.compact",
    label: "header.compact",
    description: null,
    required: false,
    maxDepth: 1,
    supportedItemTypes: ["internal_entry", "external_url"],
    fallback: "header.primary",
  },
  {
    id: "header.mobile",
    label: "header.mobile",
    description: null,
    required: true,
    maxDepth: 3,
    supportedItemTypes: ["internal_entry", "group", "separator"],
    fallback: null,
  },
];

async function withBindings(
  t: { after: (fn: () => void) => void },
  run: (nav: NavigationService, bindings: PlacementBindingService) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const nav = createNavigationService(pool);
  await run(nav, createPlacementBindingService(pool, nav));
}

async function buildMainMenu(nav: NavigationService, key: string) {
  const set = await nav.createSet({ key, title: key });
  const services = await nav.insertItem({ setId: set.id, type: "group", label: "Services" });
  await nav.insertItem({
    setId: set.id,
    parentItemId: services.id,
    type: "internal_entry",
    label: "Audit",
    target: { entry_id: ENTRY_A },
  });
  return set;
}

test("one set can serve several placements (shared menu, spec §16)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withBindings(t, async (nav, bindings) => {
    const main = await buildMainMenu(nav, "main");
    await bindings.bindPlacement({ placementKey: "header.primary", navigationSetId: main.id });
    // Same set bound to the mobile placement — shared desktop/mobile menu.
    await bindings.bindPlacement({ placementKey: "header.mobile", navigationSetId: main.id });

    const all = await bindings.listBindings();
    assert.deepEqual(
      all.map((b) => b.placementKey),
      ["header.mobile", "header.primary"],
    );
    assert.deepEqual(
      all.map((b) => b.navigationSetId),
      [main.id, main.id],
    );

    const issues = await bindings.validateBindings(HEADER_DESCRIPTORS);
    assert.deepEqual(issues, []);
  });
});

test("independent sets per placement validate against their own capabilities", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withBindings(t, async (nav, bindings) => {
    const main = await buildMainMenu(nav, "main");
    const mobile = await nav.createSet({ key: "main-mobile", title: "Mobile menu" });
    await nav.insertItem({ setId: mobile.id, type: "separator" });
    await nav.insertItem({
      setId: mobile.id,
      type: "internal_entry",
      label: "Audit",
      target: { entry_id: ENTRY_A },
    });
    await bindings.bindPlacement({ placementKey: "header.primary", navigationSetId: main.id });
    await bindings.bindPlacement({ placementKey: "header.mobile", navigationSetId: mobile.id });
    const issues = await bindings.validateBindings(HEADER_DESCRIPTORS);
    assert.deepEqual(issues, []);
  });
});

test("trees deeper than the placement capability are errors, not truncation", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withBindings(t, async (nav, bindings) => {
    const main = await nav.createSet({ key: "deep", title: "Deep" });
    let parent = null as null | { id: string };
    for (let level = 1; level <= 4; level += 1) {
      parent = await nav.insertItem({
        setId: main.id,
        parentItemId: parent?.id ?? null,
        type: "group",
        label: `L${level}`,
      });
    }
    await bindings.bindPlacement({ placementKey: "header.primary", navigationSetId: main.id });
    const issues = await bindings.validateBindings(HEADER_DESCRIPTORS);
    const primaryIssues = issues.filter((i) => i.placement === "header.primary");
    assert.equal(primaryIssues.length, 1);
    assert.equal(primaryIssues[0]?.code, "NAV_DEPTH_UNSUPPORTED");
    // The same tree also breaks the 1-level compact placement.
    await bindings.bindPlacement({ placementKey: "header.compact", navigationSetId: main.id });
    const compactIssues = (await bindings.validateBindings(HEADER_DESCRIPTORS)).filter(
      (i) => i.placement === "header.compact",
    );
    assert.ok(compactIssues.length >= 1);
  });
});

test("item types a placement does not support surface as issues", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withBindings(t, async (nav, bindings) => {
    const main = await nav.createSet({ key: "main", title: "Main" });
    await nav.insertItem({ setId: main.id, type: "separator" });
    await bindings.bindPlacement({ placementKey: "header.primary", navigationSetId: main.id });
    const issues = (await bindings.validateBindings(HEADER_DESCRIPTORS)).filter(
      (i) => i.placement === "header.primary",
    );
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.code, "NAV_ITEM_TYPE_UNSUPPORTED");
    assert.equal(issues[0]?.placement, "header.primary");
  });
});

test("required placements without binding or fallback are reported", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withBindings(t, async (_nav, bindings) => {
    const issues = await bindings.validateBindings(HEADER_DESCRIPTORS);
    // header.primary and header.mobile are required and unbound.
    assert.deepEqual(issues.map((i: PlacementBindingIssue) => i.code).sort(), [
      "NAV_PLACEMENT_REQUIRED_MISSING",
      "NAV_PLACEMENT_REQUIRED_MISSING",
    ]);
  });
});

test("fallback resolution: an unbound compact placement falls back to primary", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withBindings(t, async (nav, bindings) => {
    const main = await buildMainMenu(nav, "main");
    await bindings.bindPlacement({ placementKey: "header.primary", navigationSetId: main.id });
    // A placement chain with a declared fallback resolves within bounded hops.
    const withFallback: readonly PlacementDescriptor[] = [
      {
        id: "header.primary",
        label: "header.primary",
        description: null,
        required: true,
        maxDepth: 3,
        supportedItemTypes: ["internal_entry", "group"],
        fallback: null,
      },
      {
        id: "header.compact",
        label: "header.compact",
        description: null,
        required: true,
        maxDepth: 1,
        supportedItemTypes: ["internal_entry"],
        fallback: "header.primary",
      },
    ];
    const issues = await bindings.validateBindings(withFallback);
    assert.deepEqual(issues, []);
    assert.ok(await bindings.getBinding("header.primary"));
    assert.equal(await bindings.getBinding("header.compact"), null);
  });
});

test("stale derived overrides on a bound set surface as validation issues", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withBindings(t, async (nav, bindings) => {
    const main = await buildMainMenu(nav, "main");
    const separator = await nav.insertItem({ setId: main.id, type: "separator" });
    const derived = await nav.createSet({
      key: "main-mobile",
      title: "Mobile",
      derivedFromSetId: main.id,
    });
    await nav.addOverride({
      setId: derived.id,
      targetItemId: separator.id,
      op: "hide",
      payload: {},
    });
    await nav.deleteItem({ setId: main.id, itemId: separator.id });
    await bindings.bindPlacement({ placementKey: "header.mobile", navigationSetId: derived.id });
    const issues = await bindings.validateBindings(HEADER_DESCRIPTORS);
    // header.primary stays unbound → its required-missing issue appears too.
    assert.deepEqual(issues.map((i) => i.code).sort(), [
      "NAV_OVERRIDE_STALE",
      "NAV_PLACEMENT_REQUIRED_MISSING",
    ]);
  });
});

test("unknown placement bindings are reported against the descriptor set", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withBindings(t, async (nav, bindings) => {
    const main = await buildMainMenu(nav, "main");
    await bindings.bindPlacement({ placementKey: "sidebar.extras", navigationSetId: main.id });
    const issues = await bindings.validateBindings(HEADER_DESCRIPTORS);
    assert.deepEqual(issues.map((i) => i.code).sort(), [
      "NAV_PLACEMENT_REQUIRED_MISSING",
      "NAV_PLACEMENT_REQUIRED_MISSING",
      "NAV_PLACEMENT_UNKNOWN",
    ]);
  });
});

test("rebinding a placement repoints it atomically", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withBindings(t, async (nav, bindings) => {
    const main = await buildMainMenu(nav, "main");
    const footer = await nav.createSet({ key: "footer", title: "Footer" });
    await bindings.bindPlacement({ placementKey: "header.primary", navigationSetId: main.id });
    await bindings.bindPlacement({ placementKey: "header.primary", navigationSetId: footer.id });
    const binding = await bindings.getBinding("header.primary");
    assert.equal(binding?.navigationSetId, footer.id);
    await bindings.unbindPlacement("header.primary");
    assert.equal(await bindings.getBinding("header.primary"), null);
  });
});
