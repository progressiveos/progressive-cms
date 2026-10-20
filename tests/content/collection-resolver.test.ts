// PCMS-CONT-T021 — manual/automatic/hybrid collection resolver.
// Acceptance: pinned order + duplicate exclusion verified (Content spec §56).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CollectionDefinition,
  type CollectionResolver,
  createCollectionResolver,
  createContentTypeRegistry,
  type LoadedContentType,
  type StableId,
} from "@pcms/content";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const SCHEMA: LoadedContentType = createContentTypeRegistry().registerContentType({
  key: "service",
  version: 1,
  title: "Услуга",
  fields: {
    featured: { id: "featured", type: "boolean", filterable: true },
    menu_order: { id: "menu_order", type: "integer", filterable: true, sortable: true },
  },
});

const SCHEMAS = new Map([[SCHEMA.key, SCHEMA]]);
const SOURCE = { payloadTable: "collection_resolver_fixture" };
const NUMERIC = ["menu_order"];

// Stable fixture IDs whose last digit encodes the expected order.
const idEndingWith = (digit: string): StableId =>
  `11111111-2222-7333-8444-55555555555${digit}` as StableId;

function definition(overrides: Partial<CollectionDefinition> = {}): CollectionDefinition {
  return {
    source: { contentTypes: ["service"] },
    mode: "automatic",
    ...overrides,
  };
}

async function withResolverFixture(
  t: { after: (fn: () => void) => void },
  run: (resolver: CollectionResolver, pool: DbPool) => Promise<void>,
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
  await pool.query(`
    CREATE TABLE collection_resolver_fixture (
      entry_id uuid PRIMARY KEY,
      content_type text NOT NULL,
      archived_at timestamptz,
      fields jsonb NOT NULL
    )
  `);
  const rows: Array<[string, boolean, number]> = [
    [idEndingWith("1"), true, 3],
    [idEndingWith("2"), true, 1],
    [idEndingWith("3"), true, 2],
    [idEndingWith("4"), false, 4],
  ];
  for (const [entryId, featured, menuOrder] of rows) {
    await pool.query(
      `INSERT INTO collection_resolver_fixture (entry_id, content_type, archived_at, fields)
       VALUES ($1, 'service', NULL, $2)`,
      [entryId, JSON.stringify({ featured, menu_order: menuOrder })],
    );
  }
  await run(createCollectionResolver(pool), pool);
}

test("manual mode returns pinned IDs in their explicit order", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withResolverFixture(t, async (resolver) => {
    const pinned = [idEndingWith("4"), idEndingWith("1")];
    const result = await resolver.resolve(
      definition({ mode: "manual", pinnedIds: pinned }),
      SCHEMAS,
      SOURCE,
    );
    assert.equal(result.mode, "manual");
    assert.deepEqual(result.entryIds, pinned);
    assert.equal(result.automaticFillCount, 0);
  });
});

test("automatic mode returns the compiled query order", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withResolverFixture(t, async (resolver) => {
    const result = await resolver.resolve(
      definition({
        filters: [{ field: "featured", op: "eq", value: true }],
        sort: [{ field: "menu_order", direction: "asc" }],
        limit: 10,
      }),
      SCHEMAS,
      SOURCE,
      { numericFields: NUMERIC },
    );
    assert.equal(result.mode, "automatic");
    // featured=true by menu_order asc: 2, 3, 1.
    assert.deepEqual(result.entryIds, [idEndingWith("2"), idEndingWith("3"), idEndingWith("1")]);
  });
});

test("hybrid mode: pinned first, automatic fill excluding duplicates", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withResolverFixture(t, async (resolver) => {
    // Pinned 3 and 1; automatic (featured asc) would give 2, 3, 1 — 3 and 1
    // are duplicates and must not repeat.
    const result = await resolver.resolve(
      definition({
        mode: "hybrid",
        pinnedIds: [idEndingWith("3"), idEndingWith("1")],
        filters: [{ field: "featured", op: "eq", value: true }],
        sort: [{ field: "menu_order", direction: "asc" }],
        limit: 10,
      }),
      SCHEMAS,
      SOURCE,
      { numericFields: NUMERIC },
    );
    assert.equal(result.mode, "hybrid");
    assert.deepEqual(result.entryIds, [idEndingWith("3"), idEndingWith("1"), idEndingWith("2")]);
    assert.equal(result.automaticFillCount, 1);

    // Limit bounds the total: limit=2 keeps only the two pinned entries.
    const bounded = await resolver.resolve(
      definition({
        mode: "hybrid",
        pinnedIds: [idEndingWith("3"), idEndingWith("1")],
        filters: [{ field: "featured", op: "eq", value: true }],
        sort: [{ field: "menu_order", direction: "asc" }],
        limit: 2,
      }),
      SCHEMAS,
      SOURCE,
      { numericFields: NUMERIC },
    );
    assert.deepEqual(bounded.entryIds, [idEndingWith("3"), idEndingWith("1")]);
  });
});
