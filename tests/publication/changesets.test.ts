// PCMS-PUB-T013/T014/T015 — ChangeSet domain, preflight/staleness and the
// immediate atomic multi-entity apply, against real PostgreSQL (Publication
// spec §15–§21). The 5-entity release must land fully or not at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  fixedClock,
  loadMigrations,
  migrateDatabase,
  newStableId,
  type StableId,
} from "@pcms/core";
import {
  type ChangeSetService,
  createChangeSetService,
  createPublicationService,
  type PublicationError,
  type PublicationService,
  type RevisionReaderPort,
} from "@pcms/publication";
import type { RevisionStore } from "@pcms/revisions";
import { revisionReaderFromStore } from "../helpers/publication-composition.js";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const CLOCK = fixedClock("2026-10-01T09:00:00.000Z");
const ACTOR = { actorClass: "human", actorId: "editor-1" } as const;
const SYSTEM = { actorClass: "system", actorId: "system", origin: "system" } as const;

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

const ADAPTERS = ["entry", "global_content", "theme_settings", "navigation"].map((entityType) => ({
  entityType,
  description: `${entityType} adapter`,
  validateForSeal: () => [],
}));

interface Fixture {
  pool: DbPool;
  store: RevisionStore;
  revisions: RevisionReaderPort;
  publications: PublicationService;
  changesets: ChangeSetService;
  routes?: import("@pcms/routing").RouteService;
}

async function withChangesetFixture(
  t: { after: (fn: () => void) => void },
  run: (fx: Fixture) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfoOf(db),
    max: 8,
    connectionTimeoutMilliseconds: 3000,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const { createRevisionStore, createVersionedEntityRegistry } = await import("@pcms/revisions");
  const store = createRevisionStore(pool, {
    registry: createVersionedEntityRegistry(ADAPTERS),
    clock: CLOCK,
  });
  const revisions = revisionReaderFromStore(store);
  const publications = createPublicationService(pool, { clock: CLOCK, revisions });
  const { createRouteService } = await import("@pcms/routing");
  const routes = createRouteService(pool);
  const changesets = createChangeSetService(pool, {
    clock: CLOCK,
    revisions,
    publications,
    routes: {
      validateActivatable: async (input) => routes.validateActivatable(input),
      activateWithinTx: async (client, operation) => {
        if (operation.kind !== "set") return;
        if (operation.freesPath !== undefined) {
          await routes.retireRouteWithinTx(client, {
            siteId: operation.siteId,
            path: operation.freesPath,
          });
        }
        await routes.activateRouteWithinTx(client, {
          siteId: operation.siteId,
          path: operation.path,
          locale: operation.locale ?? null,
          domainBindingId: operation.domainBindingId ?? null,
          targetType: "entry",
          targetId: operation.entityId,
        });
      },
      retireWithinTx: async (client, retired) => {
        // The composition resolves the path from the canonical route; the
        // double keeps it simple — retire ops carry no path in this fixture.
        void retired;
      },
    },
  });
  await run({ pool, store, revisions, publications, changesets, routes });
}

/** Seals a fresh revision for an entity and returns its id. */
async function sealRevision(
  fx: Fixture,
  entityType: string,
  entityId: StableId,
  payload: unknown = { seeded: true },
): Promise<StableId> {
  const working = await fx.store.createWorkingRevision({
    entityType,
    entityId,
    payload,
    schemaVersion: "1",
    actor: SYSTEM,
  });
  return (await fx.store.sealRevision({ revisionId: working.id })).id;
}

async function firstPublish(fx: Fixture, entityType: string, entityId: StableId): Promise<number> {
  const revisionId = await sealRevision(fx, entityType, entityId);
  const result = await fx.publications.publish({
    entityType,
    entityId,
    targetRevisionId: revisionId,
    expectedGeneration: 0,
    actor: ACTOR,
  });
  return result.publication.generation;
}

test("changeset authoring: items bind identity/revision/generation/route; duplicates rejected", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withChangesetFixture(t, async (fx) => {
    const changeset = await fx.changesets.createChangeset({
      title: "Autumn release",
      actor: ACTOR,
    });
    assert.equal(changeset.state, "OPEN");

    const entityId = newStableId();
    const revisionId = await sealRevision(fx, "entry", entityId);
    const item = await fx.changesets.addItem(changeset.id, {
      entityType: "entry",
      entityId,
      intent: "PUBLISH",
      targetRevisionId: revisionId,
      expectedGeneration: 0,
      routeOperation: { kind: "set", siteId: "site", path: "/autumn/" },
    });
    assert.equal(item.position, 0);
    assert.deepEqual(item.targetRevisionId, revisionId);

    await assert.rejects(
      () =>
        fx.changesets.addItem(changeset.id, {
          entityType: "entry",
          entityId,
          intent: "PUBLISH",
          targetRevisionId: revisionId,
          expectedGeneration: 0,
        }),
      (error: unknown) => {
        assert.equal((error as PublicationError).code, "CHANGESET_ITEM_DUPLICATE");
        return true;
      },
    );

    const other = newStableId();
    const otherRevision = await sealRevision(fx, "entry", other);
    await fx.changesets.addItem(changeset.id, {
      entityType: "entry",
      entityId: other,
      intent: "PUBLISH",
      targetRevisionId: otherRevision,
      expectedGeneration: 0,
    });
    await fx.changesets.removeItem(
      changeset.id,
      (await fx.changesets.listItems(changeset.id)).find((i) => i.entityId === other)!.id,
    );
    assert.equal((await fx.changesets.listItems(changeset.id)).length, 1);
  });
});

