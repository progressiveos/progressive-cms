// PCMS-ADMIN-T012/T013 — navigation authoring contracts over the M04 domain.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationContext } from "@pcms/api";
import { apiContextOf, ownerActor, scopedActor } from "../helpers/api-composition.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

async function fixture(t: { after: (fn: () => void) => void }) {
  return rollbackApiFixture(t, {});
}

test("navigation authoring: create set, items, move, seal, placements", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const ops = await import("@pcms/api");

  const set = await ops.createNavigationSet(app, ctx, {
    key: "header-main",
    title: "Главное меню",
  });
  const parent = await ops.insertNavigationItem(app, ctx, {
    set_id: set.set_id,
    type: "internal_entry",
    label: "О компании",
    target: { entry_id: "018f6d2c-5f31-7abc-8def-2a3b4c5d6e70" },
  });
  const child = await ops.insertNavigationItem(app, ctx, {
    set_id: set.set_id,
    parent_item_id: parent.item_id,
    type: "external_url",
    label: "Внешний",
    target: { url: "https://example.ru", target: "_blank", rel: ["noopener"] },
  });
  const sep = await ops.insertNavigationItem(app, ctx, { set_id: set.set_id, type: "separator" });
  assert.notEqual(sep.item_id, "");

  // move child after separator (root level, at index 1)
  await ops.moveNavigationItem(app, ctx, {
    set_id: set.set_id,
    item_id: child.item_id,
    parent_item_id: null,
    at: 1,
  });
  const tree = await app.navigation.readTree(set.set_id);
  assert.equal(tree.length, 3);
  assert.equal(tree[1]?.id, child.item_id);

  // all six v1 item types insert cleanly with their payload contracts
  await ops.insertNavigationItem(app, ctx, {
    set_id: set.set_id,
    type: "anchor",
    label: "Якорь",
    target: { anchor: "contacts", entry_id: null },
  });
  await ops.insertNavigationItem(app, ctx, { set_id: set.set_id, type: "group", label: "Раздел" });
  await ops.insertNavigationItem(app, ctx, {
    set_id: set.set_id,
    type: "action",
    label: "Позвонить",
    target: { kind: "phone", phone: "+7 900 000-00-00" },
    ui_intent: "cta",
  });

  const sealed = await ops.sealNavigationSet(app, ctx, { set_id: set.set_id });
  assert.equal(sealed.revision, 1);

  // placements: bind + validate + unbind
  await ops.bindPlacement(app, ctx, {
    placement_key: "header.primary",
    navigation_set_id: set.set_id,
  });
  const validation = await ops.validateNavigationOp(app, ctx);
  assert.equal(typeof validation.ok, "boolean");
  await ops.unbindPlacement(app, ctx, { placement_key: "header.primary" });
});

test("navigation overrides: add/remove/stale detection on a derived set", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const ops = await import("@pcms/api");

  const base = await ops.createNavigationSet(app, ctx, { key: "base-menu", title: "База" });
  const item = await ops.insertNavigationItem(app, ctx, {
    set_id: base.set_id,
    type: "internal_entry",
    label: "Пункт",
    target: { entry_id: "018f6d2c-5f31-7abc-8def-2a3b4c5d6e70" },
  });
  await ops.sealNavigationSet(app, ctx, { set_id: base.set_id });

  const derived = await ops.createNavigationSet(app, ctx, {
    key: "mobile-menu",
    title: "Мобильное меню",
    derived_from_set_id: base.set_id,
  });
  const override = await ops.addNavigationOverride(app, ctx, {
    set_id: derived.set_id,
    target_item_id: item.item_id,
    op: "relabel",
    payload: { label: "Пункт (моб)" },
  });
  const listed = await ops.listNavigationOverrides(app, ctx, { set_id: derived.set_id });
  assert.equal(listed.overrides.length, 1);
  assert.equal(listed.overrides[0]?.op, "relabel");

  // Break the base: deleting the base item makes the derived override stale.
  await app.navigation.deleteItem({ setId: base.set_id, itemId: item.item_id });
  const after = await ops.listNavigationOverrides(app, ctx, { set_id: derived.set_id });
  assert.equal(after.stale.length, 1);

  await ops.removeNavigationOverride(app, ctx, {
    set_id: derived.set_id,
    override_id: override.override_id,
  });
  const cleared = await ops.listNavigationOverrides(app, ctx, { set_id: derived.set_id });
  assert.equal(cleared.overrides.length, 0);
});

