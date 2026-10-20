// PCMS-PUB-T029 — reference corpus (Publication spec §78): the normative
// scenarios driven end-to-end through the REAL integrated subsystems —
// content entries, navigation (M04 sealed snapshots), routing (M04 seams),
// revisions, publication, ChangeSets — wired at the composition layer exactly
// as apps/* will wire them. Scenarios already proven in focused suites
// (CAS race, 5-entity atomic apply, 35/3/12h batch, media snapshot, worker
// retry/DLQ, lease-recovery late execution, preview security) are referenced,
// not duplicated; this corpus proves the cross-subsystem verticals.
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
import { createNavigationService, type NavigationService } from "@pcms/navigation";
import {
  type ChangeSetService,
  createChangeSetService,
  createPublicationPlanService,
  createPublicationService,
  type PublicationError,
  type PublicationPlanService,
  type PublicationService,
} from "@pcms/publication";
import {
  createRevisionStore,
  createVersionedEntityRegistry,
  type RevisionStore,
} from "@pcms/revisions";
import { createCanonicalUrlService, createRouteService, type RouteService } from "@pcms/routing";
import {
  compositeRevisionPort,
  createRouteAvailabilityValidator,
  navigationRevisionPort,
  revisionReaderFromStore,
  routeOperationsPort,
} from "../helpers/publication-composition.js";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const CLOCK = fixedClock("2026-01-15T09:00:00Z");
const ACTOR = { actorClass: "human", actorId: "editor-1" } as const;

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

interface Corpus {
  pool: DbPool;
  routes: RouteService;
  navigation: NavigationService;
  store: RevisionStore;
  publications: PublicationService;
  changesets: ChangeSetService;
  plans: PublicationPlanService;
  /** Seals a generic-entity revision and returns (entityId, revisionId). */
  seal(
    entityType: string,
    payload?: unknown,
  ): Promise<{ entityId: StableId; revisionId: StableId }>;
  navigationRevisionId(setId: StableId): Promise<StableId>;
  resolvePath(siteId: string, path: string): Promise<string>;
}

async function withCorpus(
  t: { after: (fn: () => void) => void },
  run: (corpus: Corpus) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfoOf(db),
    max: 8,
    connectionTimeoutMilliseconds: 5000,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);

  const routes = createRouteService(pool);
  const site = await routes.ensureSite("default");
  const navigation = createNavigationService(pool);
  const store = createRevisionStore(pool, {
    registry: createVersionedEntityRegistry(
      ["entry", "global_content", "theme_settings"].map((entityType) => ({
        entityType,
        description: entityType,
        validateForSeal: () => [],
      })),
    ),
    clock: CLOCK,
  });
  // Composition: composite revision port over the generic store + M04
  // navigation snapshots (owner instruction #28 — adapted, not duplicated).
  const revisions = compositeRevisionPort([
    { matches: (type) => type === "navigation", port: navigationRevisionPort(navigation) },
    { matches: () => true, port: revisionReaderFromStore(store) },
  ]);
  const publications = createPublicationService(pool, { clock: CLOCK, revisions });
  const routeOps = routeOperationsPort(routes, createCanonicalUrlService(pool));
  const routeValidator = createRouteAvailabilityValidator({
    findActiveRoute: (siteId_, path, locale) =>
      routes.findActiveRoute(siteId_, path, locale === undefined ? undefined : { locale }),
  });
  const changesets = createChangeSetService(pool, {
    clock: CLOCK,
    revisions,
    publications,
    validators: [routeValidator],
    routes: routeOps,
  });
  const jobs = (await import("@pcms/jobs")).createJobsService(pool, {
    clock: CLOCK,
    backoffBaseMilliseconds: 0,
  });
  const plans = createPublicationPlanService(pool, {
    clock: CLOCK,
    changesets,
    publications,
    jobs,
  });

  await run({
    pool,
    routes,
    navigation,
    store,
    publications,
    changesets,
    plans,
    async seal(entityType, payload = { seeded: true }) {
      const entityId = newStableId();
      const working = await store.createWorkingRevision({
        entityType,
        entityId,
        payload,
        schemaVersion: "1",
        actor: { actorClass: "system", actorId: "fixture", origin: "system" },
      });
      const sealed = await store.sealRevision({ revisionId: working.id });
      return { entityId, revisionId: sealed.id };
    },
    async navigationRevisionId(setId) {
      const revisionsList = await navigation.listRevisions(setId);
      const latest = revisionsList[revisionsList.length - 1];
      if (latest === undefined) throw new Error("no navigation revision sealed");
      return latest.id as StableId;
    },
    async resolvePath(siteId, path) {
      const resolution = await routes.resolveRoute(siteId, path);
      return resolution.kind;
    },
  });
  void site;
}

