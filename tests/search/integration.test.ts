// PCMS-SEARCH-T009/T010/T017 — search pipeline integration over real
// PostgreSQL: publication outbox events drive the derived index; the full
// lifecycle (publish → update → rollback → unpublish → republish) stays
// consistent; redelivery is idempotent; stale events cannot regress the
// projection; a rebuild with a concurrent event loses nothing; drafts and
// noindex content never appear in public results.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApplicationServices } from "@pcms/api";
import {
  archiveEntry,
  createDraft,
  publishRevision,
  rollbackPublication,
  sealRevision,
  setHomeEntryOp,
  unpublishPublication,
} from "@pcms/api";
import { systemClock } from "@pcms/core";
import { createOutboxConsumer, createOutboxService } from "@pcms/publication";
import { createSearchOutboxHandlers } from "@pcms/search";
import { emptySeoDocument } from "@pcms/seo";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const CONTENT_TYPES = [
  {
    key: "page",
    version: 1,
    title: "Page",
    bodyPolicy: "block_document",
    fields: {
      title: { id: "title", type: "string", required: true },
      intro: { id: "intro", type: "text" },
      sku: { id: "sku", type: "string", searchable: true, search_weight: "D" },
    },
  },
] as const;

const CTX = () => apiContextOf(ownerActor(), "rest", "req_search");

interface Fixture {
  readonly app: ApplicationServices;
  readonly processOutbox: () => Promise<number>;
  readonly publishPage: (input: {
    readonly entryId?: string;
    readonly title: string;
    readonly intro?: string;
    readonly sku?: string;
    readonly locale?: string;
    readonly path?: string;
    readonly expectedGeneration?: number;
    readonly entryGeneration?: number;
  }) => Promise<{ entryId: string; revisionId: string; generation: number }>;
}

async function setup(t: { after: (fn: () => void) => void }): Promise<Fixture> {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...CONTENT_TYPES],
    seoEnvironment: "production",
  });
  const site = await app.routes.ensureSite("default");
  // Locale-scoped corpus (`ru`/`en`): the site must declare multilingual,
  // because entry identity locales follow the declared policy.
  await app.localization.update({
    enabled: true,
    defaultLocale: "ru",
    locales: ["ru", "en"],
    updatedBy: "test",
  });
  // Real wall clock: publication_outbox.available_at is DB now(); the fixed
  // fixture clock would make fresh events permanently unclaimable.
  const outbox = createOutboxService(app.pool, { clock: systemClock });
  const consumer = createOutboxConsumer(
    outbox,
    createSearchOutboxHandlers({ indexing: app.searchIndexing }),
    { fallback: async () => {} },
  );
  const processOutbox = async (): Promise<number> => consumer.processBatch(100);

  const payloadOf = (input: Parameters<Fixture["publishPage"]>[0]) => ({
    fields: {
      title: input.title,
      ...(input.intro === undefined ? {} : { intro: input.intro }),
      ...(input.sku === undefined ? {} : { sku: input.sku }),
    },
    blocks: { schema_version: 1, blocks: [] },
  });

  const publishPage: Fixture["publishPage"] = async (input) => {
    // New entries go through the public createDraft op; updates create the
    // next working revision on the existing entry (M07 revision flow).
    let entryId = input.entryId;
    let revisionId: string;
    if (entryId === undefined) {
      // New entry: the public createDraft op creates entry + first revision.
      const draft = await createDraft(app, CTX(), {
        content_type: "page",
        payload: payloadOf(input),
        locale: input.locale ?? "ru",
      });
      entryId = draft.entry_id;
      revisionId = draft.revision_id;
    } else {
      // Update: the next working revision on the existing entry (M07 flow).
      const created = await app.revisions.createWorkingRevision({
        entityType: "entry",
        entityId: entryId as never,
        payload: payloadOf(input),
        schemaVersion: "1",
        locale: input.locale ?? "ru",
        actor: {
          actorClass: "human",
          actorId: "test-owner",
          origin: "human",
          sourceRunId: "req_search",
        },
      });
      revisionId = created.id;
    }
    await sealRevision(app, CTX(), { revision_id: revisionId });
    const publication = await app.publications.getPublication(app.pool, "entry", entryId as never);
    const expected = input.expectedGeneration ?? publication?.generation ?? 0;
    await publishRevision(app, CTX(), {
      entity_type: "entry",
      entity_id: entryId,
      target_revision_id: revisionId,
      expected_generation: expected,
    });
    if (input.path !== undefined && input.entryId === undefined) {
      await app.routes.activateRoute({
        siteId: site.id,
        path: input.path,
        targetType: "entry",
        targetId: entryId,
      });
    }
    return { entryId, revisionId, generation: expected + 1 };
  };

  return { app, processOutbox, publishPage };
}

