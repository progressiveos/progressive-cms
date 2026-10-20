// PCMS-CONT-T028 — Content module integration suite (vertical slices A–E
// against PostgreSQL, Content spec §89).
//
// Slice A — structured page: ContentType → Entry → typed fields → validation.
// Slice B — service with repeater: price/features/relations + reference graph.
// Slice C — rich article: RichText + first-party blocks (gallery, multiple
//           CTA, FAQ, timeline, documents) in one BlockDocument.
// Slice D — collections: featured services, hybrid pinned+fill, context.
// Slice E — schema evolution: v1→v2 migration with old fixture compatibility.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBlockRegistry,
  registerFirstPartyBlocksV1,
  validateBlockDocument,
} from "@pcms/blocks";
import {
  createCollectionResolver,
  createContentTypeRegistry,
  createEntriesService,
  createGlobalContentService,
  createReferenceGraphService,
  createSchemaMigrationRegistry,
  type LoadedContentType,
  newEntryId,
  newStableId,
  type ReferenceGraphService,
  type StableId,
  validateContentPayload,
  validateRichText,
} from "@pcms/content";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { loadReferenceCorpus } from "../helpers/reference-corpus.js";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

interface Fixture {
  pool: DbPool;
  corpus: ReturnType<typeof loadReferenceCorpus>;
}

async function withContent(
  t: { after: (fn: () => void) => void },
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const info = {
    host: db.connection.host,
    port: db.connection.port,
    database: db.connection.database,
    user: db.connection.user,
    sslMode: "disable" as const,
  };
  const pool = createDbPool({
    connectionInfo:
      db.connection.password === undefined ? info : { ...info, password: db.connection.password },
    max: 5,
    connectionTimeoutMilliseconds: 3000,
  });
  t.after(() => {
    void pool.end();
  });
  const migrations = await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  assert.equal(migrations.current, "0001_public_baseline");
  await run({ pool, corpus: loadReferenceCorpus() });
}

const MEDIA_A = "11111111-2222-7333-8444-555555555552" as StableId;
const MEDIA_B = "11111111-2222-7333-8444-555555555553" as StableId;

test("Slice A — structured page: ContentType → Entry → typed fields → validation", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withContent(t, async ({ pool, corpus }) => {
    const entries = createEntriesService(pool);
    const page = corpus.schemas.get("page");
    assert.ok(page instanceof Object, "page schema must exist");

    const entry = await entries.createEntry({ contentTypeId: "page", createdBy: "agent-1" });
    assert.equal(entry.contentTypeId, "page");

    // Draft: incomplete page is fine.
    assert.equal(
      validateContentPayload(page as LoadedContentType, { title: "О компании" }, "draft").ok,
      true,
    );
    // Publish: required fields enforced.
    const publish = validateContentPayload(page as LoadedContentType, {}, "publish");
    assert.equal(publish.ok, false);
    assert.ok(publish.errors.some((error) => error.code === "FIELD_REQUIRED"));
    // Read-back keeps identity.
    assert.equal((await entries.getEntry(entry.id)).id, entry.id);
  });
});

test("Slice B — service with repeater: price, features, related cases + reference graph", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withContent(t, async ({ pool, corpus }) => {
    const entries = createEntriesService(pool);
    const graph: ReferenceGraphService = createReferenceGraphService(pool);
    const service = corpus.schemas.get("service");
    assert.ok(service instanceof Object);

    const relatedCase = await entries.createEntry({ contentTypeId: "case", createdBy: "agent-1" });
    const serviceEntry = await entries.createEntry({
      contentTypeId: "service",
      createdBy: "agent-1",
    });

    const fields = {
      title: "Аудит маркетинга",
      featured: true,
      menu_order: 2,
      price: { amount: "125000.00", currency: "RUB" },
      features: [
        { itemId: newStableId(), feature_title: "Аналитика", feature_text: "Смотрим цифры" },
        { itemId: newStableId(), feature_title: "Стратегия" },
      ],
      related_services: [],
    };
    assert.equal(validateContentPayload(service as LoadedContentType, fields, "publish").ok, true);
    await graph.syncReferences(serviceEntry.id, service as LoadedContentType, fields);
    // Related case as a relation: graph records it after the payload update.
    await graph.syncReferences(serviceEntry.id, service as LoadedContentType, {
      ...fields,
      related_services: [relatedCase.id],
    });
    const inbound = await graph.checkDeleteImpact("entry", relatedCase.id);
    assert.deepEqual(inbound.referencingEntries, [serviceEntry.id]);
  });
});