test("preflight blocks unsealed targets and stale generations with stable codes", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withChangesetFixture(t, async (fx) => {
    const entityId = newStableId();
    const revisionId = await sealRevision(fx, "entry", entityId);
    const changeset = await fx.changesets.createChangeset({ title: "stale", actor: ACTOR });
    await fx.changesets.addItem(changeset.id, {
      entityType: "entry",
      entityId,
      intent: "PUBLISH",
      targetRevisionId: revisionId,
      expectedGeneration: 0,
    });

    // Publish something else first so the entity's real generation becomes 1,
    // then expect the item's authored 0 to be stale.
    const rev2 = await sealRevision(fx, "entry", entityId);
    await fx.publications.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: rev2,
      expectedGeneration: 0,
      actor: ACTOR,
    });

    const report = await fx.changesets.preflight(changeset.id);
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some((issue) => issue.code === "CHANGESET_STALE"),
      "stale generation must be reported",
    );
    assert.equal(report.observedGenerations[0]!.generation, 1);

    // Missing/unsealed target surfaces REVISION_NOT_SEALED.
    const cs2 = await fx.changesets.createChangeset({ title: "unsealed", actor: ACTOR });
    await fx.changesets.addItem(cs2.id, {
      entityType: "entry",
      entityId: newStableId(),
      intent: "PUBLISH",
      targetRevisionId: newStableId(),
      expectedGeneration: 0,
    });
    const report2 = await fx.changesets.preflight(cs2.id);
    assert.ok(report2.issues.some((issue) => issue.code === "REVISION_NOT_SEALED"));
  });
});

test("preflight validates route operations with the same rules apply enforces", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withChangesetFixture(t, async (fx) => {
    // Wire the REAL routing service as the port (the composition does the
    // same) so preflight and apply share one validator — the site-developer
    // report: preflight accepted an entry route for "/" that apply rejected
    // with ROUTE_PATH_INVALID.
    const site = await fx.routes!.ensureSite("default");

    const entityId = newStableId();
    const revisionId = await sealRevision(fx, "entry", entityId);
    const changeset = await fx.changesets.createChangeset({
      title: "Home route release",
      actor: ACTOR,
    });
    await fx.changesets.addItem(changeset.id, {
      entityType: "entry",
      entityId,
      intent: "PUBLISH",
      targetRevisionId: revisionId,
      expectedGeneration: 0,
      routeOperation: { kind: "set", siteId: site.id, path: "/" },
    });

    // §42: entries cannot claim "/" — preflight must catch it (apply did).
    const report = await fx.changesets.preflight(changeset.id);
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some((issue) => issue.code === "ROUTE_PATH_INVALID"),
      JSON.stringify(report.issues),
    );

    // A legitimate path sails through the same validator.
    const okChangeset = await fx.changesets.createChangeset({
      title: "Regular route release",
      actor: ACTOR,
    });
    await fx.changesets.addItem(okChangeset.id, {
      entityType: "entry",
      entityId,
      intent: "PUBLISH",
      targetRevisionId: revisionId,
      expectedGeneration: 0,
      routeOperation: { kind: "set", siteId: site.id, path: "/about/" },
    });
    const okReport = await fx.changesets.preflight(okChangeset.id);
    assert.equal(okReport.ok, true, JSON.stringify(okReport.issues));
  });
});

test("happy release: preflight sets READY, apply moves all pointers and sets APPLIED", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withChangesetFixture(t, async (fx) => {
    const entities = ["entry", "global_content", "theme_settings"].map((type) => ({
      type,
      id: newStableId(),
    }));
    const changeset = await fx.changesets.createChangeset({ title: "coordinated", actor: ACTOR });
    for (const { type, id } of entities) {
      const revisionId = await sealRevision(fx, type, id);
      await fx.changesets.addItem(changeset.id, {
        entityType: type,
        entityId: id,
        intent: "PUBLISH",
        targetRevisionId: revisionId,
        expectedGeneration: 0,
      });
    }
    const report = await fx.changesets.preflight(changeset.id);
    assert.equal(report.ok, true, `preflight issues: ${JSON.stringify(report.issues)}`);
    const changeset2 = await fx.changesets.getChangeset(changeset.id);
    assert.equal(changeset2.state, "READY");

    const applied = await fx.changesets.apply(changeset.id, { actor: ACTOR });
    assert.equal(applied.length, 3);
    for (const { type, id } of entities) {
      const publication = await fx.publications.getPublication(fx.pool, type, id);
      assert.equal(publication?.state, "PUBLISHED");
      assert.equal(publication?.generation, 1);
    }
    const final = await fx.changesets.getChangeset(changeset.id);
    assert.equal(final.state, "APPLIED");
    assert.deepEqual(final.appliedAt, CLOCK.now());
  });
});

