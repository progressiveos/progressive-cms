// PCMS-SEARCH-T003/T004/T006/T007/T008 — PostgreSQL provider integration:
// indexed FTS queries, RU/EN morphology, weighted ranking + exact-title
// boost, semantic snippets, bounded filters/pagination, site/locale
// isolation, stale-generation guard, idempotency (Search spec §7–§17).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createPgSearchProvider,
  encodeCursor,
  parseSearchQuery,
  type SearchDocument,
  type SearchDocumentSource,
} from "@pcms/search";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const NOW = new Date("2026-09-19T12:00:00Z");

function document(partial: Partial<SearchDocument> & { entity_id: string }): SearchDocument {
  return {
    entity_type: "entry",
    context: "default",
    site_id: "default",
    locale: "ru",
    content_type: "page",
    revision_id: `rev-${partial.entity_id}`,
    generation: 1,
    title: "",
    summary: "",
    structured_text: "",
    body_text: "",
    aux_text: "",
    route: `/${partial.entity_id}/`,
    published_at: NOW,
    modified_at: NOW,
    ...partial,
  };
}

function fakeSource(documents: SearchDocument[]): SearchDocumentSource {
  const sorted = [...documents].sort((a, b) => a.entity_id.localeCompare(b.entity_id));
  const page = (after: string | null, limit: number) => {
    const start = after === null ? 0 : sorted.findIndex((item) => item.entity_id > after);
    const from = start === -1 ? sorted.length : start;
    const ids = sorted.slice(from, from + limit).map((item) => item.entity_id);
    return { ids, cursor: ids.length === limit ? (ids[ids.length - 1] ?? null) : null };
  };
  return {
    async buildDocument(_entityType, entityId) {
      return sorted.find((item) => item.entity_id === entityId) ?? null;
    },
    async listPhases() {
      return ["entry"];
    },
    async countPhase(phase) {
      if (phase !== "entry") throw new Error(`unknown phase ${phase}`);
      return sorted.length;
    },
    async listPhaseIds(phase, after, limit) {
      if (phase !== "entry") throw new Error(`unknown phase ${phase}`);
      return page(after, limit);
    },
  };
}