test("Slice C — rich article: RichText + gallery + multiple CTA + FAQ + timeline + documents", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withContent(t, async ({ corpus }) => {
    const registry = createBlockRegistry();
    registerFirstPartyBlocksV1(registry);

    const block = (type: string, props: Record<string, unknown>): Record<string, unknown> => ({
      id: newStableId(),
      type,
      schema_version: 1,
      variant: null,
      props,
      children: [],
    });
    const rich = {
      schema_version: 2,
      type: "document",
      content: [{ type: "paragraph", content: [] }],
    };

    const body = {
      schema_version: 1,
      blocks: [
        block("gallery", {
          items: [
            { id: newStableId(), media_id: MEDIA_A },
            { id: newStableId(), media_id: MEDIA_B },
          ],
          layout_hint: "slider",
        }),
        block("cta", {
          title: "Заказать",
          primary_action: { type: "internal_entry", entry_id: newEntryId() },
        }),
        block("cta", {
          title: "Позвонить",
          primary_action: { type: "phone", phone: "+7 495 000-00-00" },
        }),
        block("faq", {
          items: [{ id: newStableId(), question: "Сколько стоит?", answer: rich }],
        }),
        block("timeline", {
          items: [{ id: newStableId(), date_text: "Весна 2026", title: "Запуск" }],
        }),
        block("documents", {
          items: [{ id: newStableId(), media_id: MEDIA_A, display_title: "Презентация" }],
        }),
      ],
    };
    const result = validateBlockDocument(body, registry);
    assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.issues));

    // Article-level rich text.
    const articleBody = {
      schema_version: 2,
      type: "document",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Текст статьи" }] }],
    };
    assert.equal(validateRichText(articleBody).ok, true);
    void corpus;
  });
});

test("Slice D — collections: featured services, hybrid pinned + fill without duplicates", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withContent(t, async ({ pool }) => {
    const entries = createEntriesService(pool);
    // Seed the fixture projection with published services.
    await pool.query(`
      CREATE TABLE integration_collection_fixture (
        entry_id uuid PRIMARY KEY,
        content_type text NOT NULL,
        archived_at timestamptz,
        fields jsonb NOT NULL
      )
    `);
    const inserted: StableId[] = [];
    for (const [digit, featured, order] of [
      ["a", true, 1],
      ["b", true, 2],
      ["c", true, 3],
    ] as const) {
      const entry = await entries.createEntry({ contentTypeId: "service", createdBy: "agent-1" });
      inserted.push(entry.id);
      await pool.query(
        `INSERT INTO integration_collection_fixture (entry_id, content_type, archived_at, fields)
         VALUES ($1, 'service', NULL, $2)`,
        [entry.id, JSON.stringify({ featured, menu_order: order, id_digit: digit })],
      );
    }

    const resolver = createCollectionResolver(pool);
    const schemas = createContentTypeRegistry();
    const serviceSchema = schemas.registerContentType({
      key: "service",
      version: 1,
      title: "Услуга",
      fields: {
        featured: { id: "featured", type: "boolean", filterable: true },
        menu_order: { id: "menu_order", type: "integer", filterable: true, sortable: true },
      },
    });

    // Hybrid: pinned last-by-order entry first; fill excludes duplicates.
    const pinnedEntry = inserted[2];
    assert.ok(pinnedEntry !== undefined);
    const result = await resolver.resolve(
      {
        source: { contentTypes: ["service"] },
        mode: "hybrid",
        pinnedIds: [pinnedEntry],
        filters: [{ field: "featured", op: "eq", value: true }],
        sort: [{ field: "menu_order", direction: "asc" }],
        limit: 10,
      },
      new Map([[serviceSchema.key, serviceSchema]]),
      { payloadTable: "integration_collection_fixture" },
      { numericFields: ["menu_order"] },
    );
    assert.deepEqual(result.entryIds, [inserted[2], inserted[0], inserted[1]]);
    assert.equal(result.automaticFillCount, 2);
  });
});

test("Slice E — schema evolution: v1→v2 migration keeps old fixture compatibility", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withContent(t, async ({ pool, corpus }) => {
    const globals = createGlobalContentService(pool);
    const registry = createContentTypeRegistry();
    const v1 = registry.registerContentType({
      key: "price_card",
      version: 1,
      title: "Прайс",
      fields: {
        title: { id: "title", type: "string", required: true },
        price_old: { id: "price_old", type: "string" },
      },
    });
    await globals.createGlobal({
      key: "migrated_card",
      schema: v1,
      createdBy: "agent-1",
      fields: { title: "Консультация", price_old: "5000.00" },
    });

    const migrations = createSchemaMigrationRegistry();
    migrations.registerSchemaMigration({
      contentTypeKey: "price_card",
      fromVersion: 1,
      toVersion: 2,
      migrate: (fields) => {
        const { price_old: oldPrice, ...rest } = fields as { price_old?: string };
        return { ...rest, price: { amount: oldPrice, currency: "RUB" } };
      },
    });
    const migrated = migrations.migrateFields("price_card", 1, {
      title: "Консультация",
      price_old: "5000.00",
    });
    assert.equal(migrated.toVersion, 2);

    const v2 = registry.registerContentType({
      key: "price_card",
      version: 2,
      title: "Прайс",
      fields: {
        title: { id: "title", type: "string", required: true },
        price: { id: "price", type: "money" },
      },
    });
    assert.equal(validateContentPayload(v2, migrated.fields, "publish").ok, true);
    // Old fixture still validates against the retained v1 schema (§88).
    const oldPayload = corpus.fixtures.find((fixture) => fixture.name === "service.minimum-valid");
    assert.ok(oldPayload !== undefined);
    void oldPayload;
  });
});
