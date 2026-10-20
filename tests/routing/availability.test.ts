// PCMS-NAV-T018 — route availability/proposal service (Navigation spec
// §30/§54). Acceptance: draft collision preflight — availability works
// before publication, and nothing is activated or reserved by proposing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createRouteHistoryService,
  createRouteProposalService,
  createRouteService,
  type RouteHistoryService,
  type RouteProposalService,
  type RouteService,
  type RoutingError,
} from "@pcms/routing";
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

async function withProposal(
  t: { after: (fn: () => void) => void },
  run: (
    routes: RouteService,
    history: RouteHistoryService,
    proposal: RouteProposalService,
  ) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const routes = createRouteService(pool);
  const history = createRouteHistoryService(pool);
  await run(routes, history, createRouteProposalService(pool));
}

test("preflight reports availability before any activation (spec §54)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withProposal(t, async (routes, _history, proposal) => {
    const site = await routes.ensureSite("default", "Example Corp");
    const free = await proposal.checkRouteAvailable({ siteId: site.id, path: "/services/audit/" });
    assert.equal(free.available, true);
    assert.deepEqual(free.issues, []);

    // Proposing does not reserve anything — still free for the real activation.
    await proposal.proposeRoutePath({ siteId: site.id, segments: ["cases", "Завод"] });
    const stillFree = await proposal.checkRouteAvailable({
      siteId: site.id,
      path: "/cases/zavod/",
    });
    assert.equal(stillFree.available, true);
  });
});

test("collisions, reserved namespaces and encodings come back machine-readably", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withProposal(t, async (routes, _history, proposal) => {
    const site = await routes.ensureSite("default", "Example Corp");
    await routes.activateRoute({
      siteId: site.id,
      path: "/services/",
      targetType: "entry",
      targetId: ENTRY_A,
    });
    const taken = await proposal.checkRouteAvailable({ siteId: site.id, path: "/services/" });
    assert.equal(taken.available, false);
    assert.deepEqual(taken.issues, [
      { code: "ROUTE_COLLISION", reason: "active-route", path: "/services/" },
    ]);

    const sys = await proposal.checkRouteAvailable({ siteId: site.id, path: "/api/x/" });
    assert.deepEqual(sys.issues, [{ code: "ROUTE_RESERVED", reason: "reserved", path: "/api/x/" }]);

    const bad = await proposal.checkRouteAvailable({ siteId: site.id, path: "/a%2Fb/" });
    assert.deepEqual(bad.issues, [
      { code: "ROUTE_INVALID_ENCODING", reason: "encoding", path: "/a%2Fb/" },
    ]);
  });
});

test("paths occupied by an active redirect are conflicts with a distinct reason", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withProposal(t, async (routes, history, proposal) => {
    const site = await routes.ensureSite("default", "Example Corp");
    await history.recordRedirect({
      siteId: site.id,
      oldPath: "/legacy/",
      targetType: "path",
      targetId: "/new/",
      statusCode: 301,
    });
    const result = await proposal.checkRouteAvailable({ siteId: site.id, path: "/legacy/" });
    assert.equal(result.available, false);
    assert.deepEqual(result.issues, [
      { code: "ROUTE_COLLISION", reason: "active-redirect", path: "/legacy/" },
    ]);
  });
});

test("proposals normalize slugs and pick the next free -N suffix", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withProposal(t, async (routes, _history, proposal) => {
    const site = await routes.ensureSite("default", "Example Corp");
    const first = await proposal.proposeRoutePath({
      siteId: site.id,
      segments: ["services", "Аудит"],
    });
    assert.deepEqual(
      { path: first.path, available: first.available },
      { path: "/services/audit/", available: true },
    );

    // Occupy the base path; the next proposal must offer -2.
    await routes.activateRoute({
      siteId: site.id,
      path: "/services/audit/",
      targetType: "entry",
      targetId: ENTRY_A,
    });
    const second = await proposal.proposeRoutePath({
      siteId: site.id,
      segments: ["services", "Аудит"],
    });
    assert.deepEqual(
      { path: second.path, available: second.available },
      { path: "/services/audit-2/", available: true },
    );
    await routes.activateRoute({
      siteId: site.id,
      path: "/services/audit-2/",
      targetType: "entry",
      targetId: ENTRY_B,
    });
    const third = await proposal.proposeRoutePath({
      siteId: site.id,
      segments: ["services", "Аудит"],
    });
    assert.equal(third.path, "/services/audit-3/");
    assert.equal(third.available, true);
  });
});

test("unroutable proposals surface as invalid, never crash the caller", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withProposal(t, async (_routes, _history, proposal) => {
    const site = await _routes.ensureSite("default", "Example Corp");
    await assert.rejects(
      () => proposal.proposeRoutePath({ siteId: site.id, segments: ["!!!"] }),
      (err: RoutingError) => err.code === "SLUG_INVALID",
    );
  });
});