test("corpus: route rename release, then rollback preflight blocks a taken old path", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withCorpus(t, async (corpus) => {
    const siteId = (await corpus.routes.findSiteByKey("default"))!.id;
    // Entry published at /old/ (release 1: revision + route together).
    const { entityId, revisionId: revA } = await corpus.seal("entry", { title: "v1" });
    const release1 = await corpus.changesets.createChangeset({
      title: "create page",
      actor: ACTOR,
    });
    await corpus.changesets.addItem(release1.id, {
      entityType: "entry",
      entityId,
      intent: "PUBLISH",
      targetRevisionId: revA,
      expectedGeneration: 0,
      routeOperation: { kind: "set", siteId, path: "/old/" },
    });
    const preflight1 = await corpus.changesets.preflight(release1.id);
    assert.equal(preflight1.ok, true, JSON.stringify(preflight1.issues));
    await corpus.changesets.apply(release1.id, { actor: ACTOR });
    assert.equal(await corpus.resolvePath(siteId, "/old/"), "route");

    // Release 2 renames the URL: /old/ → /new/ (freesPath = combined state).
    const revB = await (async () => {
      const working = await corpus.store.createWorkingRevision({
        entityType: "entry",
        entityId,
        payload: { title: "v2" },
        schemaVersion: "1",
        actor: { actorClass: "system", actorId: "fixture", origin: "system" },
      });
      return (await corpus.store.sealRevision({ revisionId: working.id })).id;
    })();
    const release2 = await corpus.changesets.createChangeset({ title: "rename url", actor: ACTOR });
    await corpus.changesets.addItem(release2.id, {
      entityType: "entry",
      entityId,
      intent: "PUBLISH",
      targetRevisionId: revB,
      expectedGeneration: 1,
      routeOperation: { kind: "set", siteId, path: "/new/", freesPath: "/old/" },
    });
    assert.equal((await corpus.changesets.preflight(release2.id)).ok, true);
    await corpus.changesets.apply(release2.id, { actor: ACTOR });
    assert.equal(await corpus.resolvePath(siteId, "/new/"), "route");
    assert.equal(
      await corpus.resolvePath(siteId, "/old/"),
      "not_found",
      "old path retired, no silent alias",
    );

    // A third page takes /old/ (it is free after the rename).
    const rival = await corpus.seal("entry", { title: "rival" });
    await corpus.routes.activateRoute({
      siteId,
      path: "/old/",
      targetType: "entry",
      targetId: rival.entityId,
    });

    // Rollback release wants /old/ back — preflight must reject (owner
    // instruction #26: never assume the old path is still free).
    const rollback = await corpus.changesets.createChangeset({
      title: "rollback rename",
      actor: ACTOR,
    });
    await corpus.changesets.addItem(rollback.id, {
      entityType: "entry",
      entityId,
      intent: "PUBLISH",
      targetRevisionId: revA,
      expectedGeneration: 2,
      routeOperation: { kind: "set", siteId, path: "/old/", freesPath: "/new/" },
    });
    const rollbackPreflight = await corpus.changesets.preflight(rollback.id);
    assert.equal(rollbackPreflight.ok, false);
    assert.ok(rollbackPreflight.issues.some((issue) => issue.code === "ROUTE_CONFLICT"));
    await assert.rejects(
      () => corpus.changesets.apply(rollback.id, { actor: ACTOR }),
      (error: unknown) => {
        assert.equal((error as PublicationError).code, "CHANGESET_INVALID");
        return true;
      },
    );
    // Public state untouched by the blocked rollback.
    assert.equal(await corpus.resolvePath(siteId, "/new/"), "route");
  });
});

