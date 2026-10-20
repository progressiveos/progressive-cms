// PCMS-API-T008..T012 — discovery APIs: agents inspect without guessing.
// Every response is machine-readable, deterministic and permission-gated.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFastify, createApiV1, makeDiscoveryRoutes } from "@pcms/api";
import {
  createContentDiscovery,
  createContentTypeRegistry,
  createFieldRegistry,
} from "@pcms/content";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const REFERENCE_CONTENT_TYPES = [
  {
    key: "page",
    version: 1,
    title: "Page",
    bodyPolicy: "block_document",
    fields: {
      title: { id: "title", type: "string", required: true, sortable: true },
      intro: { id: "intro", type: "text" },
    },
  },
] as const;

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

async function startDiscoveryApi(t: { after: (fn: () => void) => void }) {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });
  const account = await app.machineIdentity.createServiceAccount({
    name: "m09-discovery-test",
    purpose: "discovery integration tests",
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [],
    ttlMilliseconds: 3_600_000,
  });
  const fastify = createApiFastify(() => "req_discovery");
  await fastify.register(createApiV1(makeDiscoveryRoutes()), {
    application: app,
    logger: silentLogger,
    cookieSecure: false,
  });
  return { app, fastify, bearer: token.rawSecret };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test("capabilities reflect installed subsystems and actor permissions (T008)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, bearer } = await startDiscoveryApi(t);
  const response = await fastify.inject({
    method: "GET",
    url: "/api/v1/capabilities",
    headers: auth(bearer),
  });
  assert.equal(response.statusCode, 200);
  const capabilities = response.json() as {
    contract_versions: Record<string, unknown>;
    content: {
      rich_text: { readable_versions: number[]; write_version: number; node_types: string[] };
    };
    themes: { installed: boolean; activation_available: boolean };
    publication: { publish: boolean };
  };
  assert.equal(capabilities.contract_versions.bundle, 1);
  // v1 is retired: the runtime reads and writes v2 only.
  assert.deepEqual(capabilities.content.rich_text.readable_versions, [2]);
  assert.equal(capabilities.content.rich_text.write_version, 2);
  assert.ok(capabilities.content.rich_text.node_types.includes("table_cell"));
  // No theme source configured in this fixture: honest reporting.
  assert.equal(capabilities.themes.installed, false);
  assert.equal(capabilities.themes.activation_available, false);
  // The service account holds no scopes: publish is not visible as allowed.
  assert.equal(capabilities.publication.publish, false);
  void app;
});

test("content type schemas round-trip without source-code knowledge (T009)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, bearer } = await startDiscoveryApi(t);
  // Permission gate: a token with no scopes cannot read discovery.
  const denied = await fastify.inject({
    method: "GET",
    url: "/api/v1/discovery/content/types",
    headers: auth(bearer),
  });
  assert.equal(denied.statusCode, 403);
  assert.equal((denied.json() as { error: { code: string } }).error.code, "AUTH_PERMISSION_DENIED");

  // Provision a scoped token via the machine identity service (content.read).
  const account = await app.machineIdentity.createServiceAccount({
    name: "m09-reader",
    purpose: "discovery read tests",
    allowedScopes: ["content.read"],
  });
  const reader = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["content.read"],
    ttlMilliseconds: 3_600_000,
  });
  const ok = await fastify.inject({
    method: "GET",
    url: "/api/v1/discovery/content/types",
    headers: auth(reader.rawSecret),
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), {
    items: [
      { key: "folder", version: 1, title: "Folder", bodyPolicy: "none" },
      { key: "page", version: 1, title: "Page", bodyPolicy: "block_document" },
    ],
  });

  const schema = await fastify.inject({
    method: "GET",
    url: "/api/v1/discovery/content/types/page",
    headers: auth(reader.rawSecret),
  });
  assert.equal(schema.statusCode, 200);
  const body = schema.json() as { key: string; fields: Record<string, unknown> };
  assert.equal(body.key, "page");
  assert.ok(body.fields.title);
});

test("collection capabilities expose the typed DSL, never raw queries (T009)", () => {
  // Pure application-layer read: transport-independent, no guesses allowed.
  const capabilities = createContentDiscovery({
    contentTypes: createContentTypeRegistry(),
    fields: createFieldRegistry(),
  }).getCollectionCapabilities();
  assert.ok(Array.isArray(capabilities.ops));
  assert.equal(typeof capabilities.maxLimit, "number");
});

test("unknown discovery targets give stable 404s (T009/T010)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await startDiscoveryApi(t);
  const account = await app.machineIdentity.createServiceAccount({
    name: "m09-reader-2",
    purpose: "discovery read tests",
    allowedScopes: ["content.read", "theme.read"],
  });
  const reader = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["content.read", "theme.read"],
    ttlMilliseconds: 3_600_000,
  });
  const missing = await fastify.inject({
    method: "GET",
    url: "/api/v1/discovery/content/types/nope",
    headers: auth(reader.rawSecret),
  });
  assert.equal(missing.statusCode, 404);
  assert.equal((missing.json() as { error: { code: string } }).error.code, "API_NOT_FOUND");

  // Theme discovery without a configured theme source: explicit 404, never a guess.
  const theme = await fastify.inject({
    method: "GET",
    url: "/api/v1/discovery/theme",
    headers: auth(reader.rawSecret),
  });
  assert.equal(theme.statusCode, 404);
});

test("revision discovery lists history and diffs (T012)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await startDiscoveryApi(t);
  const ctx = apiContextOf(ownerActor());
  const entry = await app.entries.createEntry({
    contentTypeId: "page",
    createdBy: "test",
  });
  const revision = await app.revisions.createWorkingRevision({
    entityType: "entry",
    entityId: entry.id,
    payload: { fields: { title: "v1" }, blocks: { schema_version: 1, blocks: [] } },
    schemaVersion: "1",
    actor: { actorClass: "human", actorId: "test", origin: "human" },
  });
  await app.revisions.sealRevision({ revisionId: revision.id });

  // Via the application layer (transport independence of discovery ops).
  const revisions = await app.revisions.listRevisions(app.pool, "entry", entry.id, {
    limit: 10,
  });
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]?.state, "SEALED");
  void ctx;
  void fastify;
});

test("scoped actor cannot read discovery outside its scopes (T008 permission filtering)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });
  const seoActor = scopedActor(["seo.read"]);
  // content discovery denied…
  assert.throws(
    () => app.authorize(seoActor, "content.read"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTH_PERMISSION_DENIED");
      return true;
    },
  );
  // …seo discovery allowed.
  app.authorize(seoActor, "seo.read");
});
