// PCMS-PUB-T010 — cross-subsystem publication validator pipeline: gates are
// registered at the composition layer, run deterministically and see the
// combined prospective resulting state (route swaps must not self-collide).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  fixedClock,
  loadMigrations,
  migrateDatabase,
  newStableId,
} from "@pcms/core";
import {
  type PublicationCandidate,
  type PublicationValidator,
  type RouteOperation,
  runPublicationValidators,
} from "@pcms/publication";
import { createRouteService, type RouteService } from "@pcms/routing";
import { createRouteAvailabilityValidator } from "../helpers/publication-composition.js";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

function connectionInfoOf(db: TestDatabase) {
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

const CLOCK = fixedClock("2026-10-01T09:00:00.000Z");

function candidate(
  index: number,
  routeOperation: RouteOperation,
  entityId = newStableId(),
): PublicationCandidate {
  return {
    entityType: "entry",
    entityId,
    context: "default",
    intent: "PUBLISH",
    targetRevision: {
      revisionId: newStableId(),
      entityType: "entry",
      entityId,
      payloadHash: `hash-${index}`,
      schemaVersion: "1",
      locale: "default",
      payload: {},
      mediaVersions: null,
      sidecar: null,
      sealedAt: CLOCK.now(),
    },
    routeOperation,
  };
}

test("pipeline output is deterministic and sorted by candidate/code/validator", async () => {
  const order: string[] = [];
  const makeValidator = (name: string, delay: number): PublicationValidator => ({
    name,
    async validate(candidates) {
      order.push(name);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return candidates.map((_, index) => ({
        code: `ISSUE_${name.toUpperCase()}`,
        severity: "warning" as const,
        message: name,
        candidateIndex: candidates.length - 1 - index, // reversed on purpose
      }));
    },
  });
  const issues = await runPublicationValidators(
    [makeValidator("beta", 5), makeValidator("alpha", 1)],
    [candidate(0, { kind: "none" }), candidate(1, { kind: "none" })],
    { executor: null as never, clock: CLOCK },
  );
  assert.deepEqual(order, ["beta", "alpha"], "validators run in registration order");
  assert.deepEqual(
    issues.map((i) => `${i.candidateIndex}:${i.code}`),
    ["0:ISSUE_ALPHA", "0:ISSUE_BETA", "1:ISSUE_ALPHA", "1:ISSUE_BETA"],
  );
});

test("route swap across a release validates the combined state, not stale state", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withRouting(t, async (_pool, routes, siteId) => {
    const validator = createRouteAvailabilityValidator({
      findActiveRoute: (siteId_, path, locale) => findActive(routes, siteId_, path, locale),
    });
    const entryA = newStableId();
    const entryB = newStableId();
    // Current state: A at /a/, B at /b/.
    await routes.activateRoute({ siteId, path: "/a/", targetType: "entry", targetId: entryA });
    await routes.activateRoute({ siteId, path: "/b/", targetType: "entry", targetId: entryB });

    // Release swaps them: A→/b/ (frees /a/), B→/a/ (frees /b/).
    const swap: PublicationCandidate[] = [
      candidate(0, {
        kind: "set",
        siteId,
        path: "/b/",
        freesPath: "/a/",
      }),
      candidate(1, {
        kind: "set",
        siteId,
        path: "/a/",
        freesPath: "/b/",
      }),
    ];
    const swapIssues = await validator.validate(swap, {
      executor: null as never,
      clock: CLOCK,
    });
    assert.deepEqual(swapIssues, [], "same-release route swap must not self-collide");

    // A third page trying to take /a/ in the same release collides with the swap.
    const hostile = candidate(2, { kind: "set", siteId, path: "/a/" });
    const hostileIssues = await validator.validate([...swap, hostile], {
      executor: null as never,
      clock: CLOCK,
    });
    assert.equal(hostileIssues.length, 1);
    assert.equal(hostileIssues[0]!.code, "ROUTE_CONFLICT");
    assert.equal(hostileIssues[0]!.candidateIndex, 2);

    // Against plain current state (no frees), taking an occupied path conflicts.
    const naive = await validator.validate([candidate(0, { kind: "set", siteId, path: "/a/" })], {
      executor: null as never,
      clock: CLOCK,
    });
    assert.equal(naive.length, 1);
    assert.equal(naive[0]!.code, "ROUTE_CONFLICT");
  });
});

test("route availability validator agrees with real PG activation outcomes", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withRouting(t, async (_pool, routes, siteId) => {
    const entryA = newStableId();
    await routes.activateRoute({ siteId, path: "/taken/", targetType: "entry", targetId: entryA });
    const validator = createRouteAvailabilityValidator({
      findActiveRoute: (siteId_, path, locale) => findActive(routes, siteId_, path, locale),
    });
    const issues = await validator.validate(
      [candidate(0, { kind: "set", siteId, path: "/taken/" })],
      { executor: null as never, clock: CLOCK },
    );
    assert.equal(issues.length, 1);
    // The activation-level backstop still rejects it with the stable code.
    await assert.rejects(
      () =>
        routes.activateRoute({ siteId, path: "/taken/", targetType: "entry", targetId: entryA }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "ROUTE_COLLISION");
        return true;
      },
    );
  });
});

test("in-transaction activation seam rejects collisions like the pool path", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withRouting(t, async (pool, routes, siteId) => {
    const entryA = newStableId();
    await routes.activateRoute({ siteId, path: "/taken/", targetType: "entry", targetId: entryA });
    await pool.withClient(async (client) => {
      // The WithinTx seam runs on the caller's client — outside any explicit
      // transaction here it must behave exactly like activateRoute.
      await assert.rejects(
        () =>
          routes.activateRouteWithinTx(client, {
            siteId,
            path: "/taken/",
            targetType: "entry",
            targetId: entryA,
          }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "ROUTE_COLLISION");
          return true;
        },
      );
      await routes.retireRouteWithinTx(client, { siteId, path: "/taken/" });
      const reactivated = await routes.activateRouteWithinTx(client, {
        siteId,
        path: "/taken/",
        targetType: "entry",
        targetId: entryA,
      });
      assert.equal(reactivated.path, "/taken/");
    });
  });
});

// -- helpers ----------------------------------------------------------------

async function findActive(
  routes: RouteService,
  siteId: string,
  path: string,
  locale: string | undefined,
): Promise<{ id: string } | null> {
  const route = await routes.findActiveRoute(
    siteId,
    path,
    locale === undefined ? undefined : { locale },
  );
  return route === null ? null : { id: route.id };
}

async function withRouting(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool, routes: RouteService, siteId: string) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfoOf(db),
    max: 5,
    connectionTimeoutMilliseconds: 3000,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const routes = createRouteService(pool);
  const site = await routes.ensureSite("default");
  await run(pool, routes, site.id);
}
