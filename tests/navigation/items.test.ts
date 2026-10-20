// PCMS-NAV-T003 — Navigation item types + validation.
// Acceptance: all six v1 types round-trip (Navigation spec §5–§11); external
// URL safety (`javascript:` forbidden, safe `_blank` rel) enforced on write.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createNavigationService,
  isAllowedExternalUrl,
  itemPayloadIssues,
  type NavigationError,
  type NavigationService,
  validateItemInput,
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

test("all six v1 item types round-trip through the working tree", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "all", title: "All types" });
    const created = [
      await nav.insertItem({
        setId: set.id,
        type: "internal_entry",
        label: "Services",
        target: { entry_id: ENTRY_A },
      }),
      await nav.insertItem({
        setId: set.id,
        type: "external_url",
        label: "Docs",
        target: { url: "https://docs.example.com/guide", target: "_self", rel: [] },
      }),
      await nav.insertItem({
        setId: set.id,
        type: "anchor",
        label: "Prices",
        target: { anchor: "pricing", entry_id: ENTRY_B },
      }),
      await nav.insertItem({ setId: set.id, type: "group", label: "Company" }),
      await nav.insertItem({ setId: set.id, type: "separator" }),
      await nav.insertItem({
        setId: set.id,
        type: "action",
        label: "Call us",
        target: { kind: "phone", phone: "+74951234567" },
        uiIntent: "cta",
      }),
    ];
    const tree = await nav.readTree(set.id);
    assert.equal(tree.length, created.length);
    for (const [index, node] of tree.entries()) {
      assert.equal(node.id, created[index]?.id);
      assert.deepEqual(node.target, created[index]?.target);
      assert.equal(node.label, created[index]?.label);
      assert.equal(node.uiIntent, created[index]?.uiIntent);
    }
    assert.deepEqual(tree[5]?.target, { kind: "phone", phone: "+74951234567" });
    assert.equal(tree[5]?.uiIntent, "cta");
  });
});

test("internal entries store the Entry ID, never a URL (spec §6)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "main", title: "Main" });
    await assert.rejects(
      () =>
        nav.insertItem({
          setId: set.id,
          type: "internal_entry",
          label: "By URL",
          target: { entry_id: "/services/" },
        } as never),
      (err: NavigationError) =>
        err.code === "NAV_ITEM_PAYLOAD_INVALID" &&
        JSON.stringify(err.details.issues).includes("target"),
    );
  });
});

test("javascript: URLs are forbidden on external_url items (spec §7)", () => {
  assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedExternalUrl("data:text/html,<b>x</b>"), false);
  assert.equal(isAllowedExternalUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedExternalUrl("vbscript:x"), false);
  assert.equal(isAllowedExternalUrl("https://example.com/page"), true);
  assert.equal(isAllowedExternalUrl("http://example.com"), true);
  assert.equal(isAllowedExternalUrl("not a url"), false);
  assert.equal(
    itemPayloadIssues(
      "external_url",
      { url: "javascript:alert(1)", target: "_self", rel: [] },
      "x",
      null,
    ).length > 0,
    true,
  );
});

test("tel/mailto must use the typed action model, not external_url", () => {
  assert.equal(isAllowedExternalUrl("tel:+74951234567"), false);
  assert.equal(isAllowedExternalUrl("mailto:hi@example.com"), false);
  const issues = itemPayloadIssues(
    "action",
    { kind: "email", email: "hi@example.com" },
    "Write",
    null,
  );
  assert.deepEqual(issues, []);
});

test("_blank external links gain a safe rel policy on write (spec §7)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "main", title: "Main" });
    await nav.insertItem({
      setId: set.id,
      type: "external_url",
      label: "Partner",
      target: { url: "https://partner.example.com", target: "_blank", rel: ["nofollow"] },
    });
    const [item] = await nav.readTree(set.id);
    assert.deepEqual(item?.target, {
      url: "https://partner.example.com",
      target: "_blank",
      rel: ["nofollow", "noopener", "noreferrer"],
    });
  });
});

