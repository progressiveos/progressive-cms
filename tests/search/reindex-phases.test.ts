// PREPUBLIC-01 §2 — full reindex over the phased Source Contract: the eight
// mandatory scenarios from the постановка, against a real PostgreSQL index.
// "Extensions" here are additional enumeration phases of the composed
// source (the composition seam itself is covered in extension-source.test.ts);
// what is under test is the CONVERGE: phases chain, mid-rebuild changes
// survive, failures keep the active epoch serving, resumes lose nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createPgSearchProvider,
  createSearchReindexService,
  parseSearchQuery,
  type SearchDocument,
  type SearchDocumentSource,
  type SearchProvider,
} from "@pcms/search";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const CHUNK = 500;

interface ExtDoc {
  readonly id: string;
  title: string;
  generation: number;
  deleted: boolean;
}

/** Two-phase composed source: "entry" documents are static; the
 * "shop/item" extension phase is a MUTABLE in-memory catalogue (tests flip
 * titles/deletions mid-run) enumerated cursor/batch. */
function phasedSource(
  entries: SearchDocument[],
  items: ExtDoc[],
): {
  readonly source: SearchDocumentSource;
  readonly items: ExtDoc[];
} {
  const catalogue = [...items];
  const extDocument = (item: ExtDoc): SearchDocument | null =>
    item.deleted
      ? null
      : {
          entity_type: "shop/item",
          entity_id: item.id,
          context: "default",
          site_id: "default",
          locale: "en",
          content_type: "shop-item",
          revision_id: `rev-${item.id}-${item.generation}`,
          generation: item.generation,
          title: item.title,
          summary: `Extension item ${item.id}`,
          structured_text: "",
          body_text: item.title,
          aux_text: "",
          route: "/shop/items/",
          published_at: new Date("2026-09-01T00:00:00Z"),
          modified_at: null,
        };
  const entryPage = (after: string | null, limit: number) => {
    const sorted = [...entries].sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    const start = after === null ? 0 : sorted.findIndex((item) => item.entity_id > after);
    const slice = sorted.slice(start === -1 ? sorted.length : start);
    const ids = slice.slice(0, limit).map((item) => item.entity_id);
    return { ids, cursor: ids.length === limit ? (ids[ids.length - 1] ?? null) : null };
  };
  const itemPage = (after: string | null, limit: number) => {
    const sorted = catalogue.map((item) => item.id).sort((a, b) => a.localeCompare(b));
    const start = after === null ? 0 : sorted.findIndex((id) => id > after);
    const slice = sorted.slice(start === -1 ? sorted.length : start);
    const ids = slice.slice(0, limit);
    return { ids, cursor: ids.length === limit ? (ids[ids.length - 1] ?? null) : null };
  };
  return {
    items: catalogue,
    source: {
      async buildDocument(entityType, entityId) {
        if (entityType === "entry") {
          return entries.find((item) => item.entity_id === entityId) ?? null;
        }
        return extDocument(
          catalogue.find((item) => item.id === entityId) ?? {
            id: entityId,
            title: "",
            generation: 1,
            deleted: true,
          },
        );
      },
      async listPhases() {
        return ["entry", "shop/item"];
      },
      async countPhase(phase) {
        if (phase === "entry") return entries.length;
        if (phase === "shop/item") return catalogue.filter((item) => !item.deleted).length;
        throw new Error(`unknown phase ${phase}`);
      },
      async listPhaseIds(phase, after, limit) {
        if (phase === "entry") return entryPage(after, limit);
        if (phase === "shop/item") return itemPage(after, limit);
        throw new Error(`unknown phase ${phase}`);
      },
    },
  };
}

function entry(id: string, title: string): SearchDocument {
  return {
    entity_type: "entry",
    entity_id: id,
    context: "default",
    site_id: "default",
    locale: "en",
    content_type: "page",
    revision_id: `rev-${id}`,
    generation: 1,
    title,
    summary: "",
    structured_text: "",
    body_text: title,
    aux_text: "",
    route: `/${id}/`,
    published_at: new Date("2026-09-01T00:00:00Z"),
    modified_at: null,
  };
}