test("navigation authoring: permission denial without navigation.edit", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const limited = apiContextOf(scopedActor(["navigation.read"]));
  const ops = await import("@pcms/api");
  await assert.rejects(
    () => ops.createNavigationSet(app, limited, { key: "nope", title: "Нет" }),
    (error: { readonly code?: string }) => error?.code === "AUTH_PERMISSION_DENIED",
  );
});

async function deleteFixture(t: import("node:test").TestContext) {
  const { app, pool } = await fixture(t);
  const { createApiFastify, createApiV1, makeMutationRoutes } = await import("@pcms/api");
  const { createLogger } = await import("@pcms/core");
  const server = createApiFastify(() => "navigation-delete");
  await server.register(createApiV1(makeMutationRoutes()), {
    application: app,
    logger: createLogger({ level: "error", base: {} }),
    cookieSecure: false,
  });
  t.after(() => server.close());
  const account = await app.machineIdentity.createServiceAccount({
    name: "navigation-delete",
    purpose: "test",
  });
  async function headers(scopes = ["navigation.edit", "navigation.read"]) {
    const token = await app.machineIdentity.createAccessToken({
      serviceAccountId: account.id,
      scopes,
      ttlMilliseconds: 3600000,
      siteKey: "default",
      environment: "production",
    });
    return {
      authorization: `Bearer ${token.rawSecret}`,
      "x-pcms-site": "default",
      "x-pcms-environment": "production",
    };
  }
  const authorized = await headers();
  const remove = (id: string, requestHeaders = authorized) =>
    server.inject({
      method: "DELETE",
      url: `/api/v1/navigation/sets/${id}`,
      headers: requestHeaders,
    });
  return { app, pool, headers, remove, authorized };
}

test("navigation DELETE: empty, nested items and sealed history; other sets stay intact", async (t) => {
  const fx = await deleteFixture(t);
  const other = await fx.app.navigation.createSet({ key: "other", title: "Other" });
  await fx.app.navigation.insertItem({ setId: other.id, type: "group", label: "Keep me" });
  await fx.app.navigation.sealRevision(other.id);
  const before = (
    await fx.pool.query("SELECT * FROM navigation_revisions WHERE set_id=$1", [other.id])
  ).rows;
  for (const mode of ["empty", "items", "sealed", "historical"] as const) {
    const set = await fx.app.navigation.createSet({ key: mode, title: mode });
    if (mode !== "empty") {
      const parent = await fx.app.navigation.insertItem({
        setId: set.id,
        type: "group",
        label: "Root",
      });
      await fx.app.navigation.insertItem({
        setId: set.id,
        parentItemId: parent.id,
        type: "separator",
      });
      if (mode !== "items") {
        await fx.app.navigation.sealRevision(set.id);
        await fx.app.navigation.sealRevision(set.id);
      }
      if (mode === "historical")
        await fx.app.navigation.deleteItem({ setId: set.id, itemId: parent.id });
    }
    const response = await fx.remove(set.id);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().deleted, true);
    for (const table of ["navigation_items", "navigation_revisions", "navigation_overrides"]) {
      assert.equal(
        (await fx.pool.query(`SELECT count(*) AS n FROM ${table} WHERE set_id=$1`, [set.id]))
          .rows[0]?.n,
        "0",
      );
    }
    const again = await fx.remove(set.id);
    assert.equal(again.statusCode, 404, again.body);
    assert.equal(again.json().error.code, "NAV_SET_NOT_FOUND");
  }
  assert.equal(await fx.app.navigation.countItems(other.id), 1);
  assert.deepEqual(
    (await fx.pool.query("SELECT * FROM navigation_revisions WHERE set_id=$1", [other.id])).rows,
    before,
  );
});