const QUERY = (app: ApplicationServices, q: string, locale = "ru") =>
  app.searchQuery({ q, locale, site: "default" });
const QUERY_SITE = (app: ApplicationServices, q: string, locale: string, site: string) =>
  app.searchQuery({ q, locale, site });

test("publication lifecycle drives the public index end to end", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { app, processOutbox, publishPage } = await setup(t);

  // --- publish → outbox → indexed → found. ---
  const first = await publishPage({
    title: "Внедрение ERP-систем",
    intro: "Автоматизация производства",
    sku: "ERP-2026-PRO",
    path: "/services/erp/",
  });
  assert.equal(await processOutbox(), 1);
  const found = await QUERY(app, "внедрении");
  assert.equal(found.total, 1);
  assert.equal(found.items[0]?.entity_id, first.entryId);
  assert.equal(found.items[0]?.path, "/services/erp/");
  assert.equal(found.items[0]?.title, "Внедрение ERP-систем");
  // Product code corpus (aux vector).
  assert.equal((await QUERY(app, "ERP-2026-PRO")).total, 1);

  // --- Idempotent redelivery of the SAME event: index unchanged. ---
  assert.equal(await processOutbox(), 0); // already DONE
  const again = await QUERY(app, "внедрении");
  assert.equal(again.total, 1);

  // --- Update (second publication) replaces the document. ---
  await publishPage({
    entryId: first.entryId,
    title: "Внедрение ERP-систем v2",
    intro: "Обновлённый текст",
    expectedGeneration: first.generation,
  });
  assert.equal(await processOutbox(), 1);
  const updated = await QUERY(app, "Обновлённый");
  assert.equal(updated.total, 1);
  const stale = await QUERY(app, "Автоматизация производства");
  assert.equal(stale.total, 0, "old body text leaves the index after update");

  // --- Stale event: a late generation-1 delivery cannot regress generation 2+. ---
  await app.searchIndexing.applyPublicationEvent({
    id: "stale-event-1",
    eventType: "EntryPublished",
    payload: {
      entityType: "entry",
      entityId: first.entryId,
      context: "default",
      generation: 1,
      revisionId: first.revisionId,
    },
    createdAt: new Date(),
  });
  assert.equal((await QUERY(app, "Обновлённый")).total, 1, "stale write ignored");

  // --- Unpublish removes; republish restores. ---
  await unpublishPublication(app, CTX(), {
    entity_type: "entry",
    entity_id: first.entryId,
    expected_generation: first.generation + 1,
  });
  assert.equal(await processOutbox(), 1);
  assert.equal((await QUERY(app, "внедрении")).total, 0, "unpublished content is not public");
  await publishRevision(app, CTX(), {
    entity_type: "entry",
    entity_id: first.entryId,
    target_revision_id: first.revisionId,
    expected_generation: first.generation + 2,
  });
  assert.equal(await processOutbox(), 1);
  assert.equal((await QUERY(app, "внедрении")).total, 1, "republished content is public again");
});

test("rollback restores the previous public revision in the index", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { app, processOutbox, publishPage } = await setup(t);
  // Distinctive non-stopword lexemes (russian config drops «один/два»).
  const first = await publishPage({ title: "Альфа-ревизия", path: "/pages/one/" });
  assert.equal(await processOutbox(), 1);
  const second = await publishPage({
    entryId: first.entryId,
    title: "Бета-ревизия",
    expectedGeneration: first.generation,
  });
  assert.equal(await processOutbox(), 1);
  assert.equal((await QUERY(app, "Бета")).total, 1);

  await rollbackPublication(app, CTX(), {
    entity_type: "entry",
    entity_id: first.entryId,
    target_revision_id: first.revisionId,
    expected_generation: second.generation,
  });
  assert.equal(await processOutbox(), 1);
  assert.equal((await QUERY(app, "Бета")).total, 0);
  assert.equal((await QUERY(app, "Альфа")).total, 1, "rolled-back revision is searchable again");
});