/** Deterministic in-process jobs port: executes the search chain exactly
 * like the worker would (idempotency keys dedupe, chunk enqueues successor)
 * but synchronously — `stop()` mid-drain simulates a worker crash. */
function fakeJobs() {
  const seen = new Set<string>();
  let queue: { readonly type: string; readonly payload: unknown; readonly key: string }[] = [];
  // The service takes this port at construction — handlers resolve it through
  // a mutable ref set right after (bind).
  let reindex: {
    processChunk(payload: unknown): Promise<void>;
    finalize(payload: unknown): Promise<string>;
  } | null = null;
  const handlers = {
    "search.reindex-chunk": async (payload: unknown) => {
      await reindex?.processChunk(payload);
    },
    "search.reindex-finalize": async (payload: unknown) => {
      await reindex?.finalize(payload);
    },
  };
  return {
    bind(service: {
      processChunk(payload: unknown): Promise<void>;
      finalize(payload: unknown): Promise<string>;
    }): void {
      reindex = service;
    },
    enqueue: async (input: {
      readonly type: string;
      readonly payload: unknown;
      readonly idempotencyKey: string;
    }) => {
      if (seen.has(input.idempotencyKey)) return; // converged chain
      seen.add(input.idempotencyKey);
      queue = [...queue, { type: input.type, payload: input.payload, key: input.idempotencyKey }];
    },
    /** Drains until the queue is empty; `maxJobs` bounds the drain to
     * simulate a crash N jobs in. Returns the number of executed jobs. */
    drain: async (maxJobs = Number.POSITIVE_INFINITY): Promise<number> => {
      let executed = 0;
      while (queue.length > 0 && executed < maxJobs) {
        const next = queue[0]!;
        queue = queue.slice(1);
        const handler = handlers[next.type as keyof typeof handlers];
        await handler(next.payload);
        executed += 1;
      }
      return executed;
    },
  };
}

async function setup(t: import("node:test").TestContext): Promise<{
  pool: DbPool;
  provider: SearchProvider;
}> {
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 4 });
  t.after(() => void pool.end());
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const provider = createPgSearchProvider({ pool });
  return { pool, provider };
}

const queryOne = async (provider: SearchProvider, text: string): Promise<readonly string[]> =>
  (
    await provider.query(parseSearchQuery({ q: text, site: "default", locale: "en", limit: 20 }))
  ).items.map((item) => `${item.entity_type}/${item.entity_id}`);

const queryTotal = async (provider: SearchProvider, text: string): Promise<number> =>
  (await provider.query(parseSearchQuery({ q: text, site: "default", locale: "en", limit: 5 })))
    .total;

test("reindex phases: empty index → entries and extension documents restored", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, provider } = await setup(t);
  const { source } = phasedSource(
    [entry("e1", "Alpha page"), entry("e2", "Beta page")],
    [
      { id: "w1", title: "Gamma widget", generation: 1, deleted: false },
      { id: "w2", title: "Delta widget", generation: 1, deleted: false },
    ],
  );
  const reindex = createSearchReindexService({ pool, source });
  assert.equal((await provider.health()).document_count, 0, "start empty");
  await reindex.runSynchronously();
  const health = await provider.health();
  assert.equal(health.document_count, 4);
  // Real query output — extension-owned documents are searchable, not just
  // rows in PostgreSQL (постановка §2 п.10).
  assert.deepEqual(await queryOne(provider, "widget"), ["shop/item/w1", "shop/item/w2"]);
  assert.deepEqual(await queryOne(provider, "page"), ["entry/e1", "entry/e2"]);
});