test("corpus: navigation + content release publishes sealed nav snapshot and entry atomically", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withCorpus(t, async (corpus) => {
    const siteId = (await corpus.routes.findSiteByKey("default"))!.id;

    // Working navigation tree + a content entry.
    const set = await corpus.navigation.createSet({ key: "main", title: "Main menu" });
    await corpus.navigation.insertItem({
      setId: set.id,
      type: "group",
      label: "Sections",
    });
    await corpus.navigation.sealRevision(set.id);
    const navRevisionId = await corpus.navigationRevisionId(set.id as StableId);
    const { entityId, revisionId } = await corpus.seal("entry", { title: "About" });
    await corpus.routes.activateRoute({
      siteId,
      path: "/about/",
      targetType: "entry",
      targetId: entityId,
    });

    // One release: content + navigation revision together (spec §18).
    const release = await corpus.changesets.createChangeset({ title: "site update", actor: ACTOR });
    await corpus.changesets.addItem(release.id, {
      entityType: "entry",
      entityId,
      intent: "PUBLISH",
      targetRevisionId: revisionId,
      expectedGeneration: 0,
    });
    await corpus.changesets.addItem(release.id, {
      entityType: "navigation",
      entityId: set.id as StableId,
      intent: "PUBLISH",
      targetRevisionId: navRevisionId,
      expectedGeneration: 0,
    });
    const preflight = await corpus.changesets.preflight(release.id);
    assert.equal(preflight.ok, true, JSON.stringify(preflight.issues));
    await corpus.changesets.apply(release.id, { actor: ACTOR });

    // Both pointers public; navigation renders the published SNAPSHOT.
    const entryPublication = await corpus.publications.getPublication(
      fx_pool(corpus),
      "entry",
      entityId,
    );
    assert.equal(entryPublication?.state, "PUBLISHED");
    const navPublication = await corpus.publications.getPublication(
      corpus.pool,
      "navigation",
      set.id as StableId,
    );
    assert.equal(navPublication?.state, "PUBLISHED");
    const publishedNav = await corpus.publications.getPublishedRevision(
      corpus.pool,
      "navigation",
      set.id as StableId,
    );
    assert.ok(publishedNav !== null);
    // M04 snapshots store the tree as a bare NavigationItemNode[] array.
    const tree = publishedNav.payload as unknown[];
    assert.equal(Array.isArray(tree), true, "sealed tree snapshot round-trips");
    assert.equal(tree.length >= 1, true);

    // Route + published pointer → renderable path (M07 public render seam).
    const resolution = await corpus.routes.resolveRoute(siteId, "/about/");
    assert.equal(resolution.kind, "route");

    // Outbox carries both events from the single release transaction.
    const outbox = (await import("@pcms/publication")).createOutboxService(corpus.pool, {
      // Outbox rows take their available_at from the DB default (real now()),
      // so the claim clock must trail real wall clock by a safe margin — a
      // hardcoded future date rots the moment the calendar reaches it.
      clock: fixedClock(new Date(Date.now() + 3_600_000).toISOString()),
    });
    const claimed = await outbox.claimBatch(10);
    const types = claimed.map((event) => event.eventType).sort();
    assert.deepEqual(types, ["ChangeSetApplied", "EntryPublished", "NavigationPublished"]);
  });
});

