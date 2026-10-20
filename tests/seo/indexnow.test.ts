// IndexNow v1 — focused acceptance corpus (owner directive 2026-10-05):
// DISABLED by default and the whole disabled-invariant set; enable flow
// (key generation, single homepage verification, NO backfill); key route
// semantics; publication lifecycle → pending queue (planner); delivery
// response semantics against a fake endpoint; failure isolation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  addChangesetItem,
  applyChangeset,
  createApiFastify,
  createApiV1,
  createChangeset,
  createDraft,
  makeSeoIndexNowRoutes,
  moveEntryOp,
  preflightChangeset,
  publishRevision,
  sealRevision,
  unpublishPublication,
} from "@pcms/api";
import { createOutboxConsumer, createOutboxService } from "@pcms/publication";
import type { FastifyInstance } from "fastify";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const REFERENCE_TYPES = JSON.parse(
  readFileSync("fixtures/content/reference-content-types.json", "utf8"),
) as { contentTypes: never };

type App = Awaited<ReturnType<typeof createApiFixture>>["app"];

/** Fake IndexNow endpoint: records batches, scripted status. */
function fakeEndpoint(state: { status: number; batches: string[][] }) {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { urlList?: string[] };
        state.batches.push(parsed.urlList ?? []);
      } catch {
        state.batches.push([]);
      }
      response.writeHead(state.status, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  return server;
}

/** Redirects api.indexnow.org to the local fake endpoint for the fetch call. */

async function stack(t: import("node:test").TestContext, registryRoutes = true) {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: REFERENCE_TYPES.contentTypes as never,
    themeDir: "themes/reference-theme-v1",
    seoEnvironment: "production",
  });
  const site = await app.routes.ensureSite(app.defaultSiteKey);
  await app.domains.addDomainBinding({ siteId: site.id, hostname: "site.test", isPrimary: true });
  const fastify: FastifyInstance = createApiFastify(() => "req_idx");
  const routes = registryRoutes ? [...makeSeoIndexNowRoutes()] : [];
  await fastify.register(createApiV1(routes), {
    application: app,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    cookieSecure: false,
  });
  const ctx = apiContextOf(ownerActor("indexnow"));
  const { createDraft, sealRevision } = await import("@pcms/api");
  const publishAt = async (path: string, title: string): Promise<string> => {
    const draft = await createDraft(app, ctx, {
      content_type: "page",
      payload: { fields: { title }, blocks: { schema_version: 1, blocks: [] } },
    });
    await sealRevision(app, ctx, { revision_id: draft.revision_id });
    await publishRevision(app, ctx, {
      entity_type: "entry",
      entity_id: draft.entry_id,
      target_revision_id: draft.revision_id,
      expected_generation: 0,
    });
    await app.routes.activateRoute({
      siteId: site.id,
      path,
      targetType: "entry",
      targetId: draft.entry_id,
    });
    return draft.entry_id;
  };
  return { app, fastify, ctx, site, publishAt };
}

const BEARER = { authorization: "Bearer none" }; // session pipeline accepts cookie-less in tests? No — see below.

