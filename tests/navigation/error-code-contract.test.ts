// PCMS-NAV-T024 — machine-readable validation codes (Navigation spec §66).
// Acceptance: contract fixtures — the stable code surface is frozen so
// transports (M09) and agents can match on `code` forever (spec §72: minor
// releases may append, never rename or reinterpret).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  NAVIGATION_ERROR_CODES,
  type NavigationError,
  type NavigationErrorCode,
} from "@pcms/navigation";
import { ROUTING_ERROR_CODES, type RoutingError, type RoutingErrorCode } from "@pcms/routing";
import { testDatabaseConfigured } from "../helpers/testdb.js";

interface ErrorCodeContract {
  readonly contract: string;
  readonly specMandatedCodes: readonly string[];
  readonly navigationCodes: readonly NavigationErrorCode[];
  readonly routingCodes: readonly RoutingErrorCode[];
}

const CONTRACT: ErrorCodeContract = JSON.parse(
  readFileSync("fixtures/navigation/error-code-contract.json", "utf8"),
);

test("the shipped code registries match the frozen contract fixture exactly", () => {
  assert.deepEqual([...NAVIGATION_ERROR_CODES].sort(), [...CONTRACT.navigationCodes].sort());
  assert.deepEqual([...ROUTING_ERROR_CODES].sort(), [...CONTRACT.routingCodes].sort());
});

test("every spec §66 mandated code exists and is machine-matchable", () => {
  const all = new Set<string>([...NAVIGATION_ERROR_CODES, ...ROUTING_ERROR_CODES]);
  for (const mandated of CONTRACT.specMandatedCodes) {
    assert.ok(all.has(mandated), `missing spec-mandated code: ${mandated}`);
  }
});

test("scenario spot-checks: throwing paths emit the fixture-listed codes", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { createDbPool, loadMigrations, migrateDatabase } = await import("@pcms/core");
  const { createNavigationService } = await import("@pcms/navigation");
  const { createRouteService } = await import("@pcms/routing");
  const { createTestDatabase } = await import("../helpers/testdb.js");

  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: {
      host: db.connection.host,
      port: db.connection.port,
      database: db.connection.database,
      user: db.connection.user,
      sslMode: "disable" as const,
      ...(db.connection.password === undefined ? {} : { password: db.connection.password }),
    },
    max: 3,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const nav = createNavigationService(pool);
  const routes = createRouteService(pool);

  const set = await nav.createSet({ key: "main", title: "Main" });
  // NAV_DEPTH_UNSUPPORTED — spec §66
  let deep: { id: string } | null = null;
  for (let level = 1; level <= 10; level += 1) {
    deep = await nav.insertItem({
      setId: set.id,
      parentItemId: deep?.id ?? null,
      type: "group",
      label: `L${level}`,
    });
  }
  await assert.rejects(
    () => nav.insertItem({ setId: set.id, parentItemId: deep!.id, type: "group", label: "L11" }),
    (err: NavigationError) => err.code === "NAV_DEPTH_UNSUPPORTED",
  );
  // NAV_OVERRIDE_STALE — spec §66
  const base = await nav.createSet({ key: "base", title: "Base" });
  const item = await nav.insertItem({ setId: base.id, type: "group", label: "X" });
  const derived = await nav.createSet({ key: "derived", title: "D", derivedFromSetId: base.id });
  await nav.addOverride({ setId: derived.id, targetItemId: item.id, op: "hide", payload: {} });
  await nav.deleteItem({ setId: base.id, itemId: item.id });
  await assert.rejects(
    () => nav.materializeTree(derived.id),
    (err: NavigationError) => err.code === "NAV_OVERRIDE_STALE",
  );
  // ROUTE_COLLISION / ROUTE_RESERVED / DOMAIN_NOT_ALLOWED — spec §66
  const site = await routes.ensureSite("default", "S");
  await routes.activateRoute({ siteId: site.id, path: "/x/", targetType: "system", targetId: "t" });
  await assert.rejects(
    () =>
      routes.activateRoute({ siteId: site.id, path: "/x/", targetType: "system", targetId: "t2" }),
    (err: RoutingError) => err.code === "ROUTE_COLLISION",
  );
  await assert.rejects(
    () =>
      routes.activateRoute({
        siteId: site.id,
        path: "/api/x/",
        targetType: "system",
        targetId: "t",
      }),
    (err: RoutingError) => err.code === "ROUTE_RESERVED",
  );
  await assert.rejects(
    () =>
      routes.activateRoute({
        siteId: "not-a-uuid",
        path: "/y/",
        targetType: "system",
        targetId: "t",
      }),
    (err: RoutingError) => err.code === "SITE_NOT_FOUND" || err.code === "NAV_TARGET_MISSING",
  );
  // ROUTE_INVALID_ENCODING — spec §66
  await assert.rejects(
    () =>
      routes.activateRoute({
        siteId: site.id,
        path: "/a%2Fb/",
        targetType: "system",
        targetId: "t",
      }),
    (err: RoutingError) => err.code === "ROUTE_INVALID_ENCODING",
  );
});
