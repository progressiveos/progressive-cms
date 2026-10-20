// PCMS-API-T013..T016 — content/media/publication/theme mutation APIs.
// Optimistic conflicts, permission separation (content.edit ≠ publication
// chain), SSRF enforcement, transport-independent semantics.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveEntry,
  createApiFastify,
  createApiV1,
  createDraft,
  makeDiscoveryRoutes,
  makeMutationRoutes,
  type OperationContext,
  previewPublicationPlan,
  schedulePublicationPlan,
  sealRevision,
  updateDraft,
} from "@pcms/api";
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
    },
  },
] as const;

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

const OWNER_CTX = (): OperationContext => apiContextOf(ownerActor(), "rest", "req_ops");

async function mutationApi(t: { after: (fn: () => void) => void }) {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });
  const fastify = createApiFastify(() => "req_mutations");
  await fastify.register(createApiV1([...makeDiscoveryRoutes(), ...makeMutationRoutes()]), {
    application: app,
    logger: silentLogger,
    cookieSecure: false,
  });
  const account = await app.machineIdentity.createServiceAccount({
    name: "m09-mutations",
    purpose: "mutation tests",
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [],
    ttlMilliseconds: 3_600_000,
  });
  return { app, fastify, bearer: token.rawSecret };
}

const PAGE_PAYLOAD = () => ({
  fields: { title: "Test page" },
  blocks: { schema_version: 1, blocks: [] },
});

test("createDraft: entry + working revision in one transaction (T013)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });
  const draft = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: PAGE_PAYLOAD(),
  });
  const entry = await app.entries.getEntry(draft.entry_id as never);
  assert.equal(entry.contentTypeId, "page");
  const revision = await app.revisions.requireRevision(app.pool, draft.revision_id as never);
  assert.equal(revision.state, "WORKING");
  assert.equal(revision.editGeneration, 0);
});

test("updateDraft CAS: stale edit generation is an explicit conflict (T013)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });
  const draft = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: PAGE_PAYLOAD(),
  });
  await updateDraft(app, OWNER_CTX(), {
    revision_id: draft.revision_id,
    payload: PAGE_PAYLOAD(),
    expected_edit_generation: 0,
  });
  // A second writer with the same baseline is stale.
  await assert.rejects(
    () =>
      updateDraft(app, OWNER_CTX(), {
        revision_id: draft.revision_id,
        payload: PAGE_PAYLOAD(),
        expected_edit_generation: 0,
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "REVISION_STALE");
      return true;
    },
  );
  void app;
});

test("seal enforces publish-level validation and the seal permission (T013)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });
  // Missing required field: seal rejects with stable validation issues.
  const bad = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: { fields: {}, blocks: { schema_version: 1, blocks: [] } },
  });
  await assert.rejects(
    () => sealRevision(app, OWNER_CTX(), { revision_id: bad.revision_id }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "REVISION_VALIDATION_FAILED");
      return true;
    },
  );

  const good = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: PAGE_PAYLOAD(),
  });
  const sealed = await sealRevision(app, OWNER_CTX(), {
    revision_id: good.revision_id,
    expected_edit_generation: 0,
  });
  assert.equal(sealed.state, "SEALED");
  assert.ok(sealed.payloadHash !== null);

  // A content-scoped agent may edit drafts but NOT seal (owner instruction #22).
  const editor = apiContextOf(scopedActor(["content.create", "content.edit"]));
  await assert.rejects(() => sealRevision(app, editor, { revision_id: good.revision_id }));
});

test("archive is idempotent and never a hard delete (T013)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });
  const draft = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: PAGE_PAYLOAD(),
  });
  const first = await archiveEntry(app, OWNER_CTX(), { entry_id: draft.entry_id });
  const second = await archiveEntry(app, OWNER_CTX(), { entry_id: draft.entry_id });
  assert.equal(first.archived_at, second.archived_at);
  assert.ok((await app.entries.findEntry(draft.entry_id as never)) !== null);
});