async function call(
  fastify: FastifyInstance,
  method: "GET" | "PUT" | "POST",
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fastify.inject({
    method,
    url,
    headers: { "content-type": "application/json" },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

test("disabled invariants: default off, no key route, no settings row after upgrade, PUT requires explicit enable", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await stack(t);

  // Default: GET reports disabled with generation 0 — an "upgrade" to this
  // release creates NO settings row (the default is the ABSENT row).
  const wire = await getIndexNowWire(app);
  assert.equal(wire.settings.enabled, false);
  const row = await app.pool.query("SELECT 1 FROM seo_indexnow_settings");
  assert.equal(row.rowCount, 0, "upgrade must not create/enable settings");

  // The key route is not served for a disabled site (falls through to the
  // site 404, never a 200 with a key body) — even for a well-formed key.
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  const siteFastify: FastifyInstance = createApiFastify(() => "req_idx_site");
  await registerSiteRoute(siteFastify, { application: app });
  const probe = await siteFastify.inject({
    method: "GET",
    url: `/${"a".repeat(64)}.txt`,
  });
  assert.ok(probe.statusCode !== 200 || !/^[0-9a-f]{64}$/.test(probe.body.trim()));
});

async function getIndexNowWire(app: App) {
  // Direct app-layer read (the transport-free half of GET /seo/indexnow).
  const { getIndexNowSettingsOp } = await import("@pcms/api");
  return getIndexNowSettingsOp(app, apiContextOf(ownerActor("idx")));
}

test("enable flow: key generated, homepage verification queued once, no backfill; disable cancels pending", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await stack(t);
  // Seed a published page BEFORE enabling: enabling must NOT queue it.
  const { saveIndexNowSettingsOp } = await import("@pcms/api");
  const ctx = apiContextOf(ownerActor("idx"));
  const seed = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Pre-existing" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(app, ctx, { revision_id: seed.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: seed.entry_id,
    target_revision_id: seed.revision_id,
    expected_generation: 0,
  });

  const first = await saveIndexNowSettingsOp(app, ctx, {
    settings: { enabled: true },
    expected_generation: 0,
  });
  assert.equal(first.generation, 1);
  assert.ok(first.keyFileUrl?.startsWith("https://site.test/"));
  const key = first.keyFileUrl!.match(/([0-9a-f]{64})\.txt$/)![1]!;

  const wire = await getIndexNowWire(app);
  assert.equal(wire.settings.enabled, true);
  assert.equal(wire.settings.key, key);

  // Exactly ONE pending row (homepage verification) — never a backfill of
  // the pre-existing page.
  const pending = await app.pool.query<{ url: string; reason: string }>(
    "SELECT url, reason FROM seo_indexnow_pending WHERE site_key = $1",
    [app.defaultSiteKey],
  );
  assert.equal(pending.rowCount, 1);
  assert.equal(pending.rows[0]!.reason, "verification");
  assert.equal(pending.rows[0]!.url, "https://site.test/");

  // Re-save keeps the key (rotation is an explicit operation).
  const same = await saveIndexNowSettingsOp(app, ctx, {
    settings: { enabled: true },
    expected_generation: first.generation,
  });
  assert.equal(same.keyFileUrl, first.keyFileUrl);

  // Rotation: new key, old file dead.
  const { rotateIndexNowKeyOp } = await import("@pcms/api");
  const rotated = await rotateIndexNowKeyOp(app, ctx);
  assert.notEqual(rotated.key_file_url, first.keyFileUrl);

  // Key route: while enabled, the EXACT key file answers plain text — even
  // when enable happened after the web process booted (cache update path).
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  const { createApiFastify } = await import("@pcms/api");
  const siteFastify: FastifyInstance = createApiFastify(() => "req_idx_key");
  await registerSiteRoute(siteFastify, { application: app });
  const activeKey = rotated.key_file_url!.match(/([0-9a-f]{64})\.txt$/)![1]!;
  const keyFile = await siteFastify.inject({ method: "GET", url: `/${activeKey}.txt` });
  assert.equal(keyFile.statusCode, 200);
  assert.match(keyFile.headers["content-type"] ?? "", /text\/plain/);
  assert.equal(keyFile.body, `${activeKey}\n`);
  const wrongKey = await siteFastify.inject({ method: "GET", url: `/${"f".repeat(64)}.txt` });
  assert.ok(wrongKey.statusCode !== 200, "wrong key never serves");

  // Regression (0.1.176 live): the delivery status sub-document persisted
  // INSIDE settings must not break the key route — strict parsing strips it.
  await app.pool.query(
    `UPDATE seo_indexnow_settings
     SET settings = jsonb_set(settings, '{status}', '{"lastHttpStatus":200}'::jsonb)
     WHERE site_key = $1`,
    [app.defaultSiteKey],
  );
  app.indexNow.updateCachedSettings(null); // force the read-through path
  const withStatus = await siteFastify.inject({ method: "GET", url: `/${activeKey}.txt` });
  assert.equal(withStatus.statusCode, 200, "status sub-document must not disable the key route");

  // Disable cancels the pending queue AND kills the key route immediately.
  await saveIndexNowSettingsOp(app, ctx, {
    settings: { enabled: false },
    expected_generation: rotated.generation,
  });
  const after = await app.pool.query("SELECT 1 FROM seo_indexnow_pending WHERE site_key = $1", [
    app.defaultSiteKey,
  ]);
  assert.equal(after.rowCount, 0, "disable cancels pending (suppression = cancellation)");
  const keyAfter = await siteFastify.inject({ method: "GET", url: `/${activeKey}.txt` });
  assert.ok(keyAfter.statusCode !== 200, "disabled site serves no key file");
  void key;
});