test("reindex phases: change mid-rebuild lands the newer generation", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, provider } = await setup(t);
  const { source, items } = phasedSource(
    [entry("e1", "Stable page")],
    [{ id: "w1", title: "Old widget title", generation: 1, deleted: false }],
  );
  const reindex = createSearchReindexService({ pool, source });
  const started = await reindex.start();
  // The change happens AFTER allocation (building epoch live) and dual-writes
  // through the incremental path — provider.index writes both epochs; the
  // generation guard keeps it over the chunk's older derivation.
  const changed = items[0]!;
  changed.title = "New widget title";
  changed.generation = 2;
  await provider.index({
    ...(await source.buildDocument("shop/item", "w1"))!,
    generation: 2,
  });
  await reindex.processChunk({
    runId: started.runId,
    chunkIndex: 0,
    phase: "entry",
    after: null,
    limit: CHUNK,
  });
  await reindex.processChunk({
    runId: started.runId,
    chunkIndex: 1,
    phase: "shop/item",
    after: null,
    limit: CHUNK,
  });
  assert.equal(await reindex.finalize({ runId: started.runId }), "done");
  assert.deepEqual(await queryOne(provider, "widget"), ["shop/item/w1"]);
  assert.equal(
    await queryTotal(provider, "New widget"),
    1,
    "final index carries the mid-rebuild version",
  );
  assert.equal(await queryTotal(provider, "Old widget"), 0);
});

test("reindex phases: delete mid-rebuild keeps the document out of the final index", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, provider } = await setup(t);
  const { source, items } = phasedSource(
    [entry("e1", "Keeper page")],
    [
      { id: "w1", title: "Doomed widget", generation: 1, deleted: false },
      { id: "w2", title: "Survivor widget", generation: 1, deleted: false },
    ],
  );
  const reindex = createSearchReindexService({ pool, source });
  const started = await reindex.start();
  await reindex.processChunk({
    runId: started.runId,
    chunkIndex: 0,
    phase: "entry",
    after: null,
    limit: CHUNK,
  });
  // Unpublish mid-rebuild: incremental remove (all epochs) + the source
  // stops deriving the document, so later chunks never re-add it.
  const doomed = items[0]!;
  doomed.deleted = true;
  await provider.remove("shop/item", "w1");
  await reindex.processChunk({
    runId: started.runId,
    chunkIndex: 1,
    phase: "shop/item",
    after: null,
    limit: CHUNK,
  });
  assert.equal(await reindex.finalize({ runId: started.runId }), "done");
  assert.equal(await queryTotal(provider, "Doomed"), 0);
  assert.equal(await queryTotal(provider, "Survivor"), 1);
  assert.equal((await provider.health()).document_count, 2);
});

test("reindex phases: failing source keeps the active index serving, run FAILED", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, provider } = await setup(t);
  const good = phasedSource(
    [entry("e1", "Serving page")],
    [{ id: "w1", title: "Serving widget", generation: 1, deleted: false }],
  );
  const first = createSearchReindexService({ pool, source: good.source });
  await first.runSynchronously();
  assert.equal((await provider.health()).document_count, 2);

  // The next rebuild's extension phase breaks persistently (extension bug).
  const brokenSource: SearchDocumentSource = {
    ...good.source,
    async listPhaseIds(phase, after, limit) {
      if (phase === "shop/item") throw new Error("EXT_SOURCE_DOWN");
      return good.source.listPhaseIds(phase, after, limit);
    },
    async countPhase(phase) {
      if (phase === "shop/item") throw new Error("EXT_SOURCE_DOWN");
      return good.source.countPhase(phase);
    },
  };
  const reindex = createSearchReindexService({ pool, source: brokenSource });
  const started = await reindex.start();
  await reindex.processChunk({
    runId: started.runId,
    chunkIndex: 0,
    phase: "entry",
    after: null,
    limit: CHUNK,
  });
  await assert.rejects(() =>
    reindex.processChunk({
      runId: started.runId,
      chunkIndex: 1,
      phase: "shop/item",
      after: null,
      limit: CHUNK,
    }),
  );
  // The job layer's final-attempt classification (createSearchJobHandlers
  // behaviour): exhausted retries mark the run FAILED with diagnostics.
  await reindex.markFailed(started.runId, new Error("EXT_SOURCE_DOWN"));
  const runs = await reindex.listRuns(1);
  const failedRun = runs[0];
  assert.ok(failedRun !== undefined);
  assert.equal(failedRun.state, "FAILED");
  assert.match(failedRun.error ?? "", /EXT_SOURCE_DOWN/);
  // The previous working index still serves — the shadow epoch never swapped.
  assert.equal((await provider.health()).document_count, 2);
  assert.equal(await queryTotal(provider, "Serving"), 2);
});