test("unknown rel tokens are rejected, not dropped", () => {
  assert.throws(
    () =>
      validateItemInput({
        type: "external_url",
        label: "x",
        target: { url: "https://example.com", target: "_self", rel: ["opener"] as never },
      }),
    (err: NavigationError) => err.code === "NAV_ITEM_REL_TOKEN_INVALID",
  );
});

test("anchors validate name shape and optional entry reference (spec §8)", () => {
  assert.deepEqual(
    itemPayloadIssues("anchor", { anchor: "pricing", entry_id: null }, "x", null),
    [],
  );
  assert.deepEqual(
    itemPayloadIssues("anchor", { anchor: "pricing", entry_id: ENTRY_A }, "x", null),
    [],
  );
  assert.ok(
    itemPayloadIssues("anchor", { anchor: "has spaces", entry_id: null }, "x", null).includes(
      "target",
    ),
  );
  assert.ok(
    itemPayloadIssues(
      "anchor",
      { anchor: "".padStart(200, "a"), entry_id: null },
      "x",
      null,
    ).includes("target"),
  );
  assert.ok(
    itemPayloadIssues("anchor", { anchor: "x", entry_id: "nope" }, "x", null).includes("target"),
  );
});

test("typed actions cover the Content §47 kinds with payload checks", () => {
  assert.deepEqual(
    itemPayloadIssues("action", { kind: "internal_entry", entry_id: ENTRY_A }, "x", "cta"),
    [],
  );
  assert.deepEqual(
    itemPayloadIssues("action", { kind: "form", form_definition_id: "contact-v1" }, "x", "button"),
    [],
  );
  assert.deepEqual(
    itemPayloadIssues("action", { kind: "media_download", media_asset_id: ENTRY_A }, "x", null),
    [],
  );
  assert.deepEqual(itemPayloadIssues("action", { kind: "none" }, "Home", null), []);
  assert.ok(
    itemPayloadIssues("action", { kind: "phone", phone: "alert(1)" }, "x", null).includes(
      "target/phone",
    ),
  );
  assert.ok(
    itemPayloadIssues("action", { kind: "email", email: "no-at-sign" }, "x", null).includes(
      "target/email",
    ),
  );
  assert.ok(
    itemPayloadIssues("action", { kind: "form", form_definition_id: "" }, "x", null).includes(
      "target/form_definition_id",
    ),
  );
  // ui intent is a presentation hint only — unknown intents rejected.
  assert.ok(
    itemPayloadIssues("action", { kind: "none" }, "x", "mega-popup" as never).includes("ui_intent"),
  );
  // unknown action kinds rejected
  assert.ok(
    itemPayloadIssues("action", { kind: "webhook" } as never, "x", null).includes("target"),
  );
});

test("groups need a label; separators carry nothing", () => {
  assert.ok(itemPayloadIssues("group", null, null, null).includes("label"));
  assert.deepEqual(itemPayloadIssues("group", null, "Services", null), []);
  assert.deepEqual(itemPayloadIssues("separator", null, null, null), []);
  assert.ok(itemPayloadIssues("separator", null, "not allowed", null).includes("label"));
  assert.ok(
    itemPayloadIssues("separator", { entry_id: ENTRY_A } as never, null, null).includes("target"),
  );
});

test("separators cannot become parents; payloads are validated on insert", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withNav(t, async (_pool, nav) => {
    const set = await nav.createSet({ key: "main", title: "Main" });
    const sep = await nav.insertItem({ setId: set.id, type: "separator" });
    await assert.rejects(
      () =>
        nav.insertItem({
          setId: set.id,
          parentItemId: sep.id,
          type: "group",
          label: "under separator",
        }),
      (err: NavigationError) => err.code === "NAV_ITEM_PARENT_INVALID",
    );
    await assert.rejects(
      () =>
        nav.insertItem({
          setId: set.id,
          type: "external_url",
          label: "bad",
          target: { url: "ftp://x", target: "_self", rel: [] },
        }),
      (err: NavigationError) => err.code === "NAV_ITEM_PAYLOAD_INVALID",
    );
  });
});
