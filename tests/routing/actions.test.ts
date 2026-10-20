// PCMS-NAV-T019 — typed internal Action URL resolution (Navigation spec §11;
// Content spec §47). Acceptance: Entry IDs resolve to their current URL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  type ActionUrlService,
  createActionUrlService,
  createDomainService,
  createRouteHistoryService,
  createRouteService,
  type DomainService,
  type RouteService,
} from "@pcms/routing";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const ENTRY_A = "01900000-0000-7000-8000-000000000001";
const ENTRY_B = "01900000-0000-7000-8000-000000000002";
const ENTRY_HOME = "01900000-0000-7000-8000-0000000000a0";

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

async function withActions(
  t: { after: (fn: () => void) => void },
  run: (
    actions: ActionUrlService,
    routes: RouteService,
    domains: DomainService,
    pool: DbPool,
  ) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const routes = createRouteService(pool);
  const domains = createDomainService(pool);
  await run(createActionUrlService(pool), routes, domains, pool);
}

test("internal actions resolve Entry IDs to their current site-relative URL", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withActions(t, async (actions, routes, domains) => {
    const site = await routes.ensureSite("default", "Example Corp");
    await routes.setHomeEntry(site.id, ENTRY_HOME);
    await routes.activateRoute({
      siteId: site.id,
      path: "/services/audit/",
      targetType: "entry",
      targetId: ENTRY_A,
    });
    await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });

    assert.deepEqual(await actions.resolveAction({ kind: "internal_entry", entry_id: ENTRY_A }), {
      kind: "url",
      href: "/services/audit/",
    });
    // The home entry resolves to "/".
    assert.deepEqual(
      await actions.resolveAction({ kind: "internal_entry", entry_id: ENTRY_HOME }),
      { kind: "url", href: "/" },
    );
    // Absolute mode builds on the canonical domain binding.
    assert.deepEqual(
      await actions.resolveAction(
        { kind: "internal_entry", entry_id: ENTRY_A },
        { absolute: true },
      ),
      { kind: "url", href: "https://example.ru/services/audit/" },
    );
  });
});

test("route changes are picked up: Entry IDs always resolve the current URL", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withActions(t, async (actions, routes, domains, pool) => {
    const history = createRouteHistoryService(pool);
    const site = await routes.ensureSite("default", "Example Corp");
    await routes.activateRoute({
      siteId: site.id,
      path: "/old-path/",
      targetType: "entry",
      targetId: ENTRY_B,
    });
    await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });
    assert.deepEqual(await actions.resolveAction({ kind: "internal_entry", entry_id: ENTRY_B }), {
      kind: "url",
      href: "/old-path/",
    });

    await history.changeRoute({
      siteId: site.id,
      entryId: ENTRY_B,
      fromPath: "/old-path/",
      toPath: "/new-path/",
    });
    // The stored reference stayed the Entry ID; its URL followed the route.
    assert.deepEqual(await actions.resolveAction({ kind: "internal_entry", entry_id: ENTRY_B }), {
      kind: "url",
      href: "/new-path/",
    });
  });
});

test("anchors, phone, email and none resolve; unsafe payloads cannot", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withActions(t, async (actions) => {
    assert.deepEqual(
      await actions.resolveAction({ kind: "anchor", anchor: "pricing", entry_id: null }),
      {
        kind: "url",
        href: "#pricing",
      },
    );
    assert.deepEqual(await actions.resolveAction({ kind: "phone", phone: "+7 (495) 123-45-67" }), {
      kind: "tel",
      href: "tel:+74951234567",
    });
    assert.deepEqual(await actions.resolveAction({ kind: "email", email: "hi@example.ru" }), {
      kind: "mailto",
      href: "mailto:hi@example.ru",
    });
    assert.deepEqual(await actions.resolveAction({ kind: "none" }), { kind: "none" });
    // Scheme safety: a javascript: URL cannot escape through an action.
    assert.deepEqual(
      await actions.resolveAction({ kind: "external_url", url: "javascript:alert(1)" }),
      {
        kind: "unresolved",
        reason: "scheme-forbidden",
      },
    );
    // Reserved future subsystems resolve as explicitly unavailable, not broken.
    assert.deepEqual(
      await actions.resolveAction({ kind: "form", form_definition_id: "contact-v1" }),
      {
        kind: "unresolved",
        reason: "form-unavailable-until-m12",
      },
    );
    assert.deepEqual(
      await actions.resolveAction({ kind: "media_download", media_asset_id: ENTRY_A }),
      { kind: "unresolved", reason: "media-unavailable-until-m05" },
    );
  });
});

test("unrouted entries resolve as explicitly unresolved", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withActions(t, async (actions, routes, domains) => {
    const site = await routes.ensureSite("default", "Example Corp");
    await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });
    assert.deepEqual(await actions.resolveAction({ kind: "internal_entry", entry_id: ENTRY_A }), {
      kind: "unresolved",
      reason: "entry-unrouted",
    });
    // Entry + anchor without a route is also unresolved.
    assert.deepEqual(
      await actions.resolveAction({ kind: "anchor", anchor: "top", entry_id: ENTRY_A }),
      { kind: "unresolved", reason: "entry-unrouted" },
    );
  });
});
