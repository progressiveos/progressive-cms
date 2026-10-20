// PCMS-SEO-T001 — SEO store persistence (PostgreSQL). Validated documents
// round-trip; invalid payloads never reach a row; the entry id is a stable id.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  loadMigrations,
  migrateDatabase,
  newStableId,
} from "@pcms/core";
import { createSeoStore, emptySeoDocument, type SeoError } from "@pcms/seo";
import {
  assertBaseReachable,
  createTestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

async function makeStore(
  t: test.TestContext,
): Promise<{ pool: DbPool; store: ReturnType<typeof createSeoStore> }> {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: {
      host: db.connection.host,
      port: db.connection.port,
      database: db.connection.database,
      user: db.connection.user,
      sslMode: "disable" as const,
      ...(db.connection.password === undefined ? {} : { password: db.connection.password }),
    },
    max: 3,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return { pool, store: createSeoStore(pool) };
}

test("documents round-trip and list deterministically", { skip: DB_SKIP }, async (t) => {
  const { store } = await makeStore(t);
  const a = newStableId();
  const b = newStableId();

  assert.equal(await store.getDocument(a), null);

  const doc = {
    ...emptySeoDocument(),
    seo_title: "T",
    robots_policy: { index: false, follow: true, noarchive: true },
    social_image: { asset_id: newStableId(), version: 3 },
  };
  await store.saveDocument(a, doc);
  await store.saveDocument(b, emptySeoDocument());
  // Upsert: saving again updates, never duplicates.
  await store.saveDocument(a, { ...doc, seo_title: "T2" });

  const list = await store.listDocuments();
  const byId = new Map(list.map((r) => [r.entryId, r.document.seo_title]));
  assert.equal(byId.size, 2);
  assert.equal(byId.get(a), "T2");
  assert.equal(byId.get(b), null);
  // Deterministic order: sorted by entry id.
  const ids = list.map((r) => r.entryId);
  assert.deepEqual([...ids].sort(), ids);
  const read = await store.getDocument(a);
  assert.equal(read?.seo_title, "T2");
  assert.deepEqual(read?.robots_policy, { index: false, follow: true, noarchive: true });
  assert.deepEqual(read?.social_image, {
    asset_id: doc.social_image.asset_id,
    version: 3,
  });

  await store.deleteDocument(a);
  assert.equal(await store.getDocument(a), null);
});

test("invalid payloads and ids are rejected before any row is written", {
  skip: DB_SKIP,
}, async (t) => {
  const { pool, store } = await makeStore(t);
  await assert.rejects(
    () =>
      store.saveDocument(newStableId(), {
        ...emptySeoDocument(),
        robots_policy: "noindex" as never,
      }),
    (err: SeoError) => err.code === "SEO_DOCUMENT_INVALID",
  );
  await assert.rejects(
    () => store.saveDocument("not-a-stable-id", emptySeoDocument()),
    (err: SeoError) => err.code === "SEO_ID_INVALID",
  );
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM seo_documents");
  assert.equal(rows[0]?.n, 0);
});