test("T015: 5-entity release is internally consistent or none — concurrent drift aborts everything", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withChangesetFixture(t, async (fx) => {
    const entities = ["entry", "entry", "entry", "global_content", "navigation"] as const;
    const ids = entities.map(() => newStableId());
    const changeset = await fx.changesets.createChangeset({ title: "site release", actor: ACTOR });
    for (let i = 0; i < ids.length; i += 1) {
      const revisionId = await sealRevision(fx, entities[i]!, ids[i]!);
      await fx.changesets.addItem(changeset.id, {
        entityType: entities[i]!,
        entityId: ids[i]!,
        intent: "PUBLISH",
        targetRevisionId: revisionId,
        expectedGeneration: 0,
      });
    }
    // Preflight passes...
    const report = await fx.changesets.preflight(changeset.id);
    assert.equal(report.ok, true);
    // ...then the public state drifts: first entity is published directly.
    const drift = await sealRevision(fx, "entry", ids[0]!);
    await fx.publications.publish({
      entityType: "entry",
      entityId: ids[0]!,
      targetRevisionId: drift,
      expectedGeneration: 0,
      actor: { actorClass: "service_account", actorId: "agent" },
    });

    await assert.rejects(
      () => fx.changesets.apply(changeset.id, { actor: ACTOR }),
      (error: unknown) => {
        assert.equal((error as PublicationError).code, "CHANGESET_STALE");
        return true;
      },
    );
    // NOTHING changed beyond the deliberate drift: none of the five release
    // entities moved (ids[0] holds only the drift publish, generation 1).
    assert.equal(
      (await fx.publications.getPublication(fx.pool, "entry", ids[0]!))?.generation,
      1,
      "only the drift publish exists",
    );
    for (const id of ids.slice(1)) {
      assert.equal(await fx.publications.getPublication(fx.pool, "entry", id), null);
      assert.equal(await fx.publications.getPublication(fx.pool, "global_content", id), null);
      assert.equal(await fx.publications.getPublication(fx.pool, "navigation", id), null);
    }
    const still = await fx.changesets.getChangeset(changeset.id);
    assert.equal(still.state, "READY", "failed apply does not corrupt the changeset state");
  });
});

test("apply with route operations: route joins the same transaction", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withChangesetFixture(t, async (fx) => {
    const appliedRoutes: { path: string; entityId: StableId }[] = [];
    const changesets = createChangeSetService(fx.pool, {
      clock: CLOCK,
      revisions: fx.revisions,
      publications: fx.publications,
      routes: {
        async activateWithinTx(_tx, operation) {
          appliedRoutes.push({ path: operation.path, entityId: operation.entityId });
        },
        async retireWithinTx() {},
      },
    });
    const entityId = newStableId();
    const revisionId = await sealRevision(fx, "entry", entityId);
    const changeset = await changesets.createChangeset({ title: "with route", actor: ACTOR });
    await changesets.addItem(changeset.id, {
      entityType: "entry",
      entityId,
      intent: "PUBLISH",
      targetRevisionId: revisionId,
      expectedGeneration: 0,
      routeOperation: { kind: "set", siteId: "default", path: "/new-slug/" },
    });
    await changesets.preflight(changeset.id);
    await changesets.apply(changeset.id, { actor: ACTOR });
    assert.deepEqual(appliedRoutes, [{ path: "/new-slug/", entityId }]);
  });
});

test("cancel refuses applied changesets; published items need unpublish/rollback", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withChangesetFixture(t, async (fx) => {
    const entityId = newStableId();
    const revisionId = await sealRevision(fx, "entry", entityId);
    const changeset = await fx.changesets.createChangeset({ title: "short-lived", actor: ACTOR });
    await fx.changesets.addItem(changeset.id, {
      entityType: "entry",
      entityId,
      intent: "PUBLISH",
      targetRevisionId: revisionId,
      expectedGeneration: 0,
    });
    await fx.changesets.preflight(changeset.id);
    await fx.changesets.apply(changeset.id, { actor: ACTOR });
    await assert.rejects(
      () => fx.changesets.cancel(changeset.id, ACTOR, "too late"),
      (error: unknown) => {
        assert.equal((error as PublicationError).code, "CHANGESET_INVALID");
        return true;
      },
    );

    const open = await fx.changesets.createChangeset({ title: "cancelled", actor: ACTOR });
    const cancelled = await fx.changesets.cancel(open.id, ACTOR, "obsolete");
    assert.equal(cancelled.state, "CANCELLED");
  });
});
