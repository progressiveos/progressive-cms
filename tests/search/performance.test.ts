// PCMS-SEARCH-T019 — performance regression benchmark (Search spec §30):
// a corpus significantly larger than a common SMB site (thousands of
// documents), no unbounded result hydration, and two INDEPENDENT proofs:
//
// A. Normal-planner performance — real searches return correct results with
//    bounded latency. No physical-plan requirement here: on a 3000-row table
//    PostgreSQL legitimately prefers a Seq Scan even for selective terms
//    (observed on the integration PostgreSQL 18 server), so which plan wins
//    is the planner's call, not the contract.
//
// B. GIN usability — the FTS predicate the provider actually issues is
//    proven GIN-indexable: in a scoped transaction (SET LOCAL, reverted at
//    commit — no server settings are touched) sequential scans are disabled
//    and EXPLAIN must route the same tsvector expression through the GIN
//    search index. The probe isolates the FTS predicate because the full
//    WHERE shape can legally be served by the btree scope index even with
//    seq scan off, which would prove nothing about the GIN.
//
// Assertions are generous ceilings — the gate exists to catch accidental
// search performance regressions and a broken/missing index, not to measure hardware.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { createPgSearchProvider, parseSearchQuery, type SearchDocument } from "@pcms/search";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const CORPUS_SIZE = 3000;
const QUERY_SAMPLES = 40;
const MEDIAN_BUDGET_MILLISECONDS = 150;
const MAX_BUDGET_MILLISECONDS = 500;

const WORDS = [
  "услуга",
  "сервис",
  "договор",
  "отчёт",
  "проект",
  "монтаж",
  "проектирование",
  "обслуживание",
  "сервер",
  "отчётность",
];

function syntheticDocument(index: number): SearchDocument {
  const w1 = WORDS[index % WORDS.length] ?? "услуга";
  const w2 = WORDS[(index * 7) % WORDS.length] ?? "сервис";
  return {
    entity_type: "entry",
    entity_id: `perf-${String(index).padStart(6, "0")}`,
    context: "default",
    site_id: "default",
    locale: "ru",
    content_type: index % 3 === 0 ? "service" : "page",
    revision_id: `perf-rev-${index}`,
    generation: 1,
    title: `${w1} ${w2} номер ${index}`,
    summary: `Краткое описание ${w1} для записи ${index}`,
    structured_text: "",
    body_text: `Полный текст документа ${index}: ${w1}, ${w2}, дополнительные сведения о предоставлении ${w1} в городе.${index === 0 ? " редкость" : ""}`,
    aux_text: index % 10 === 0 ? `CODE-${index}-AUX` : "",
    route: `/docs/${index}/`,
    published_at: new Date(Date.UTC(2026, 0, 1 + (index % 28), 12)),
    modified_at: new Date(Date.UTC(2026, 5, 15)),
  };
}

test("benchmark: 3000-document corpus, bounded latency, GIN usability proven", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 4 });
  t.after(() => void pool.end());
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const provider = createPgSearchProvider({ pool });

  const indexingStart = Date.now();
  for (let index = 0; index < CORPUS_SIZE; index += 1) {
    await provider.index(syntheticDocument(index));
  }
  const indexingMilliseconds = Date.now() - indexingStart;
  const health = await provider.health();
  assert.equal(health.document_count, CORPUS_SIZE);
  // Informational ceiling: per-document upsert must stay cheap (no N+1
  // re-derivation loops inside the provider).
  assert.ok(
    indexingMilliseconds / CORPUS_SIZE < 20,
    `indexing too slow: ${indexingMilliseconds}ms total`,
  );

  // Fresh statistics keep the latency samples representative of a maintained
  // table (autovacuum's job in production) — never a plan gate.
  await pool.query("ANALYZE search_documents");

  const query = (q: string) =>
    provider.query(parseSearchQuery({ q, site: "default", locale: "ru", limit: 20 }));

  // Warm-up + result sanity.
  const sanity = await query("услуга");
  assert.ok(sanity.total > 100, `expected large result set, got ${sanity.total}`);
  assert.equal(sanity.items.length, 20, "page size is bounded");

  const latencies: number[] = [];
  for (let sample = 0; sample < QUERY_SAMPLES; sample += 1) {
    const term = WORDS[sample % WORDS.length] ?? "услуга";
    const started = process.hrtime.bigint();
    const result = await query(term);
    latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
    assert.ok(result.items.length <= 20);
  }
  latencies.sort((a, b) => a - b);
  const median = latencies[Math.floor(latencies.length / 2)] ?? 0;
  const max = latencies[latencies.length - 1] ?? 0;
  assert.ok(median < MEDIAN_BUDGET_MILLISECONDS, `median ${median.toFixed(1)}ms exceeds budget`);
  assert.ok(max < MAX_BUDGET_MILLISECONDS, `max ${max.toFixed(1)}ms exceeds budget`);

  t.diagnostic(`3000 documents: median=${median.toFixed(1)}ms max=${max.toFixed(1)}ms; page=20`);

  // Aux corpus lookup stays correct as well.
  const code = await query("CODE-120-AUX");
  assert.equal(code.total, 1);

  // ── B. GIN usability proof ────────────────────────────────────────────
  // Precondition from the catalog: the GIN search indexes the FTS predicate
  // relies on must actually exist (a dropped/renamed index must fail here,
  // not as a confusing plan mismatch below).
  const indexes = await pool.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = current_schema() AND tablename = 'search_documents'`,
  );
  const vectorIndex = indexes.rows.find((row) => row.indexname === "search_documents_vector_idx");
  const auxIndex = indexes.rows.find((row) => row.indexname === "search_documents_aux_idx");
  assert.ok(vectorIndex, "search_documents_vector_idx missing from catalog");
  assert.match(vectorIndex.indexdef, /USING gin/, "vector index is not GIN");
  assert.ok(auxIndex, "search_documents_aux_idx missing from catalog");
  assert.match(auxIndex.indexdef, /USING gin/, "aux index is not GIN");

  // Forced-index probe on one pooled client: SET LOCAL enable_seqscan = off
  // lives only inside this transaction (reverted at commit — global or
  // database-level settings are never modified). Under forced index access
  // the same FTS expression the provider issues must be served by the GIN
  // index; latency is asserted nowhere here.
  await pool.withTransaction(async (tx) => {
    await tx.query("ANALYZE search_documents");
    await tx.query("SET LOCAL enable_seqscan = off");
    const explain = (sql: string) =>
      tx
        .query<Record<string, unknown>>(sql)
        .then((result) => result.rows.map((row) => String(Object.values(row)[0] ?? "")).join("\n"));
    const vectorPlan = await explain(
      `EXPLAIN (COSTS OFF)
       SELECT entity_id FROM search_documents
       WHERE search_vector @@ websearch_to_tsquery('russian', 'редкость')`,
    );
    assert.match(
      vectorPlan,
      /(?:Bitmap Index Scan on|Index Scan using) search_documents_vector_idx/,
      `FTS predicate must be GIN-usable under forced index access: ${vectorPlan}`,
    );
    const auxPlan = await explain(
      `EXPLAIN (COSTS OFF)
       SELECT entity_id FROM search_documents
       WHERE aux_vector @@ plainto_tsquery('simple', 'CODE-120-AUX')`,
    );
    assert.match(
      auxPlan,
      /(?:Bitmap Index Scan on|Index Scan using) search_documents_aux_idx/,
      `aux lookup must be GIN-usable under forced index access: ${auxPlan}`,
    );
  });
});