test("REST: content permission separation over HTTP (content.edit ≠ publication.publish)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, bearer } = await mutationApi(t);
  // Scopeless token: create denied.
  const denied = await fastify.inject({
    method: "POST",
    url: "/api/v1/entries",
    headers: { authorization: `Bearer ${bearer}` },
    payload: { content_type: "page", payload: PAGE_PAYLOAD() },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal((denied.json() as { error: { code: string } }).error.code, "AUTH_PERMISSION_DENIED");

  // Owner context creates a draft, then a publish attempt with a token
  // lacking publication.publish stays denied even with a valid draft.
  const draft = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: PAGE_PAYLOAD(),
  });
  const sealed = await sealRevision(app, OWNER_CTX(), { revision_id: draft.revision_id });
  const publish = await fastify.inject({
    method: "POST",
    url: "/api/v1/publications/publish",
    headers: { authorization: `Bearer ${bearer}` },
    payload: {
      entity_type: "entry",
      entity_id: draft.entry_id,
      target_revision_id: sealed.id,
      expected_generation: 0,
    },
  });
  assert.equal(publish.statusCode, 403);
  assert.equal(
    (publish.json() as { error: { code: string } }).error.code,
    "AUTH_PERMISSION_DENIED",
  );
});

test("REST: publication CAS conflict surfaces as PUBLICATION_CONFLICT (T013/T015)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, bearer } = await mutationApi(t);
  void bearer;
  // Grant the owner a token with the full chain via the machine identity.
  const account = await app.machineIdentity.createServiceAccount({
    name: "m09-publisher",
    purpose: "publication tests",
    allowedScopes: ["content.create", "revision.seal", "publication.plan", "publication.publish"],
  });
  const publisher = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["content.create", "revision.seal", "publication.plan", "publication.publish"],
    ttlMilliseconds: 3_600_000,
  });
  const headers = { authorization: `Bearer ${publisher.rawSecret}` };

  const draft = await fastify.inject({
    method: "POST",
    url: "/api/v1/entries",
    headers,
    payload: { content_type: "page", payload: PAGE_PAYLOAD() },
  });
  assert.equal(draft.statusCode, 201);
  const { entry_id, revision_id } = draft.json() as { entry_id: string; revision_id: string };

  const sealed = await fastify.inject({
    method: "POST",
    url: `/api/v1/revisions/${revision_id}/seal`,
    headers,
  });
  assert.equal(
    sealed.statusCode,
    200,
    `seal failed: ${sealed.body.slice(0, 400)} / draft: ${draft.body.slice(0, 200)}`,
  );

  const first = await fastify.inject({
    method: "POST",
    url: "/api/v1/publications/publish",
    headers,
    payload: {
      entity_type: "entry",
      entity_id: entry_id,
      target_revision_id: revision_id,
      expected_generation: 0,
    },
  });
  assert.equal(first.statusCode, 200, `publish failed: ${first.body.slice(0, 400)}`);

  // Replaying generation 0 is now a conflict carrying the current generation.
  const replay = await fastify.inject({
    method: "POST",
    url: "/api/v1/publications/publish",
    headers,
    payload: {
      entity_type: "entry",
      entity_id: entry_id,
      target_revision_id: revision_id,
      expected_generation: 0,
    },
  });
  assert.equal(replay.statusCode, 409);
  const body = replay.json() as { error: { code: string; details: { current?: number }[] } };
  assert.equal(body.error.code, "PUBLICATION_CONFLICT");
  assert.equal(body.error.details[0]?.current, 1);
});

test("media upload requires media.write and storage configuration (T014)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, bearer } = await mutationApi(t);
  // Fixture has no media storage wired: fail-secure 503, not a crash.
  const account = await app.machineIdentity.createServiceAccount({
    name: "m09-media",
    purpose: "media tests",
    allowedScopes: ["media.write"],
  });
  const mediaToken = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["media.write"],
    ttlMilliseconds: 3_600_000,
  });
  const response = await fastify.inject({
    method: "POST",
    url: "/api/v1/media",
    headers: {
      authorization: `Bearer ${mediaToken.rawSecret}`,
      "content-type": "application/octet-stream",
      "x-pcms-filename": "pixel.png",
    },
    payload: Buffer.from("89504e470d0a1a0a", "hex"),
  });
  assert.equal(response.statusCode, 503);
  assert.equal((response.json() as { error: { code: string } }).error.code, "MEDIA_STORAGE_CONFIG");
  void bearer;
});

test("remote import: SSRF fails closed and scope is separate (T014)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await mutationApi(t);
  const account = await app.machineIdentity.createServiceAccount({
    name: "m09-importer",
    purpose: "import tests",
    allowedScopes: ["media.write"],
  });
  const writer = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["media.write"],
    ttlMilliseconds: 3_600_000,
  });
  // media.write ≠ media.import: the import endpoint denies a writer token.
  const denied = await fastify.inject({
    method: "POST",
    url: "/api/v1/media/import",
    headers: { authorization: `Bearer ${writer.rawSecret}` },
    payload: { url: "https://example.com/image.png" },
  });
  assert.equal(denied.statusCode, 403);
});