test("drafts, noindex and unrouted content never leak into public search", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { app, processOutbox, publishPage } = await setup(t);

  // Published but noindex (SEO policy owns indexability; Search spec §4).
  const noindex = await publishPage({ title: "Секретная страница", path: "/pages/secret/" });
  await app.seo.saveDocument(noindex.entryId, {
    ...emptySeoDocument(),
    robots_policy: { index: false, follow: true },
  });
  assert.equal(await processOutbox(), 1);
  assert.equal((await QUERY(app, "Секретная")).total, 0, "noindex never enters the public index");

  // A draft (WORKING revision, never published) must stay invisible even if
  // a forged/duplicate event arrives for it.
  const draft = await createDraft(app, CTX(), {
    content_type: "page",
    payload: { fields: { title: "Черновик будущего" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await app.searchIndexing.applyPublicationEvent({
    id: "forged-draft-event",
    eventType: "EntryPublished",
    payload: { entityType: "entry", entityId: draft.entry_id, context: "default", generation: 1 },
    createdAt: new Date(),
  });
  assert.equal((await QUERY(app, "Черновик")).total, 0, "drafts never leak publicly");

  // Admin authorized search sees the draft title (Search spec §24) while
  // public results stay empty.
  const admin = await app.searchAdmin({ q: "Черновик", locale: "default", site: "default" });
  assert.equal(admin.drafts.length, 1);
  assert.equal(admin.drafts[0]?.title, "Черновик будущего");
  assert.equal(admin.published.total, 0);

  // The published-but-noindex entry is administratively visible in drafts?
  // No — it is published; the admin mode reports published docs it CAN see.
  const adminNoindex = await app.searchAdmin({ q: "Секретная", locale: "ru", site: "default" });
  assert.equal(adminNoindex.drafts.length, 0);
});

test("full reindex rebuilds exact public state and never loses concurrent events", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { app, processOutbox, publishPage } = await setup(t);

  const a = await publishPage({ title: "Первая страница", path: "/pages/first/" });
  const b = await publishPage({ title: "Вторая страница", path: "/pages/second/" });
  assert.equal(await processOutbox(), 2);
  assert.equal((await QUERY(app, "страница")).total, 2);

  // Index drifts: an extra document exists that the source no longer derives.
  await app.searchProvider.index({
    entity_type: "entry",
    entity_id: "ghost-entity",
    context: "default",
    site_id: "default",
    locale: "ru",
    content_type: "page",
    revision_id: "ghost-rev",
    generation: 1,
    title: "Призрачный документ",
    summary: "",
    structured_text: "",
    body_text: "Мусор в индексе",
    aux_text: "",
    route: "/ghost/",
    published_at: null,
    modified_at: null,
  });

  // Start the shadow rebuild, then land a concurrent publication mid-rebuild.
  const run = await app.searchReindex.start();
  assert.equal(run.totalDocuments, 2);
  const concurrent = await publishPage({ title: "Конкурентная страница", path: "/pages/third/" });
  await processOutbox(); // dual-writes into active + building epochs

  await app.searchReindex.processChunk({
    runId: run.runId,
    chunkIndex: 0,
    phase: "entry",
    after: null,
    limit: 500,
  });
  assert.equal(await app.searchReindex.finalize({ runId: run.runId }), "done");

  // Exact public state: 3 documents, ghost gone, concurrent publication kept.
  const health = await app.searchProvider.health();
  assert.equal(health.document_count, 3);
  assert.equal(health.reindex_required, false);
  assert.equal((await QUERY(app, "Призрачный")).total, 0, "rebuild drops drifted documents");
  assert.equal((await QUERY(app, "Конкурентная")).total, 1, "mid-rebuild publication survives");
  for (const id of [a.entryId, b.entryId, concurrent.entryId]) {
    const all = await QUERY(app, "страница");
    assert.ok(
      all.items.some((item) => item.entity_id === id),
      `entity ${id} in rebuilt index`,
    );
  }

  // Resume semantics: a second run over a completed index is conflict-free.
  const second = await app.searchReindex.start();
  await app.searchReindex.processChunk({
    runId: second.runId,
    chunkIndex: 0,
    phase: "entry",
    after: null,
    limit: 500,
  });
  assert.equal(await app.searchReindex.finalize({ runId: second.runId }), "done");
  assert.equal((await app.searchProvider.health()).document_count, 3);

  // A second start() while building conflicts (fail-secure).
  await app.searchReindex.start();
  await assert.rejects(
    () => app.searchReindex.start(),
    (error: unknown) => (error as { code?: string }).code === "SEARCH_REINDEX_CONFLICT",
  );
  const buildingRun = (await app.searchReindex.listRuns(1))[0];
  assert.ok(buildingRun !== undefined);
  await app.searchReindex.processChunk({
    runId: buildingRun.run_id,
    chunkIndex: 0,
    phase: "entry",
    after: null,
    limit: 500,
  });
  assert.equal(await app.searchReindex.finalize({ runId: buildingRun.run_id }), "done");
});

test("site and locale scoping keeps tenants and languages isolated", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { app, processOutbox, publishPage } = await setup(t);
  await publishPage({ title: "Русскоязычная услуга", locale: "ru", path: "/uslugi/" });
  await publishPage({ title: "English service page", locale: "en", path: "/en/services/" });
  assert.equal(await processOutbox(), 2);
  assert.equal((await QUERY(app, "услуга", "ru")).total, 1);
  assert.equal((await QUERY(app, "service", "en")).total, 1);
  assert.equal((await QUERY(app, "услуга", "en")).total, 0, "ru lexeme not under en scope");
  assert.equal((await QUERY(app, "услуга", "ru")).items[0]?.path, "/uslugi/");
});

test("reindex includes a published home binding without a route row", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { app, publishPage } = await setup(t);
  const home = await publishPage({ title: "Домашняя главная страница" });
  const ordinary = await publishPage({
    title: "Обычная индексируемая страница",
    path: "/pages/ordinary/",
  });
  const site = await app.routes.ensureSite("default");
  await app.routes.setHomeEntry(site.id, home.entryId);
  const homeRoutes = await app.pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM routes WHERE target_id = $1 AND retired_at IS NULL`,
    [home.entryId],
  );
  assert.equal(Number(homeRoutes.rows[0]?.count), 0, "home has no route row");

  await app.searchReindex.runSynchronously();

  const homeResult = await QUERY(app, "Домашняя");
  assert.equal(homeResult.total, 1);
  assert.equal(homeResult.items[0]?.entity_id, home.entryId);
  assert.equal(homeResult.items[0]?.path, "/");
  assert.equal((await QUERY(app, "Обычная")).items[0]?.entity_id, ordinary.entryId);
  assert.equal((await QUERY(app, "Обычная")).items[0]?.path, "/pages/ordinary/");

  // A canonical route may coexist with the home binding, but contributes no
  // second document and cannot replace the root path.
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/pages/home-alias/",
    targetType: "entry",
    targetId: home.entryId,
  });
  await app.searchReindex.runSynchronously();
  const routedHome = await QUERY(app, "Домашняя");
  assert.equal(routedHome.total, 1);
  assert.equal(routedHome.items[0]?.path, "/");

  await app.seo.saveDocument(home.entryId, {
    ...emptySeoDocument(),
    robots_policy: { index: false, follow: true },
  });
  await app.searchReindex.runSynchronously();
  assert.equal((await QUERY(app, "Домашняя")).total, 0, "noindex home is excluded");

  await app.seo.saveDocument(home.entryId, emptySeoDocument());
  await app.searchReindex.runSynchronously();
  assert.equal((await QUERY(app, "Домашняя")).items[0]?.path, "/");
  await archiveEntry(app, CTX(), { entry_id: home.entryId });
  await app.searchReindex.runSynchronously();
  assert.equal((await QUERY(app, "Домашняя")).total, 0, "archived home is excluded");
});

test("home binding changes refresh both search documents and preserve scope", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { app, processOutbox, publishPage } = await setup(t);
  const first = await publishPage({ title: "Homefirst unique", path: "/pages/first-home/" });
  const second = await publishPage({ title: "Homesecond unique", path: "/pages/second-home/" });
  assert.equal(await processOutbox(), 2);

  await setHomeEntryOp(app, CTX(), { entry_id: first.entryId });
  assert.equal(await processOutbox(), 1);
  const firstHome = await QUERY(app, "Homefirst");
  assert.equal(firstHome.total, 1);
  assert.equal(firstHome.items[0]?.path, "/");
  assert.equal((await QUERY(app, "Homesecond")).items[0]?.path, "/pages/second-home/");
  await setHomeEntryOp(app, CTX(), { entry_id: first.entryId });
  assert.equal(await processOutbox(), 0, "repeating the current binding emits no duplicate event");

  await setHomeEntryOp(app, CTX(), { entry_id: second.entryId });
  assert.equal(await processOutbox(), 1);
  assert.equal((await QUERY(app, "Homefirst")).items[0]?.path, "/pages/first-home/");
  assert.equal((await QUERY(app, "Homesecond")).items[0]?.path, "/");
  assert.equal((await QUERY(app, "Homefirst", "en")).total, 0, "home is locale scoped");

  const secondPublication = await app.publications.getPublication(
    app.pool,
    "entry",
    second.entryId as never,
  );
  assert.ok(secondPublication);
  await unpublishPublication(app, CTX(), {
    entity_type: "entry",
    entity_id: second.entryId,
    expected_generation: secondPublication.generation,
  });
  assert.equal(await processOutbox(), 1);
  assert.equal((await QUERY(app, "Homesecond")).total, 0, "unpublished home is removed");

  const other = await publishPage({ title: "Other tenant home", locale: "ru" });
  const otherSite = await app.routes.ensureSite("other");
  await app.routes.setHomeEntry(otherSite.id, other.entryId);
  await app.searchReindex.runSynchronously();
  assert.equal((await QUERY(app, "Other tenant", "ru")).total, 0);
  const otherResult = await QUERY_SITE(app, "Other tenant", "ru", "other");
  assert.equal(otherResult.total, 1);
  assert.equal(otherResult.items[0]?.path, "/");
});