test("navigation DELETE: placements and derived dependencies reject; deleting derived owns only its history", async (t) => {
  const fx = await deleteFixture(t);
  const base = await fx.app.navigation.createSet({ key: "base", title: "Base" });
  const item = await fx.app.navigation.insertItem({ setId: base.id, type: "group", label: "Keep" });
  await fx.app.navigation.sealRevision(base.id);
  await fx.app.placements.bindPlacement({
    placementKey: "header.primary",
    navigationSetId: base.id,
  });
  const bound = await fx.remove(base.id);
  assert.equal(bound.statusCode, 409, bound.body);
  assert.equal(bound.json().error.code, "NAV_SET_BOUND");
  await fx.app.placements.unbindPlacement("header.primary");
  const derived = await fx.app.navigation.createSet({
    key: "derived",
    title: "Derived",
    derivedFromSetId: base.id,
  });
  await fx.app.navigation.addOverride({
    setId: derived.id,
    targetItemId: item.id,
    op: "relabel",
    payload: { label: "Derived" },
  });
  await fx.app.navigation.sealRevision(derived.id);
  const blocked = await fx.remove(base.id);
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().error.code, "NAV_SET_BOUND");
  assert.equal((await fx.remove(derived.id)).statusCode, 200);
  assert.equal(
    (
      await fx.pool.query("SELECT count(*) AS n FROM navigation_overrides WHERE set_id=$1", [
        derived.id,
      ])
    ).rows[0]?.n,
    "0",
  );
  assert.equal(await fx.app.navigation.countItems(base.id), 1);
  assert.equal((await fx.app.navigation.listRevisions(base.id)).length, 1);
  assert.equal((await fx.remove(base.id)).statusCode, 200);
});

test("navigation DELETE: permissions and site/environment isolation remain enforced", async (t) => {
  const fx = await deleteFixture(t);
  const set = await fx.app.navigation.createSet({ key: "protected", title: "Protected" });
  await fx.app.navigation.insertItem({ setId: set.id, type: "group", label: "Keep" });
  await fx.app.navigation.sealRevision(set.id);
  const limited = await fx.remove(set.id, await fx.headers(["navigation.read"]));
  assert.equal(limited.statusCode, 403, limited.body);
  assert.equal(limited.json().error.code, "AUTH_PERMISSION_DENIED");
  for (const context of [{ "x-pcms-site": "foreign" }, { "x-pcms-environment": "staging" }]) {
    const denied = await fx.remove(set.id, { ...fx.authorized, ...context });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(
      denied.json().error.code,
      "x-pcms-site" in context ? "AUTH_TOKEN_SITE_DENIED" : "AUTH_TOKEN_ENVIRONMENT_DENIED",
    );
  }
  assert.equal(await fx.app.navigation.countItems(set.id), 1);
  assert.equal((await fx.app.navigation.listRevisions(set.id)).length, 1);
});

test("navigation DELETE: unexpected external item reference rolls back own history deletion", async (t) => {
  const fx = await deleteFixture(t);
  const own = await fx.app.navigation.createSet({ key: "own", title: "Own" });
  const parent = await fx.app.navigation.insertItem({
    setId: own.id,
    type: "group",
    label: "Own parent",
  });
  const sealed = await fx.app.navigation.sealRevision(own.id);
  const foreign = await fx.app.navigation.createSet({ key: "foreign", title: "Foreign" });
  const child = await fx.app.navigation.insertItem({ setId: foreign.id, type: "separator" });
  // Simulate a foreign FK dependency not authored through the domain API.
  await fx.pool.query("UPDATE navigation_items SET parent_item_id=$1 WHERE id=$2", [
    parent.id,
    child.id,
  ]);
  const blocked = await fx.remove(own.id);
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().error.code, "NAV_SET_BOUND");
  assert.equal(await fx.app.navigation.countItems(own.id), 1);
  assert.equal((await fx.app.navigation.getRevision(own.id, sealed.revision))?.id, sealed.id);
  assert.equal(await fx.app.navigation.countItems(foreign.id), 1);
  assert.equal(
    (await fx.pool.query("SELECT parent_item_id FROM navigation_items WHERE id=$1", [child.id]))
      .rows[0]?.parent_item_id,
    parent.id,
  );
});
