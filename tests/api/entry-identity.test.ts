// M16 external identity + human-edit reconciliation (task brief §38–§44).
// The spangar M15 sync could only match by route/title and would have
// silently reverted a human edit; these surfaces make the agent ask first.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createApiFastify,
  createApiV1,
  createDraft,
  makeAgentRoutes,
  type OperationContext,
} from "@pcms/api";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const REFERENCE_CONTENT_TYPES = [
  {
    key: "page",
    version: 1,
    title: "Page",
    bodyPolicy: "block_document",
    fields: {
      title: { id: "title", type: "string", required: true, sortable: true },
    },
  },
] as const;

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

const OWNER_CTX = (): OperationContext => apiContextOf(ownerActor(), "rest", "req_identity");

async function identityApi(t: { after: (fn: () => void) => void }) {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });
  await app.routes.ensureSite("default", "Identity Test Site");
  const fastify = createApiFastify(() => "req_entry_identity");
  await fastify.register(createApiV1(makeAgentRoutes()), {
    application: app,
    logger: silentLogger,
    cookieSecure: false,
  });
  const account = await app.machineIdentity.createServiceAccount({
    name: "m16-identity",
    purpose: "external identity tests",
    allowedScopes: ["content.read", "content.edit"],
  });
  const readToken = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["content.read"],
    ttlMilliseconds: 3_600_000,
  });
  const editToken = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["content.read", "content.edit"],
    ttlMilliseconds: 3_600_000,
  });
  const entry = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: { fields: { title: "Migrated article" }, blocks: { schema_version: 1, blocks: [] } },
  });
  return {
    app,
    fastify,
    entryId: entry.entry_id as string,
    read: readToken.rawSecret,
    edit: editToken.rawSecret,
  };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const NS = "legacy%3Aexample.test";
const EXT = "%2Fblog%2Ffoo";

test("resolve before bind → 404 EXTERNAL_IDENTITY_NOT_FOUND", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify, read } = await identityApi(t);
  const response = await fastify.inject({
    method: "GET",
    url: `/api/v1/external-identities/${NS}/${EXT}`,
    headers: auth(read),
  });
  assert.equal(response.statusCode, 404);
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    "EXTERNAL_IDENTITY_NOT_FOUND",
  );
});

test("bind → resolve → BASELINE_UNSET; re-bind same entry is idempotent", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify, entryId, edit, read } = await identityApi(t);
  const bind = await fastify.inject({
    method: "PUT",
    url: `/api/v1/external-identities/${NS}/${EXT}`,
    headers: auth(edit),
    payload: { entry_id: entryId, source_hash: "abc123" },
  });
  assert.equal(bind.statusCode, 200);
  const bound = bind.json() as { bound: boolean; entry_id: string };
  assert.equal(bound.bound, true);
  assert.equal(bound.entry_id, entryId);

  const resolve = await fastify.inject({
    method: "GET",
    url: `/api/v1/external-identities/${NS}/${EXT}`,
    headers: auth(read),
  });
  assert.equal(resolve.statusCode, 200);
  const body = resolve.json() as {
    entry_id: string;
    reconciliation: {
      state: string;
      baseline_generation: number | null;
      current_generation: number;
    };
  };
  assert.equal(body.entry_id, entryId);
  assert.equal(body.reconciliation.state, "BASELINE_UNSET");

  // Idempotent re-bind: same entry updates the row, no duplicate/conflict.
  const rebind = await fastify.inject({
    method: "PUT",
    url: `/api/v1/external-identities/${NS}/${EXT}`,
    headers: auth(edit),
    payload: { entry_id: entryId, source_hash: "abc123" },
  });
  assert.equal(rebind.statusCode, 200);
});

test("binding a different entry to a bound identity → 409 EXTERNAL_IDENTITY_CONFLICT", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, entryId, edit } = await identityApi(t);
  const other = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: { fields: { title: "Other page" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await fastify.inject({
    method: "PUT",
    url: `/api/v1/external-identities/${NS}/${EXT}`,
    headers: auth(edit),
    payload: { entry_id: entryId },
  });
  const conflict = await fastify.inject({
    method: "PUT",
    url: `/api/v1/external-identities/${NS}/${EXT}`,
    headers: auth(edit),
    payload: { entry_id: other.entry_id },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(
    (conflict.json() as { error: { code: string } }).error.code,
    "EXTERNAL_IDENTITY_CONFLICT",
  );
});

test("generation drift → HUMAN_EDIT_CONFLICT; equal → IN_SYNC; source hash compared", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify, entryId, edit, read } = await identityApi(t);
  // Baseline generation 1 while the entry was never published (generation 0)
  // → exactly the "someone moved the pointer past my baseline" divergence.
  await fastify.inject({
    method: "PUT",
    url: `/api/v1/external-identities/${NS}/${EXT}`,
    headers: auth(edit),
    payload: { entry_id: entryId, source_hash: "src-1", last_agent_generation: 1 },
  });
  let resolve = await fastify.inject({
    method: "GET",
    url: `/api/v1/external-identities/${NS}/${EXT}`,
    headers: auth(read),
  });
  let body = resolve.json() as {
    reconciliation: {
      state: string;
      baseline_generation: number | null;
      current_generation: number;
      source_changed: boolean | null;
    };
  };
  assert.equal(body.reconciliation.state, "HUMAN_EDIT_CONFLICT");
  assert.equal(body.reconciliation.baseline_generation, 1);
  assert.equal(body.reconciliation.current_generation, 0);

  // Source drift is reported when the caller supplies the new source hash.
  resolve = await fastify.inject({
    method: "GET",
    url: `/api/v1/external-identities/${NS}/${EXT}?source_hash=src-2`,
    headers: auth(read),
  });
  body = resolve.json() as typeof body;
  assert.equal(body.reconciliation.source_changed, true);

  // Equal generations → safe to compare/apply.
  await fastify.inject({
    method: "PUT",
    url: `/api/v1/external-identities/${NS}/${EXT}`,
    headers: auth(edit),
    payload: {
      entry_id: entryId,
      source_hash: "src-2",
      last_agent_generation: 0,
      run_id: "run-42",
    },
  });
  resolve = await fastify.inject({
    method: "GET",
    url: `/api/v1/external-identities/${NS}/${EXT}?source_hash=src-2`,
    headers: auth(read),
  });
  body = resolve.json() as typeof body;
  assert.equal(body.reconciliation.state, "IN_SYNC");
  assert.equal(body.reconciliation.source_changed, false);
});

test("permissions: bind needs content.edit; anonymous is 401", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify, entryId, read } = await identityApi(t);
  // The read-only token cannot bind.
  const denied = await fastify.inject({
    method: "PUT",
    url: `/api/v1/external-identities/${NS}/${EXT}`,
    headers: auth(read),
    payload: { entry_id: entryId },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal((denied.json() as { error: { code: string } }).error.code, "AUTH_PERMISSION_DENIED");
  // Anonymous resolve is rejected at the auth layer.
  const anonymous = await fastify.inject({
    method: "GET",
    url: `/api/v1/external-identities/${NS}/${EXT}`,
  });
  assert.equal(anonymous.statusCode, 401);
});