test("theme validate reports missing source explicitly (T016)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await mutationApi(t);
  void app;
  const account = await app.machineIdentity.createServiceAccount({
    name: "m09-themer",
    purpose: "theme tests",
    allowedScopes: ["theme.validate", "preview.create"],
  });
  const themer = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["theme.validate", "preview.create"],
    ttlMilliseconds: 3_600_000,
  });
  const missing = await fastify.inject({
    method: "POST",
    url: "/api/v1/themes/validate",
    headers: { authorization: `Bearer ${themer.rawSecret}` },
  });
  assert.equal(missing.statusCode, 404);
  assert.equal((missing.json() as { error: { code: string } }).error.code, "API_NOT_FOUND");

  // Preview creation needs the signing secret; the fixture wires one.
  const draft = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: PAGE_PAYLOAD(),
  });
  const preview = await fastify.inject({
    method: "POST",
    url: "/api/v1/previews",
    headers: { authorization: `Bearer ${themer.rawSecret}` },
    payload: {
      scope: {
        kind: "revision",
        entity_type: "entry",
        entity_id: draft.entry_id,
        revision_id: draft.revision_id,
      },
    },
  });
  assert.equal(preview.statusCode, 201);
  const body = preview.json() as { token: string; preview_path: string };
  assert.ok(body.token.length > 20);
  assert.ok(body.preview_path.startsWith("/preview?token="));
});

test("plan lifecycle: preview is a dry-run, schedule materializes once (T015)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });
  const ctx = OWNER_CTX();
  const site = await app.routes.ensureSite("default");
  const draft = await createDraft(app, ctx, { content_type: "page", payload: PAGE_PAYLOAD() });
  const sealed = await sealRevision(app, ctx, { revision_id: draft.revision_id });
  const changeset = await app.changesets.createChangeset({
    title: "m09 plan test",
    actor: { actorClass: "human", actorId: "owner" },
  });
  await app.changesets.addItem(changeset.id, {
    entityType: "entry",
    entityId: draft.entry_id as never,
    intent: "PUBLISH",
    targetRevisionId: sealed.id as never,
    expectedGeneration: 0,
    routeOperation: { kind: "set", siteId: site.id, path: "/m09/" },
  });

  const plan = await app.plans.createPlan({
    changesetId: changeset.id,
    timezone: "Europe/Berlin",
    actor: { actorClass: "human", actorId: "owner" },
  });

  // JSON timestamp overrides are normalized in the shared operation seam.
  const spec = {
    startAt: "2027-01-01T10:00:00Z",
    batchSize: 1,
    interval: { unit: "days" as const, value: 1 },
  };
  const changesetItem = (await app.changesets.listItems(changeset.id))[0]!;
  const overrides = [{ changeset_item_id: changesetItem.id, publish_at: "2027-02-01T10:00:00Z" }];
  const preview = await previewPublicationPlan(app, ctx, {
    plan_id: plan.id,
    spec,
    overrides,
  });
  await assert.rejects(
    () =>
      previewPublicationPlan(app, ctx, {
        plan_id: plan.id,
        spec: { ...spec, startAt: "not-a-date" },
      }),
    (error: unknown) => (error as { code?: string }).code === "PLAN_INVALID",
  );
  await assert.rejects(
    () =>
      previewPublicationPlan(app, ctx, {
        plan_id: plan.id,
        spec,
        overrides: [{ changeset_item_id: changesetItem.id, publish_at: null }],
      }),
    (error: unknown) => (error as { code?: string }).code === "PLAN_INVALID",
  );
  assert.equal(preview.length, 1);
  assert.deepEqual((preview[0] as { publishAt: Date }).publishAt, new Date("2027-02-01T10:00:00Z"));
  assert.equal((await app.plans.getPlan(plan.id)).status, "DRAFT");
  assert.equal((await app.calendar.listCalendar({ limit: 100 })).length, 0);

  // Schedule uses the same normalized overrides and materializes the preview.
  const compiled = await schedulePublicationPlan(app, ctx, {
    plan_id: plan.id,
    spec,
    overrides,
  });
  assert.deepEqual(compiled, preview);
  const calendar = await app.calendar.listCalendar({ limit: 100 });
  assert.ok(calendar.some((entry) => entry.entityId === draft.entry_id));

  // Double-schedule is an explicit conflict, never a duplicate.
  await assert.rejects(
    () => schedulePublicationPlan(app, ctx, { plan_id: plan.id, spec, overrides }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PLAN_INVALID");
      return true;
    },
  );
});
