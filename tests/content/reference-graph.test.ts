// PCMS-CONT-T018 — relation/reference graph + inbound usage query.
// Acceptance: deleting referenced target produces impact result
// (Content spec §60/§61).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ContentTypeDefinition,
  createContentTypeRegistry,
  createEntriesService,
  createReferenceGraphService,
  type EntriesService,
  type LoadedContentType,
  newEntryId,
  newStableId,
  type ReferenceGraphService,
} from "@pcms/content";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const CASE: ContentTypeDefinition = {
  key: "case",
  version: 1,
  title: "Кейс",
  fields: {
    title: { id: "title", type: "string", required: true },
    client_logo: { id: "client_logo", type: "media" },
    gallery: { id: "gallery", type: "media_list" },
    related_service: { id: "related_service", type: "relation", accepts: ["service"] },
    related: { id: "related", type: "relation_list" },
  },
};

interface Fixture {
  pool: DbPool;
  entries: EntriesService;
  graph: ReferenceGraphService;
  schema: LoadedContentType;
}

async function withGraphFixture(
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
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const registry = createContentTypeRegistry();
  const schema = registry.registerContentType(CASE);
  await run({
    pool,
    entries: createEntriesService(pool),
    graph: createReferenceGraphService(pool),
    schema,
  });
}

test("syncReferences derives graph rows from payload: relations and media with paths", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withGraphFixture(t, async ({ entries, graph, schema }) => {
    const service = await entries.createEntry({ contentTypeId: "service", createdBy: "actor-1" });
    const anotherCase = await entries.createEntry({ contentTypeId: "case", createdBy: "actor-1" });
    const mediaA = newStableId();
    const mediaB = newStableId();

    const source = await entries.createEntry({
      contentTypeId: "case",
      createdBy: "actor-1",
      parentEntryId: anotherCase.id,
    });
    await graph.syncReferences(source.id, schema, {
      title: "Кейс X",
      client_logo: mediaA,
      gallery: [mediaA, mediaB],
      related_service: service.id,
      related: [anotherCase.id],
    });

    const outbound = await graph.listOutboundReferences(source.id);
    assert.deepEqual(
      outbound.map((reference) => [reference.path, reference.kind]),
      [
        ["/client_logo", "media"],
        ["/gallery/0", "media"],
        ["/gallery/1", "media"],
        ["/related/0", "entry"],
        ["/related_service", "entry"],
      ],
    );

    // "Кто ссылается на Entry X?" (§60)
    const inboundService = await graph.listInboundReferences("entry", service.id);
    assert.deepEqual(
      inboundService.map((reference) => [reference.sourceEntryId, reference.sourcePath]),
      [[source.id, "/related_service"]],
    );
    // "Где используется Media Y?" (§60)
    const inboundMedia = await graph.listInboundReferences("media", mediaA);
    assert.equal(inboundMedia.length, 2);
  });
});

test("re-sync replaces the reference set atomically (no stale rows)", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withGraphFixture(t, async ({ entries, graph, schema }) => {
    const target = await entries.createEntry({ contentTypeId: "service", createdBy: "actor-1" });
    const source = await entries.createEntry({ contentTypeId: "case", createdBy: "actor-1" });
    await graph.syncReferences(source.id, schema, {
      title: "v1",
      related_service: target.id,
      gallery: [newStableId()],
    });
    // Updated payload: relation dropped, new media set.
    const newMedia = newStableId();
    await graph.syncReferences(source.id, schema, { title: "v2", gallery: [newMedia] });

    const inbound = await graph.listInboundReferences("entry", target.id);
    assert.equal(inbound.length, 0, "stale relation must disappear from the graph");
    const outbound = await graph.listOutboundReferences(source.id);
    assert.deepEqual(
      outbound.map((reference) => [reference.path, reference.kind]),
      [["/gallery/0", "media"]],
    );
  });
});

test("deleting a referenced target produces a delete impact result", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withGraphFixture(t, async ({ entries, graph, schema, pool }) => {
    const target = await entries.createEntry({ contentTypeId: "service", createdBy: "actor-1" });
    const caseA = await entries.createEntry({ contentTypeId: "case", createdBy: "actor-1" });
    const caseB = await entries.createEntry({ contentTypeId: "case", createdBy: "actor-1" });
    await graph.syncReferences(caseA.id, schema, { title: "A", related_service: target.id });
    await graph.syncReferences(caseB.id, schema, { title: "B", related: [target.id] });

    const impact = await graph.checkDeleteImpact("entry", target.id);
    assert.equal(impact.kind, "entry");
    assert.equal(impact.inboundCount, 2);
    assert.deepEqual(impact.referencingEntries.sort(), [caseA.id, caseB.id].sort());
    assert.ok(impact.references.every((reference) => reference.sourcePath !== ""));

    // Media impact: same query shape ("где используется Media Y?").
    const media = newStableId();
    await graph.syncReferences(caseA.id, schema, { title: "A2", client_logo: media });
    const mediaImpact = await graph.checkDeleteImpact("media", media);
    assert.deepEqual(mediaImpact.referencingEntries, [caseA.id]);

    // Deleting the source entry cascades its outbound rows (FK ON DELETE CASCADE).
    await pool.query("DELETE FROM entries WHERE id = $1", [caseA.id]);
    assert.equal((await graph.listInboundReferences("media", media)).length, 0);
  });
});

test("clearReferences removes outbound rows without touching others", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withGraphFixture(t, async ({ entries, graph, schema }) => {
    const target = await entries.createEntry({ contentTypeId: "service", createdBy: "actor-1" });
    const source = await entries.createEntry({ contentTypeId: "case", createdBy: "actor-1" });
    await graph.syncReferences(source.id, schema, { title: "x", related_service: target.id });
    await graph.clearReferences(source.id);
    assert.equal((await graph.listInboundReferences("entry", target.id)).length, 0);
    assert.equal((await graph.listOutboundReferences(source.id)).length, 0);
  });
});

test("malformed reference shapes are skipped by extraction, never stored", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withGraphFixture(t, async ({ entries, graph, schema }) => {
    const source = await entries.createEntry({ contentTypeId: "case", createdBy: "actor-1" });
    await graph.syncReferences(source.id, schema, {
      title: "x",
      client_logo: "/uploads/logo.png", // invalid shape — validation reports it, graph skips it
      related: ["slug-instead-of-id"],
    });
    assert.equal((await graph.listOutboundReferences(source.id)).length, 0);
    // Unknown target (not required to exist at sync time — dangling is a
    // publish-validation concern, §61), well-formed IDs are recorded.
    await graph.syncReferences(source.id, schema, { title: "x", related: [newEntryId()] });
    assert.equal((await graph.listOutboundReferences(source.id)).length, 1);
  });
});