test("reindex phases: worker crash before finalize → resume completes without loss", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, provider } = await setup(t);
  const { source } = phasedSource(
    [entry("e1", "Crash page")],
    [{ id: "w1", title: "Crash widget", generation: 1, deleted: false }],
  );
  const jobs = fakeJobs();
  const withJobs = createSearchReindexService({ pool, source, jobs });
  jobs.bind(withJobs);
  await withJobs.start();
  await jobs.drain(1); // crash one chunk in (entry phase only)
  assert.equal((await provider.health()).document_count, 0, "nothing swapped yet");
  // Restart resumes the same run and drains to finalize.
  const resumed = await withJobs.start({ resume: true });
  assert.equal(resumed.resumed, true);
  await jobs.drain();
  assert.equal((await provider.health()).document_count, 2);
  assert.deepEqual(await queryOne(provider, "widget"), ["shop/item/w1"]);
  const runStates = await withJobs.listRuns(1);
  assert.equal(runStates[0]?.state, "ACTIVE");
});

test("reindex phases: repeated rebuilds produce no duplicates", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, provider } = await setup(t);
  const { source } = phasedSource(
    [entry("e1", "Repeat page")],
    [{ id: "w1", title: "Repeat widget", generation: 1, deleted: false }],
  );
  const reindex = createSearchReindexService({ pool, source });
  await reindex.runSynchronously();
  await reindex.runSynchronously();
  await reindex.runSynchronously();
  assert.equal((await provider.health()).document_count, 2);
});

test("reindex phases: two competing reindexes — conflict, then deterministic resume", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, provider } = await setup(t);
  const { source } = phasedSource(
    [entry("e1", "Race page")],
    [{ id: "w1", title: "Race widget", generation: 1, deleted: false }],
  );
  const reindex = createSearchReindexService({ pool, source });
  const first = await reindex.start();
  await assert.rejects(
    () => reindex.start(),
    (error: unknown) => (error as { code?: string }).code === "SEARCH_REINDEX_CONFLICT",
  );
  const resumed = await reindex.start({ resume: true });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.runId, first.runId, "resume continues the SAME run");
  await reindex.processChunk({
    runId: first.runId,
    chunkIndex: 0,
    phase: "entry",
    after: null,
    limit: CHUNK,
  });
  await reindex.processChunk({
    runId: first.runId,
    chunkIndex: 1,
    phase: "shop/item",
    after: null,
    limit: CHUNK,
  });
  assert.equal(await reindex.finalize({ runId: first.runId }), "done");
  assert.equal((await provider.health()).document_count, 2);
});

test("reindex phases: no extensions (entry-only) works unchanged", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, provider } = await setup(t);
  const entries = [entry("e1", "Solo page"), entry("e2", "Second page")];
  const entryOnly: SearchDocumentSource = {
    async buildDocument(entityType, entityId) {
      return entityType === "entry"
        ? (entries.find((item) => item.entity_id === entityId) ?? null)
        : null;
    },
    async listPhases() {
      return ["entry"];
    },
    async countPhase(phase) {
      if (phase !== "entry") throw new Error(`unknown phase ${phase}`);
      return entries.length;
    },
    async listPhaseIds(phase, after, limit) {
      if (phase !== "entry") throw new Error(`unknown phase ${phase}`);
      const start = after === null ? 0 : entries.findIndex((item) => item.entity_id > after);
      const slice = entries.slice(start === -1 ? entries.length : start);
      const ids = slice.slice(0, limit).map((item) => item.entity_id);
      return { ids, cursor: ids.length === limit ? (ids[ids.length - 1] ?? null) : null };
    },
  };
  const reindex = createSearchReindexService({ pool, source: entryOnly });
  await reindex.runSynchronously();
  assert.equal((await provider.health()).document_count, 2);
  assert.deepEqual(await queryOne(provider, "page"), ["entry/e1", "entry/e2"]);
});
