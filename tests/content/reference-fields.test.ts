// PCMS-CONT-T007 — Media/Relation field contracts using IDs, not URLs/paths.
// Acceptance: invalid target/reference rejected (Content spec §21/§22).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkRelationTarget,
  createEntriesService,
  defineObjectSchema,
  defineRelationSchema,
  type EntriesService,
  type EntryId,
  newEntryId,
  newStableId,
  validateStructuredValue,
} from "@pcms/content";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const MEDIA_SCHEMA = defineObjectSchema({ hero: { id: "hero", type: "media" } });
const MEDIA_LIST_SCHEMA = defineObjectSchema({
  gallery: { id: "gallery", type: "media_list" },
});

test("media values must be stable IDs — URLs and filesystem paths are rejected", () => {
  const good = validateStructuredValue(MEDIA_SCHEMA, { hero: newStableId() });
  assert.equal(good.ok, true);

  for (const notAnId of [
    "https://cdn.example.com/photo.avif",
    "/uploads/2026/photo.jpg",
    "media/12345",
    "photo.jpg",
    42,
  ]) {
    const result = validateStructuredValue(MEDIA_SCHEMA, { hero: notAnId });
    assert.equal(result.ok, false, `"${String(notAnId)}" must be rejected`);
    const issue = (result.ok ? [] : result.issues)[0];
    assert.equal(issue?.code, "MEDIA_REF_INVALID");
    assert.equal(issue?.path, "/hero");
  }

  // Optional media field may stay empty.
  assert.equal(validateStructuredValue(MEDIA_SCHEMA, { hero: null }).ok, true);
});

test("media_list is ordered and validated per element", () => {
  const first = newStableId();
  const second = newStableId();
  const good = validateStructuredValue(MEDIA_LIST_SCHEMA, { gallery: [first, second] });
  assert.equal(good.ok, true);
  assert.deepEqual(good.ok ? good.value : null, { gallery: [first, second] });

  const bad = validateStructuredValue(MEDIA_LIST_SCHEMA, {
    gallery: [first, "/uploads/x.jpg"],
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.ok ? [] : bad.issues.map((i) => i.path), ["/gallery/1"]);
});

test("relation schema validates accepts restriction at definition time", () => {
  assert.deepEqual(defineRelationSchema({ accepts: ["service", "case"] }).accepts, [
    "service",
    "case",
  ]);
  assert.equal(defineRelationSchema({}).accepts, undefined);
  assert.throws(
    () => defineRelationSchema({ accepts: [] }),
    (error: unknown) => error instanceof Error && "code" in error,
  );
  assert.throws(
    () => defineRelationSchema({ accepts: ["Bad Key"] }),
    (error: unknown) => error instanceof Error && "code" in error,
  );
});

test("relation values inside object schemas reject slugs and URLs", () => {
  const schema = defineObjectSchema({
    related: defineRelationSchema({ accepts: ["service"] }),
  });
  for (const notAnId of ["/services/audit", "audit", 42]) {
    const result = validateStructuredValue(schema, { related: notAnId });
    assert.equal(result.ok, false, `"${String(notAnId)}" must be rejected`);
    assert.equal((result.ok ? [] : result.issues)[0]?.code, "RELATION_REF_INVALID");
  }
});

async function withEntriesFixture(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool, entries: EntriesService) => Promise<void>,
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
  await run(pool, createEntriesService(pool));
}

test("relation referential validation: existence and accepted content types", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withEntriesFixture(t, async (_pool, entries) => {
    const service = await entries.createEntry({ contentTypeId: "service", createdBy: "actor-1" });
    const news = await entries.createEntry({ contentTypeId: "news", createdBy: "actor-1" });

    // Existing target of an accepted type passes.
    assert.equal(await checkRelationTarget(entries, service.id, ["service", "case"]), null);

    // Any content type passes when accepts is undefined.
    assert.equal(await checkRelationTarget(entries, news.id, undefined), null);

    // Existing target of a rejected type → RELATION_TYPE_REJECTED.
    const wrongType = await checkRelationTarget(entries, news.id, ["service", "case"]);
    assert.equal(wrongType?.code, "RELATION_TYPE_REJECTED");

    // Missing target → RELATION_TARGET_NOT_FOUND.
    const missing = await checkRelationTarget(entries, newEntryId() as EntryId, undefined);
    assert.equal(missing?.code, "RELATION_TARGET_NOT_FOUND");

    // Malformed target → RELATION_TARGET_NOT_FOUND (never matches anything).
    const malformed = await checkRelationTarget(entries, "audit", undefined);
    assert.equal(malformed?.code, "RELATION_TARGET_NOT_FOUND");
  });
});
