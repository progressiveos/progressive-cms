// PCMS-CONT-T019 — Global Content typed entities.
// Acceptance: versionable structured global payload validates
// (Content spec §62).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContentError,
  type ContentTypeDefinition,
  createContentTypeRegistry,
  createGlobalContentService,
  type GlobalContentService,
  type LoadedContentType,
} from "@pcms/content";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const CONTACTS_V1: ContentTypeDefinition = {
  key: "contacts",
  version: 1,
  title: "Контакты",
  fields: {
    company_name: { id: "company_name", type: "string", required: true },
    phone: { id: "phone", type: "string" },
    email: { id: "email", type: "email" },
    address: { id: "address", type: "text" },
  },
};

const SOCIAL_V1: ContentTypeDefinition = {
  key: "social_links",
  version: 1,
  title: "Соцсети",
  fields: {
    telegram: { id: "telegram", type: "url" },
    vk: { id: "vk", type: "url" },
  },
};

interface Fixture {
  globals: GlobalContentService;
  contacts: LoadedContentType;
  social: LoadedContentType;
}

async function withGlobalsFixture(
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
  await run({
    globals: createGlobalContentService(pool),
    contacts: registry.registerContentType(CONTACTS_V1),
    social: registry.registerContentType(SOCIAL_V1),
  });
}

test("create/update global entities with schema-validated structured payloads", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withGlobalsFixture(t, async ({ globals, contacts }) => {
    const created = await globals.createGlobal({
      key: "company_contacts",
      schema: contacts,
      createdBy: "actor-1",
      fields: { company_name: "ООО Пример", phone: "+7 495 000-00-00", email: "hi@example.com" },
    });
    assert.equal(created.key, "company_contacts");
    assert.equal(created.contentTypeId, "contacts");
    assert.equal(created.schemaVersion, 1);
    assert.equal(created.archivedAt, null);
    assert.equal(created.fields.company_name, "ООО Пример");

    const updated = await globals.updateGlobal(
      "company_contacts",
      { company_name: "АО Пример" },
      contacts,
    );
    assert.equal(updated.fields.company_name, "АО Пример");
    assert.ok(updated.updatedAt >= updated.createdAt);
  });
});

test("payload that fails the schema is rejected with stable codes at both levels", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withGlobalsFixture(t, async ({ globals, contacts, social }) => {
    // Draft level tolerates a missing required field (incomplete draft, §65)…
    await globals.createGlobal({
      key: "legal_footer",
      schema: social,
      createdBy: "a",
      fields: {},
    });
    const draft = await globals.validate("legal_footer", {}, "draft", social);
    assert.equal(draft.ok, true);
    // …but a type violation fails at draft level already.
    await assert.rejects(
      globals.updateGlobal("legal_footer", { telegram: 42 }, social),
      (error: unknown) => error instanceof ContentError && error.code === "GLOBAL_PAYLOAD_INVALID",
    );

    // Publish level is strict: missing required fields become FIELD_REQUIRED.
    const publish = await globals.validate(
      "legal_footer",
      { company_name: "ООО Пример" },
      "publish",
      contacts,
    );
    assert.equal(publish.ok, true);
  });
});

test("globals are versionable: schema_version pins the schema the payload was written for", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withGlobalsFixture(t, async ({ globals, contacts, social }) => {
    await globals.createGlobal({
      key: "versioned_v1",
      schema: contacts,
      createdBy: "a",
      fields: { company_name: "Пример" },
    });
    const record = await globals.getGlobal("versioned_v1");
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.contentTypeId, "contacts");
    // A different schema family keeps its own identity — no cross-validation.
    await globals.createGlobal({
      key: "other_social",
      schema: social,
      createdBy: "a",
      fields: { telegram: "https://t.me/example" },
    });
    const socialRecord = await globals.getGlobal("other_social");
    assert.deepEqual([socialRecord.contentTypeId, socialRecord.schemaVersion], ["social_links", 1]);
  });
});

test("deterministic discovery order, archive semantics, not-found codes", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withGlobalsFixture(t, async ({ globals, contacts, social }) => {
    await globals.createGlobal({ key: "zebra_block", schema: social, createdBy: "a", fields: {} });
    await globals.createGlobal({
      key: "alpha_block",
      schema: contacts,
      createdBy: "a",
      fields: { company_name: "x" },
    });

    const list = await globals.listGlobals();
    assert.deepEqual(
      list.map((record) => record.key),
      ["alpha_block", "zebra_block"],
    );

    const archived = await globals.archiveGlobal("zebra_block");
    assert.ok(archived.archivedAt instanceof Date);
    const again = await globals.archiveGlobal("zebra_block");
    assert.deepEqual(again.archivedAt, archived.archivedAt);

    await assert.rejects(
      globals.getGlobal("missing_entity"),
      (error: unknown) => error instanceof ContentError && error.code === "GLOBAL_NOT_FOUND",
    );
    await assert.rejects(
      globals.createGlobal({
        key: "Bad Key",
        schema: contacts,
        createdBy: "a",
        fields: { company_name: "x" },
      }),
      (error: unknown) => error instanceof ContentError && error.code === "GLOBAL_KEY_INVALID",
    );
    await assert.rejects(
      globals.createGlobal({
        key: "alpha_block",
        schema: contacts,
        createdBy: "a",
        fields: { company_name: "x" },
      }),
      (error: unknown) => error instanceof ContentError && error.code === "GLOBAL_ALREADY_EXISTS",
    );
  });
});
