// PCMS-CONT-T020 — CollectionDefinition DSL + operator whitelist.
// Acceptance: no arbitrary SQL; filter/sort/limit tests (Content spec §55-§59).
// The compiled query runs against a fixture payload projection that stands in
// for the published-content view (which plugs in with publication, M07).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CollectionDefinition,
  type CollectionSourceBinding,
  compileAutomaticCollection,
  createContentTypeRegistry,
  type LoadedContentType,
  MAX_COLLECTION_LIMIT,
  validateCollectionDefinition,
} from "@pcms/content";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const SERVICE_SCHEMA: LoadedContentType = createContentTypeRegistry().registerContentType({
  key: "service",
  version: 1,
  title: "Услуга",
  fields: {
    title: { id: "title", type: "string", required: true },
    featured: { id: "featured", type: "boolean", filterable: true },
    price: { id: "price", type: "integer", filterable: true, sortable: true },
    menu_order: { id: "menu_order", type: "integer", filterable: true, sortable: true },
    summary: { id: "summary", type: "text" },
  },
});

const SCHEMAS = new Map([[SERVICE_SCHEMA.key, SERVICE_SCHEMA]]);
const SOURCE: CollectionSourceBinding = { payloadTable: "collection_fixture_payload" };

function definition(overrides: Partial<CollectionDefinition> = {}): CollectionDefinition {
  return {
    source: { contentTypes: ["service"] },
    mode: "automatic",
    ...overrides,
  };
}

test("DSL whitelist: unknown ops/fields, non-filterable fields, bad limits rejected", () => {
  assert.throws(
    () =>
      validateCollectionDefinition(
        definition({ filters: [{ field: "featured", op: "js" as "eq", value: true }] }),
        SCHEMAS,
      ),
    (error: unknown) => (error as { code?: string }).code === "COLLECTION_OP_NOT_ALLOWED",
  );
  assert.throws(
    () =>
      validateCollectionDefinition(
        definition({ filters: [{ field: "ghost", op: "eq", value: 1 }] }),
        SCHEMAS,
      ),
    (error: unknown) => (error as { code?: string }).code === "COLLECTION_FIELD_UNKNOWN",
  );
  // `summary` exists but is not declared filterable (§59).
  assert.throws(
    () =>
      validateCollectionDefinition(
        definition({ filters: [{ field: "summary", op: "contains", value: "x" }] }),
        SCHEMAS,
      ),
    (error: unknown) => (error as { code?: string }).code === "COLLECTION_FIELD_NOT_FILTERABLE",
  );
  // `featured` is filterable but not sortable.
  assert.throws(
    () =>
      validateCollectionDefinition(
        definition({ sort: [{ field: "featured", direction: "asc" }] }),
        SCHEMAS,
      ),
    (error: unknown) => (error as { code?: string }).code === "COLLECTION_FIELD_NOT_SORTABLE",
  );
  assert.throws(
    () => validateCollectionDefinition(definition({ limit: MAX_COLLECTION_LIMIT + 1 }), SCHEMAS),
    (error: unknown) => (error as { code?: string }).code === "COLLECTION_LIMIT_INVALID",
  );
  assert.throws(
    () =>
      validateCollectionDefinition(
        definition({ source: { contentTypes: ["alien_type"] } }),
        SCHEMAS,
      ),
    (error: unknown) => (error as { code?: string }).code === "COLLECTION_SOURCE_UNKNOWN",
  );
  assert.throws(
    () =>
      validateCollectionDefinition(
        definition({
          filters: [{ field: "featured", op: "eq", context: "user_supplied_script" as never }],
        }),
        SCHEMAS,
      ),
    (error: unknown) => (error as { code?: string }).code === "COLLECTION_CONTEXT_UNKNOWN",
  );
});

test("valid definition with filters, sort and limit validates", () => {
  const result = validateCollectionDefinition(
    definition({
      filters: [
        { field: "featured", op: "eq", value: true },
        { field: "price", op: "lte", value: 10000 },
      ],
      sort: [{ field: "menu_order", direction: "asc" }],
      limit: 6,
    }),
    SCHEMAS,
  );
  assert.deepEqual(
    result.map((schema) => schema.key),
    ["service"],
  );
});

test("compiled SQL is parameterized: values and field names never interpolated", () => {
  const compiled = compileAutomaticCollection(
    {
      contentTypes: ["service"],
      filters: [{ field: "featured", op: "eq", value: true }],
      sort: [{ field: "menu_order", direction: "desc" }],
      limit: 6,
      numericFields: ["price", "menu_order"],
    },
    SOURCE,
  );
  // No literal `true`, no field name, no numbers in the SQL text.
  assert.ok(!compiled.sql.includes("true"));
  assert.ok(!compiled.sql.includes("featured"));
  assert.ok(!compiled.sql.includes("menu_order"));
  assert.ok(!compiled.sql.includes("6"));
  assert.equal(compiled.params.filter((param) => param === "featured").length, 1);
  assert.equal(compiled.params.at(-1), 6);
  // Source binding identifiers are validated.
  assert.throws(
    () =>
      compileAutomaticCollection(
        { contentTypes: ["service"] },
        { payloadTable: "evil; DROP TABLE users" },
      ),
    (error: unknown) => (error as { code?: string }).code === "COLLECTION_SOURCE_INVALID",
  );
});