test("provider: morphology, ranking, isolation, snippets, pagination, stale guard", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 4 });
  t.after(() => void pool.end());
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);

  const provider = createPgSearchProvider({ pool });
  const query = (input: Parameters<typeof parseSearchQuery>[0]) =>
    provider.query(parseSearchQuery(input), { now: NOW });

  await provider.index(
    document({
      entity_id: "a1-title-match",
      locale: "ru",
      title: "Внедрение ERP-систем",
      summary: "Автоматизация производства",
      body_text: "Полный цикл работ по внедрению информационных систем.",
      aux_text: "ERP-2026-PRO",
      published_at: new Date("2026-08-01T00:00:00Z"),
    }),
  );
  await provider.index(
    document({
      entity_id: "a2-body-only",
      locale: "ru",
      title: "Услуги компании",
      summary: "Комплексные услуги",
      body_text: "Мы выполняем внедрение систем на предприятиях любого масштаба.",
      published_at: new Date("2026-07-01T00:00:00Z"),
    }),
  );
  await provider.index(
    document({
      entity_id: "a3-exact-title",
      locale: "ru",
      title: "внедрение",
      body_text: "Короткая страница про само понятие.",
      published_at: new Date("2026-06-01T00:00:00Z"),
    }),
  );
  await provider.index(
    document({
      entity_id: "a4-english",
      locale: "en",
      title: "ERP implementation services",
      body_text: "We run enterprise system implementations worldwide.",
      published_at: NOW,
    }),
  );
  await provider.index(
    document({
      entity_id: "a5-other-site",
      site_id: "partner",
      locale: "ru",
      title: "Внедрение у партнёра",
      body_text: "Секретный контур другого сайта.",
      published_at: NOW,
    }),
  );

  // --- RU morphology (T004): inflected query matches the base lexeme.
  // "внедрении систем" stems to внедрен&систем — a3 lacks "систем". ---
  const ru = await query({ q: "внедрении систем", site: "default", locale: "ru" });
  assert.equal(ru.total, 2);
  const ruIds = ru.items.map((item) => item.entity_id);
  assert.deepEqual(ruIds, ["a1-title-match", "a2-body-only"]);

  // --- Weighted ranking (T006): title match beats body-only match. ---
  assert.equal(ru.items[0]?.entity_id, "a1-title-match");
  const scoreOf = (id: string) => ru.items.find((item) => item.entity_id === id)?.score ?? 0;
  assert.ok(scoreOf("a1-title-match") > scoreOf("a2-body-only"), "title weight must outrank body");

  // --- Exact title boost (spec §12) on a broader single-lexeme query. ---
  const single = await query({ q: "внедрение", site: "default", locale: "ru" });
  assert.equal(single.total, 3);
  assert.equal(single.items[0]?.entity_id, "a3-exact-title", "exact title equality ranks first");
  const singleScore = (id: string) =>
    single.items.find((item) => item.entity_id === id)?.score ?? 0;
  assert.ok(singleScore("a1-title-match") > singleScore("a2-body-only"), "title weight beats body");

  // --- EN morphology + locale isolation (never mixed silently). ---
  const en = await query({ q: "implementing systems", site: "default", locale: "en" });
  assert.equal(en.total, 1);
  assert.equal(en.items[0]?.entity_id, "a4-english");
  const ruAgain = await query({ q: "implementation", site: "default", locale: "ru" });
  assert.equal(ruAgain.total, 0, "english lexeme must not surface under the ru locale scope");

  // --- Site isolation: partner-site documents never leak. ---
  const scoped = await query({ q: "внедрение", site: "default", locale: "ru" });
  assert.ok(scoped.items.every((item) => item.entity_id !== "a5-other-site"));

  // --- Aux corpus: product code matches via the simple config (T004 §9). ---
  const code = await query({ q: "ERP-2026-PRO", site: "default", locale: "ru" });
  assert.equal(code.total, 1);
  assert.equal(code.items[0]?.entity_id, "a1-title-match");

  // --- Snippets: semantic segments, highlighted span present, no markers. ---
  const snippet = ru.items.find((item) => item.entity_id === "a2-body-only")?.snippet;
  assert.ok(snippet !== null && snippet !== undefined);
  assert.equal(snippet.source, "body");
  assert.ok(snippet.segments.some((segment) => segment.match));
  const joined = snippet.segments.map((segment) => segment.text).join("");
  assert.ok(joined.includes("внедрение"));
  assert.ok(!joined.includes("\u0001") && !joined.includes("\u0002"));

  // --- Filters (T008): content_type + date range from the allowlist. ---
  const filtered = await query({
    q: "внедрение",
    site: "default",
    locale: "ru",
    content_type: "page",
    date_from: "2026-07-15",
    date_to: "2026-09-19",
  });
  assert.equal(filtered.total, 1); // only a1 (2026-08-01) is inside the window
  const dated = await query({ q: "внедрение", site: "default", locale: "ru", sort: "date" });
  assert.equal(dated.items[0]?.entity_id, "a1-title-match", "date sort: newest first");
  assert.deepEqual(
    dated.items.map((item) => item.entity_id),
    ["a1-title-match", "a2-body-only", "a3-exact-title"],
  );

  // --- Pagination (T008): cursor walk without duplicates or omissions. ---
  const page1 = await query({ q: "внедрение", site: "default", locale: "ru", limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.ok(page1.next_cursor !== null);
  const page2 = await query({
    q: "внедрение",
    site: "default",
    locale: "ru",
    limit: 2,
    cursor: page1.next_cursor ?? "",
  });
  const seen = [...page1.items, ...page2.items].map((item) => item.entity_id);
  assert.equal(new Set(seen).size, seen.length, "no duplicates across pages");
  for (const id of ["a1-title-match", "a2-body-only", "a3-exact-title"]) {
    assert.ok(seen.includes(id), `page walk must include ${id}`);
  }

  // --- Remove + republish semantics through index/remove. ---
  await provider.remove("entry", "a3-exact-title");
  const afterRemove = await query({ q: "внедрение", site: "default", locale: "ru" });
  assert.equal(afterRemove.total, 2);
  await provider.index(
    document({ entity_id: "a3-exact-title", title: "внедрение", body_text: "Снова доступно." }),
  );
  const restored = await query({ q: "внедрение", site: "default", locale: "ru" });
  assert.equal(restored.total, 3);

  // --- Idempotency: re-indexing the same document changes nothing. ---
  await provider.index(
    document({ entity_id: "a3-exact-title", title: "внедрение", body_text: "Снова доступно." }),
  );
  const again = await query({ q: "внедрение", site: "default", locale: "ru" });
  assert.equal(again.total, 3);

  // --- Stale-event guard: a generation-11 write cannot regress generation 12. ---
  await provider.index(
    document({
      entity_id: "a3-exact-title",
      title: "внедрение",
      body_text: "Актуальная версия поколения 12.",
      generation: 12,
    }),
  );
  const stale = await query({ q: "Актуальная версия", site: "default", locale: "ru" });
  assert.equal(stale.total, 1);
  await provider.index(
    document({
      entity_id: "a3-exact-title",
      title: "внедрение",
      body_text: "Поздняя доставка старого события.",
      generation: 11,
    }),
  );
  const guarded = await query({ q: "Поздняя доставка", site: "default", locale: "ru" });
  assert.equal(guarded.total, 0, "stale generation write must be ignored");
  const stillCurrent = await query({ q: "Актуальная версия", site: "default", locale: "ru" });
  assert.equal(stillCurrent.total, 1);

  // --- Health reflects documents/version (T014 input). ---
  const health = (await provider.health()) as import("@pcms/search").PgSearchHealth;
  assert.equal(health.available, true);
  assert.equal(health.document_count, 5);
  assert.equal(typeof health.trigram_available, "boolean");
  assert.equal(health.reindex_required, true, "fresh index has version 0 until first reindex");
});