test("corpus: scheduled full-site release (content + globals + theme settings)", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withCorpus(t, async (corpus) => {
    // 3 generic entities (2 entries + theme settings) scheduled per-item.
    const cs = await corpus.changesets.createChangeset({ title: "scheduled site", actor: ACTOR });
    const targets: { entityType: string; entityId: StableId; revisionId: StableId }[] = [];
    for (const entityType of ["entry", "entry", "theme_settings"]) {
      const { entityId, revisionId } = await corpus.seal(entityType);
      targets.push({ entityType, entityId, revisionId });
      await corpus.changesets.addItem(cs.id, {
        entityType,
        entityId,
        intent: "PUBLISH",
        targetRevisionId: revisionId,
        expectedGeneration: 0,
      });
    }
    const plan = await corpus.plans.createPlan({
      changesetId: cs.id,
      timezone: "Europe/Berlin",
      failurePolicy: "pause_plan",
      actor: ACTOR,
    });
    await corpus.plans.compilePlan(plan.id, {
      startAt: new Date("2026-01-15T09:00:00Z"),
      batchSize: 2,
      interval: { unit: "hours", value: 6 },
    });

    // Execute the due jobs through the real handlers.
    const handlers = (await import("@pcms/publication")).createPublicationJobHandlers({
      pool: corpus.pool,
      clock: CLOCK,
      publications: corpus.publications,
      changesets: corpus.changesets,
      siteKey: "default",
    });
    const jobsService = (await import("@pcms/jobs")).createJobsService(corpus.pool, {
      clock: CLOCK,
      backoffBaseMilliseconds: 0,
    });
    // Batch 0 (two items) executes at its scheduled instant...
    for (let round = 0; round < 3; round += 1) {
      const claimed = await jobsService.claim({
        workerId: "corpus",
        limit: 10,
        leaseMilliseconds: 60_000,
      });
      if (claimed.length === 0) break;
      for (const job of claimed) {
        const handler = handlers[job.type as "publication.publish"];
        await handler(job.payload as never, {
          job: { id: job.id as string },
          attempt: job.attempts,
        });
      }
    }
    // ...batch 1 (6h later) executes when a worker picks it up after recovery
    // (late execution default, spec §32): the claim clock advances.
    const laterJobs = (await import("@pcms/jobs")).createJobsService(corpus.pool, {
      clock: fixedClock("2026-01-15T15:00:00Z"),
      backoffBaseMilliseconds: 0,
    });
    const laterClaimed = await laterJobs.claim({
      workerId: "corpus-2",
      limit: 10,
      leaseMilliseconds: 60_000,
    });
    for (const job of laterClaimed) {
      const handler = handlers[job.type as "publication.publish"];
      await handler(job.payload as never, { job: { id: job.id as string }, attempt: job.attempts });
    }
    for (const target of targets) {
      const publication = await corpus.publications.getPublication(
        corpus.pool,
        target.entityType,
        target.entityId,
      );
      assert.equal(publication?.state, "PUBLISHED");
    }
    assert.equal((await corpus.plans.getPlan(plan.id)).status, "COMPLETED");
  });
});

test("corpus: SEO public dates + sitemap eligibility composition from publication facts", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withCorpus(t, async (corpus) => {
    const siteId = (await corpus.routes.findSiteByKey("default"))!.id;
    const { entityId, revisionId } = await corpus.seal("entry", { title: "SEO page" });
    await corpus.routes.activateRoute({
      siteId,
      path: "/seo-page/",
      targetType: "entry",
      targetId: entityId,
    });
    await corpus.publications.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: revisionId,
      expectedGeneration: 0,
      actor: ACTOR,
    });

    // Publication facts (the M06 seams, now authoritative):
    const publication = await corpus.publications.getPublication(corpus.pool, "entry", entityId);
    assert.ok(publication?.firstPublishedAt !== null, "first_published_at available");
    assert.ok(publication?.modifiedAt !== null, "last_public_content_modified_at available");

    // Composition: sitemap candidates from publication state + routing
    // (the authoritative SitemapCandidate provider M06's seam expects).
    const published = await corpus.publications.listPublished(corpus.pool, "entry");
    const routes = await corpus.routes.listRoutes(siteId);
    const built: {
      entryId: string;
      path: string;
      lastmod: string | null;
      eligibility: { public: boolean; http200: boolean };
    }[] = [];
    for (const record of published) {
      const match = routes.find(
        (candidate) => candidate.targetType === "entry" && candidate.targetId === record.entityId,
      );
      if (match !== undefined) {
        built.push({
          entryId: record.entityId,
          path: match.path,
          lastmod: record.modifiedAt?.toISOString() ?? null,
          eligibility: { public: record.state === "PUBLISHED", http200: true },
        });
      }
    }
    assert.equal(built.length, 1);
    assert.equal(built[0]!.path, "/seo-page/");
    assert.equal(built[0]!.eligibility.public, true);
    assert.equal(built[0]!.lastmod, "2026-01-15T09:00:00.000Z");
  });
});

// Tiny helper to keep assert lines readable.
function fx_pool(corpus: Corpus): DbPool {
  return corpus.pool;
}