async function withCollectionFixture(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool) => Promise<void>,
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
  // Fixture projection standing in for the published-content view (M07).
  await pool.query(`
    CREATE TABLE collection_fixture_payload (
      entry_id uuid PRIMARY KEY,
      content_type text NOT NULL,
      archived_at timestamptz,
      fields jsonb NOT NULL
    )
  `);
  const rows: Array<[string, string, boolean | null, number, number, string]> = [
    ["11111111-2222-7333-8444-555555555551", "service", true, 5000, 2, "Аудит"],
    ["11111111-2222-7333-8444-555555555552", "service", true, 12000, 1, "Внедрение"],
    ["11111111-2222-7333-8444-555555555553", "service", false, 7000, 3, "Поддержка"],
    ["11111111-2222-7333-8444-555555555554", "service", true, 9000, 4, "Обучение"],
  ];
  for (const [entryId, contentType, featured, price, menuOrder, title] of rows) {
    await pool.query(
      `INSERT INTO collection_fixture_payload (entry_id, content_type, archived_at, fields)
       VALUES ($1, $2, NULL, $3)`,
      [entryId, contentType, JSON.stringify({ featured, price, menu_order: menuOrder, title })],
    );
  }
  await run(pool);
}

test("filter/sort/limit execute against the payload projection via compiled SQL", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withCollectionFixture(t, async (pool) => {
    const def = validateCollectionDefinition(
      definition({
        filters: [{ field: "featured", op: "eq", value: true }],
        sort: [{ field: "menu_order", direction: "asc" }],
        limit: 2,
      }),
      SCHEMAS,
    );
    void def;
    const compiled = compileAutomaticCollection(
      {
        contentTypes: ["service"],
        filters: [{ field: "featured", op: "eq", value: true }],
        sort: [{ field: "menu_order", direction: "asc" }],
        limit: 2,
        numericFields: ["price", "menu_order"],
      },
      SOURCE,
    );
    const result = await pool.query<{ entry_id: string }>(compiled.sql, [...compiled.params]);
    // featured=true ordered by menu_order asc, limited to 2: Внедрение(1), Аудит(2).
    assert.deepEqual(
      result.rows.map((row) => row.entry_id.slice(-1)),
      ["2", "1"],
    );

    // gte filter: price >= 7000 → 12000, 9000 (desc by price).
    const priceQuery = compileAutomaticCollection(
      {
        contentTypes: ["service"],
        filters: [{ field: "price", op: "gte", value: 7000 }],
        sort: [{ field: "price", direction: "desc" }],
        numericFields: ["price", "menu_order"],
      },
      SOURCE,
    );
    const priceResult = await pool.query<{ entry_id: string }>(priceQuery.sql, [
      ...priceQuery.params,
    ]);
    assert.deepEqual(
      priceResult.rows.map((row) => row.entry_id.slice(-1)),
      ["2", "4", "3"],
    );

    // `in` operator.
    const inQuery = compileAutomaticCollection(
      {
        contentTypes: ["service"],
        filters: [{ field: "menu_order", op: "in", value: [1, 4] }],
        numericFields: ["price", "menu_order"],
      },
      SOURCE,
    );
    const inResult = await pool.query<{ entry_id: string }>(inQuery.sql, [...inQuery.params]);
    assert.deepEqual(inResult.rows.map((row) => row.entry_id.slice(-1)).sort(), ["2", "4"]);

    // contains on a string field value.
    const containsQuery = compileAutomaticCollection(
      {
        contentTypes: ["service"],
        filters: [{ field: "title", op: "contains", value: "Аудит" }],
      },
      SOURCE,
    );
    const containsResult = await pool.query<{ entry_id: string }>(containsQuery.sql, [
      ...containsQuery.params,
    ]);
    assert.deepEqual(
      containsResult.rows.map((row) => row.entry_id.slice(-1)),
      ["1"],
    );

    // neq with NULL semantics: featured != true also returns rows where it is unset.
    const neqQuery = compileAutomaticCollection(
      { contentTypes: ["service"], filters: [{ field: "featured", op: "neq", value: true }] },
      SOURCE,
    );
    const neqResult = await pool.query<{ entry_id: string }>(neqQuery.sql, [...neqQuery.params]);
    assert.deepEqual(
      neqResult.rows.map((row) => row.entry_id.slice(-1)),
      ["3"],
    );
  });
});