test("provider: window guard fires beyond MAX_RESULT_WINDOW", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => void pool.end());
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const provider = createPgSearchProvider({ pool });
  await provider.index(
    document({ entity_id: "w1", title: "виджеты", body_text: "виджеты ".repeat(50) }),
  );
  await assert.rejects(
    async () => {
      const parsed = parseSearchQuery({
        q: "виджеты",
        site: "default",
        locale: "ru",
        limit: 50,
        cursor: encodeCursor(451),
      });
      await provider.query(parsed, { now: new Date() });
    },
    (error: unknown) => (error as { code?: string }).code === "SEARCH_WINDOW_EXCEEDED",
  );
});

test("provider: provider.reindex() delegates when wired (contract §28)", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => void pool.end());
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const documents = [
    document({ entity_id: "r1", title: "Реконструкция", body_text: "Полная перестройка индекса." }),
  ];
  const source = fakeSource(documents);
  const { createSearchReindexService } = await import("@pcms/search");
  const reindex = createSearchReindexService({ pool, source });
  const provider = createPgSearchProvider({ pool, reindex: () => reindex.runSynchronously() });
  await provider.index(
    document({ entity_id: "stale", title: "Мусор", body_text: "Старый слепок." }),
  );
  await provider.reindex();
  const health = await provider.health();
  assert.equal(health.document_count, 1, "rebuild drops documents absent from the source");
  assert.equal(health.index_version, 2, "rebuild stamps the current index version");
  assert.equal(health.reindex_required, false);
  const found = await provider.query(
    parseSearchQuery({ q: "перестройка", site: "default", locale: "ru" }),
  );
  assert.equal(found.total, 1);
});
