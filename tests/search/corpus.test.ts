// PCMS-SEARCH-T018 — reference relevance corpus (Search spec §32):
// deterministic extractor + provider expectations over the mandatory
// fixture classes: RU/EN morphology, mixed product tokens, title exact,
// body-only, FAQ, timeline, unpublished, noindex, updated/removed.
// Pure composition over the L1 packages — no application layer needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createPgSearchProvider,
  createSearchReindexService,
  extractSearchText,
  parseSearchQuery,
  type SearchDocument,
  type SearchDocumentSource,
} from "@pcms/search";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

// --- extraction fixtures (pure, spec §32 classes that live in content). ---
const SCHEMA = {
  fields: {
    title: { type: "string" },
    intro: { type: "text" },
    sku: { type: "string", searchable: true, search_weight: "D" as const },
  },
};

test("reference corpus: extraction classes produce weighted text deterministically", () => {
  const rt = (text: string) => ({
    type: "document",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  const blocks = (items: unknown[]) => ({ schemaVersion: 1, blocks: items });
  const extracted = extractSearchText({
    fields: { title: "Модель X-100", intro: "Описание модели", sku: "X-100-PRO" },
    fieldSchema: SCHEMA,
    bodyPolicy: "block_document",
    blocks: blocks([
      {
        id: "b1",
        type: "heading",
        schemaVersion: 1,
        variant: null,
        props: { level: 2, text: "Характеристики" },
        children: [],
      },
      {
        id: "b2",
        type: "faq",
        schemaVersion: 1,
        variant: null,
        props: {
          items: [
            { id: "q1", question: "Сколько стоит доставка?", answer: rt("По Москве бесплатно") },
          ],
        },
        children: [],
      },
      {
        id: "b3",
        type: "timeline",
        schemaVersion: 1,
        variant: null,
        props: {
          items: [
            { id: "t1", date_text: "2020", title: "Запуск линейки", text: rt("Первый прототип") },
          ],
        },
        children: [],
      },
      {
        id: "b4",
        type: "code",
        schemaVersion: 1,
        variant: null,
        props: { language: "json", code: '{"private": true}' },
        children: [],
      },
    ]),
  });
  assert.equal(extracted.title, "Модель X-100");
  assert.match(extracted.bodyText, /Характеристики/);
  assert.match(extracted.bodyText, /Сколько стоит доставка\?/);
  assert.match(extracted.bodyText, /Запуск линейки/);
  assert.match(extracted.auxText, /X-100-PRO/);
  assert.ok(!extracted.bodyText.includes("private"), "code payload excluded");
});

// --- indexed corpus classes (provider level, deterministic ordering). ---
test("reference corpus: RU/EN/public/private classes over the provider", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 4 });
  t.after(() => void pool.end());
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const provider = createPgSearchProvider({ pool });

  const base = {
    entity_type: "entry",
    context: "default",
    site_id: "default",
    content_type: "page",
    generation: 1,
    summary: "",
    structured_text: "",
    aux_text: "",
    route: null,
    published_at: new Date("2026-08-01T00:00:00Z"),
    modified_at: null,
  } satisfies Partial<SearchDocument>;

  const document = (entityId: string, over: Partial<SearchDocument>): SearchDocument =>
    ({
      ...base,
      entity_id: entityId,
      revision_id: `rev-${entityId}`,
      locale: "ru",
      title: "",
      body_text: "",
      ...over,
    }) as SearchDocument;

  const corpus: SearchDocument[] = [
    document("c1-ru-title", {
      title: "Ремонт кровли",
      body_text: "Полный цикл работ.",
      route: "/remont/",
    }),
    document("c2-ru-body", {
      title: "Услуги компании",
      body_text: "Выполняем ремонт кровли под ключ.",
      route: "/uslugi/",
    }),
    document("c3-en", {
      locale: "en",
      title: "Roof repair services",
      body_text: "We repair roofs.",
      route: "/en/roof/",
    }),
    document("c4-code", {
      title: "Каталог изделий",
      aux_text: "ART-95-CATALOG",
      route: "/catalog/",
    }),
    document("c5-noindex", {
      title: "Черновик публикации",
      body_text: "Неиндексируемый контент",
      route: "/draft/",
    }),
    // "Unpublished": never indexed at all — its absence IS the fixture.
  ];
  // c5 is indexed first, then removed — the "removed publication" class.
  for (const item of corpus) await provider.index(item);
  await provider.remove("entry", "c5-noindex");

  const q = (query: string, locale = "ru") =>
    provider.query(parseSearchQuery({ q: query, site: "default", locale }));

  // RU morphology: inflected form hits both title and body classes.
  const ru = await q("ремонта кровли");
  assert.deepEqual(
    ru.items.map((item) => item.entity_id),
    ["c1-ru-title", "c2-ru-body"],
  );
  // Title weight outranks body-only.
  assert.ok((ru.items[0]?.score ?? 0) > (ru.items[1]?.score ?? 0));

  // EN morphology stays inside its locale scope.
  const en = await q("repairing roofs", "en");
  assert.equal(en.total, 1);
  assert.equal(en.items[0]?.entity_id, "c3-en");
  assert.equal((await q("repair", "ru")).total, 0);

  // Mixed product token via the aux corpus.
  const code = await q("ART-95-CATALOG");
  assert.deepEqual(
    code.items.map((item) => item.entity_id),
    ["c4-code"],
  );

  // Removed/unpublished content is not found.
  assert.equal((await q("Черновик публикации")).total, 0);

  // Deterministic pagination walk over the whole public corpus (3 docs).
  const page1 = await provider.query(
    parseSearchQuery({ q: "и", site: "default", locale: "ru", limit: 1 }),
  );
  if (page1.next_cursor !== null) {
    const page2 = await provider.query(
      parseSearchQuery({
        q: "и",
        site: "default",
        locale: "ru",
        limit: 1,
        cursor: page1.next_cursor,
      }),
    );
    assert.notEqual(page1.items[0]?.entity_id, page2.items[0]?.entity_id);
  }

  const health = await provider.health();
  assert.equal(health.document_count, 4);

  // Full rebuild from a source that no longer derives c2 → exact state.
  const source: SearchDocumentSource = {
    async buildDocument(entityType, entityId) {
      if (entityType !== "entry") return null;
      return corpus.find((item) => item.entity_id === entityId) ?? null;
    },
    async listPhases() {
      return ["entry"];
    },
    async countPhase(phase) {
      if (phase !== "entry") throw new Error(`unknown phase ${phase}`);
      return 2;
    },
    async listPhaseIds(phase, after, limit) {
      if (phase !== "entry") throw new Error(`unknown phase ${phase}`);
      const visible = corpus.filter((item) => ["c1-ru-title", "c3-en"].includes(item.entity_id));
      const start = after === null ? 0 : visible.findIndex((item) => item.entity_id > after);
      const slice = visible.slice(
        start === -1 ? visible.length : start,
        (start === -1 ? visible.length : start) + limit,
      );
      return {
        ids: slice.map((item) => item.entity_id),
        cursor: slice.length === limit ? (slice[slice.length - 1]?.entity_id ?? null) : null,
      };
    },
  };
  const reindex = createSearchReindexService({ pool, source });
  await provider.index(document("c6-drift", { title: "Дрейф данных", body_text: "Мусор" }));
  await reindex.runSynchronously();
  assert.equal((await provider.health()).document_count, 2, "rebuild restores exact public state");
  assert.equal((await q("Дрейф данных")).total, 0);
});