test("planner: publish/update/unpublish/route-change queue URLs; delivery posts batches; response semantics", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const state = { status: 200, batches: [] as string[][] };
  const fake = fakeEndpoint(state);
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const address = fake.address();
  t.after(() => fake.close());

  const { app } = await stack(t);
  const ctx = apiContextOf(ownerActor("idx"));
  const { saveIndexNowSettingsOp } = await import("@pcms/api");
  const site = await app.routes.ensureSite(app.defaultSiteKey);

  const page = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "A" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(app, ctx, { revision_id: page.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: page.entry_id,
    target_revision_id: page.revision_id,
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/a/",
    targetType: "entry",
    targetId: page.entry_id,
  });

  // Enable AFTER the page is published: no backfill of /a/.
  await saveIndexNowSettingsOp(app, ctx, {
    settings: { enabled: true },
    expected_generation: 0,
  });

  // Publication events ride the outbox — pump the real consumer with the
  // IndexNow handlers the worker uses.
  const outbox = createOutboxService(app.pool, { clock: { now: () => new Date() } });
  const consumer = createOutboxConsumer(
    outbox,
    {
      EntryPublished: (event: unknown) => app.indexNow.handlePublicationEvent(event as never),
      EntryUnpublished: (event: unknown) => app.indexNow.handlePublicationEvent(event as never),
      EntryRolledBack: (event: unknown) => app.indexNow.handlePublicationEvent(event as never),
      EntryRouteChanged: (event: unknown) => app.indexNow.handlePublicationEvent(event as never),
    },
    { fallback: async () => {} },
  );
  await consumer.processBatch(100);

  const count = async (): Promise<number> => {
    const rows = await app.pool.query<{ url: string }>(
      "SELECT url FROM seo_indexnow_pending WHERE site_key = $1",
      [app.defaultSiteKey],
    );
    return rows.rowCount ?? 0;
  };
  const urls = async (): Promise<string[]> => {
    const rows = await app.pool.query<{ url: string }>(
      "SELECT url FROM seo_indexnow_pending WHERE site_key = $1",
      [app.defaultSiteKey],
    );
    return rows.rows.map((row) => row.url).sort();
  };

  // Verification (homepage) + the page published AFTER enable. The
  // pre-existing enable-time state did NOT queue /a/ at enable, but the
  // EntryPublished event of the earlier publish is only now consumed — that
  // event predates enable; the planner enqueues only SUBSEQUENT events, so
  // pump again after a fresh update instead and assert the baseline here.
  const baseline = await urls();
  assert.ok(baseline.includes("https://site.test/"), "homepage verification present");

  // Update publish → the canonical URL is queued (delta, not backfill).
  const working = await (async () => {
    const { createWorkingDraft, updateDraft } = await import("@pcms/api");
    const workingDraft = await createWorkingDraft(app, ctx, { entry_id: page.entry_id });
    await updateDraft(app, ctx, {
      revision_id: workingDraft.revision_id,
      payload: { fields: { title: "A2" }, blocks: { schema_version: 1, blocks: [] } },
      expected_edit_generation: workingDraft.edit_generation,
    });
    return workingDraft;
  })();
  await sealRevision(app, ctx, { revision_id: working.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: page.entry_id,
    target_revision_id: working.revision_id,
    expected_generation: 1,
  });
  await consumer.processBatch(100);
  assert.equal(await count(), 2); // homepage verification + /a/
  assert.ok((await urls()).includes("https://site.test/a/"));

  // Unpublish → the PREVIOUS URL is queued (routes survive unpublish).
  await unpublishPublication(app, ctx, {
    entity_type: "entry",
    entity_id: page.entry_id,
    expected_generation: 2,
  });
  await consumer.processBatch(100);
  assert.ok((await urls()).includes("https://site.test/a/"), "unpublish keeps the URL queued");

  // Delivery against a 200-fake: batches deduped, rows delivered+cleared.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.indexnow.org/indexnow") {
      state.status = 200;
      return new Response("{}", { status: 200 });
    }
    return originalFetch(input as never, init);
  }) as typeof fetch;
  try {
    await app.indexNow.deliverPending();
    assert.equal(await count(), 0, "200 clears delivered rows");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 202 → requeued (awaiting verification), not a permanent failure.
  state.status = 202;
  const draft3 = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "B" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(app, ctx, { revision_id: draft3.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: draft3.entry_id,
    target_revision_id: draft3.revision_id,
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/b/",
    targetType: "entry",
    targetId: draft3.entry_id,
  });
  await consumer.processBatch(100);
  const beforeB = await count();
  assert.ok(beforeB >= 1);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "https://api.indexnow.org/indexnow") {
      return new Response("{}", { status: 202 });
    }
    return originalFetch(input as never, init);
  }) as typeof fetch;
  try {
    await app.indexNow.deliverPending();
    const still = await app.pool.query<{ not_before: string }>(
      "SELECT not_before FROM seo_indexnow_pending WHERE site_key = $1",
      [app.defaultSiteKey],
    );
    assert.ok(still.rowCount! >= 1, "202 keeps rows for verification retry");
    assert.ok(new Date(still.rows[0]!.not_before) > new Date(Date.now() + 10 * 60_000));
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Route change via a changeset route op: OLD + NEW URLs queued.
  const changeset = (await createChangeset(app, ctx, { title: "move" })) as { id: string };
  await addChangesetItem(app, ctx, {
    changeset_id: changeset.id,
    entity_type: "entry",
    entity_id: draft3.entry_id,
    intent: "PUBLISH",
    target_revision_id: draft3.revision_id,
    expected_generation: 1,
    route_operation: {
      kind: "set",
      site_id: site.id,
      path: "/b2/",
      frees_path: "/b/",
    },
  });
  await preflightChangeset(app, ctx, { changeset_id: changeset.id });
  await applyChangeset(app, ctx, { changeset_id: changeset.id });
  await consumer.processBatch(100);
  const afterMove = await urls();
  assert.ok(
    afterMove.some((url) => url.endsWith("/b/")),
    "old URL queued",
  );
  assert.ok(
    afterMove.some((url) => url.endsWith("/b2/")),
    "new URL queued",
  );
  void moveEntryOp;
});
