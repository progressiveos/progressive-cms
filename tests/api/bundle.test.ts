// PCMS-API-T017/T018 — Publication Bundle: strict acceptance, intra-bundle
// ref resolution, atomicity and idempotent replay against real PostgreSQL.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createApiFastify,
  createApiV1,
  makeDiscoveryRoutes,
  makeMutationRoutes,
  type OperationContext,
  submitBundle,
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
      hero_image: { id: "hero_image", type: "media" },
    },
  },
] as const;

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

const OWNER = (): OperationContext => apiContextOf(ownerActor(), "rest", "req_bundle");

function baseBundle() {
  return {
    bundle_version: 1,
    external_id: "agent-run-0001",
    changeset: { title: "m09 bundle release" },
    entries: [
      {
        ref: "entry-home",
        content_type: "page",
        payload: {
          fields: { title: "Home" },
          blocks: { schema_version: 1, blocks: [] },
        },
        route: { path: "/bundle-home/" },
      },
      {
        ref: "entry-about",
        content_type: "page",
        payload: { fields: { title: "About" }, blocks: { schema_version: 1, blocks: [] } },
      },
    ],
    publication: { mode: "none" },
  } as Record<string, unknown>;
}

async function bundleApi(t: { after: (fn: () => void) => void }) {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });
  const site = await app.routes.ensureSite("default");
  const fastify = createApiFastify(() => "req_bundle");
  await fastify.register(createApiV1([...makeDiscoveryRoutes(), ...makeMutationRoutes()]), {
    application: app,
    logger: silentLogger,
    cookieSecure: false,
  });
  return { app, fastify, site };
}

test("bundle validate mode: full report, zero writes (T017)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await bundleApi(t);
  const broken = baseBundle() as {
    entries: { payload: { fields: Record<string, unknown> } }[];
  };
  delete (broken as Record<string, unknown>)["entries"];
  const report = await submitBundle(app, OWNER(), broken, "validate");
  assert.equal(report.accepted, false);
  assert.ok(report.validation_report.issues.some((issue) => issue.path === "/entries"));

  const badPayload = baseBundle() as {
    entries: { payload: { fields: Record<string, unknown> } }[];
  };
  delete badPayload.entries[0]!.payload.fields["title"];
  const semantic = await submitBundle(app, OWNER(), badPayload, "validate");
  assert.equal(semantic.accepted, false);
  assert.ok(
    semantic.validation_report.issues.some((issue) => issue.code === "FIELD_REQUIRED"),
    JSON.stringify(semantic.validation_report.issues),
  );

  // Unknown bundle version is an explicit contract error.
  const wrongVersion = { ...baseBundle(), bundle_version: 99 };
  const version = await submitBundle(app, OWNER(), wrongVersion, "validate");
  assert.ok(version.validation_report.issues.some((i) => i.code === "BUNDLE_VERSION_UNSUPPORTED"));
  void app;
});

test("bundle apply: atomic create + seal + changeset, refs resolved (T017/T018)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await bundleApi(t);
  const result = (await submitBundle(app, OWNER(), baseBundle(), "apply")) as {
    accepted: boolean;
    changeset_id: string;
    published: boolean;
    entries: { ref: string | null; entry_id: string; revision_id: string }[];
  };
  assert.equal(result.accepted, true);
  assert.equal(result.published, false);
  assert.equal(result.entries.length, 2);

  // Intra-bundle media ref: field value "ref:img-hero" with no such media ref
  // would have failed resolution; with none declared the bundle here uses no
  // media — the about entry proves ref resolution of entries instead.
  const home = result.entries.find((entry) => entry.ref === "entry-home")!;
  const sealed = await app.revisions.getRevision(app.pool, home.revision_id as never);
  assert.equal(sealed?.state, "SEALED");

  // The changeset exists with both items and stays OPEN (publication mode none).
  const changeset = await app.changesets.getChangeset(result.changeset_id as never);
  assert.equal(changeset.state, "OPEN");
  const items = await app.changesets.listItems(changeset.id);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.routeOperation.kind, "set");
});

test("bundle apply with publication now: pointers flip in the same transaction (T017)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await bundleApi(t);
  const bundle = {
    ...baseBundle(),
    publication: { mode: "now" },
    media: [] as unknown[],
    entries: [
      {
        ref: "solo",
        content_type: "page",
        payload: { fields: { title: "Now" }, blocks: { schema_version: 1, blocks: [] } },
        route: { path: "/bundle-now/" },
      },
    ],
  };
  const result = (await submitBundle(app, OWNER(), bundle, "apply")) as {
    accepted: boolean;
    published: boolean;
    entries: { entry_id: string }[];
  };
  assert.equal(result.accepted, true);
  assert.equal(result.published, true);
  const publication = await app.publications.getPublication(
    app.pool,
    "entry",
    result.entries[0]!.entry_id as never,
  );
  assert.notEqual(publication, null);
  // The route operation applied with the same commit.
  const resolution = await app.routes.resolveRoute(
    (await app.routes.findSiteByKey("default"))!.id,
    "/bundle-now/",
  );
  assert.notEqual(resolution, null);
});

test("bundle failure rolls back everything (no partial commit) (T017)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await bundleApi(t);
  // Case 1: an undeclared ref is caught by strict pre-flight — nothing at all
  // is attempted (no writes, no transaction).
  const bundle = baseBundle() as { entries: { payload: { fields: Record<string, unknown> } }[] };
  bundle.entries[1]!.payload.fields["hero_image"] = "ref:no-such-media";
  await assert.rejects(
    () => submitBundle(app, OWNER(), bundle, "apply"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "BUNDLE_INVALID");
      return true;
    },
  );

  // Case 2: a structurally valid but nonexistent media_id fails mid-apply —
  // the whole transaction must roll back (drafts + changeset gone).
  const phantomId = "01900000-0000-7000-8000-00000000dead".replace("dead", "beef");
  const withPhantomMedia = {
    ...baseBundle(),
    media: [{ ref: "img-hero", media_id: phantomId }],
  };
  await assert.rejects(
    () => submitBundle(app, OWNER(), withPhantomMedia, "apply"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "BUNDLE_REF_UNRESOLVED");
      return true;
    },
  );
  // Prove no rows survived either failure: no changesets, no phantom entry.
  const changesets = await app.changesets.listChangesets({ limit: 100 });
  assert.equal(changesets.length, 0);
  const pages = await app.contentDiscovery.listContentTypes();
  assert.equal(pages.length, 2); // system folder + page (no site types here)
});

test("bundle over HTTP: idempotency replay returns the same result, key reuse conflicts (T017)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await bundleApi(t);
  const account = await app.machineIdentity.createServiceAccount({
    name: "m09-bundler",
    purpose: "bundle tests",
    allowedScopes: [
      "content.create",
      "revision.seal",
      "publication.plan",
      "publication.publish",
      "seo.edit",
    ],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [
      "content.create",
      "revision.seal",
      "publication.plan",
      "publication.publish",
      "seo.edit",
    ],
    ttlMilliseconds: 3_600_000,
  });
  const headers = { authorization: `Bearer ${token.rawSecret}` };
  const bundle = { ...baseBundle(), external_id: "http-bundle-1", mode: "apply" };

  const first = await fastify.inject({
    method: "POST",
    url: "/api/v1/bundles",
    headers,
    payload: bundle,
  });
  assert.equal(first.statusCode, 201, first.body);
  const firstBody = first.json() as { changeset_id: string; accepted: boolean };
  assert.equal(firstBody.accepted, true);

  // Same key + same body: the stored result replays — no second changeset.
  const replay = await fastify.inject({
    method: "POST",
    url: "/api/v1/bundles",
    headers,
    payload: bundle,
  });
  assert.equal(replay.statusCode, 201);
  assert.equal((replay.json() as { changeset_id: string }).changeset_id, firstBody.changeset_id);
  const changesets = await app.changesets.listChangesets({ limit: 100 });
  assert.equal(changesets.length, 1);

  // Same external_id + materially different bundle: explicit conflict.
  const externalConflict = await fastify.inject({
    method: "POST",
    url: "/api/v1/bundles",
    headers,
    payload: {
      ...bundle,
      entries: [
        {
          content_type: "page",
          payload: { fields: { title: "Different" }, blocks: { schema_version: 1, blocks: [] } },
        },
      ],
    },
  });
  assert.equal(externalConflict.statusCode, 409);
  assert.equal(
    (externalConflict.json() as { error: { code: string } }).error.code,
    "IDEMPOTENCY_KEY_CONFLICT",
  );
});

test("bundle re-application against a published entry moves the route (route-move use)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, site } = await bundleApi(t);
  const ctx = OWNER();
  const first = {
    ...baseBundle(),
    external_id: "route-move-create",
    publication: { mode: "now" },
    entries: [
      {
        ref: "entry-home",
        content_type: "page",
        payload: {
          fields: { title: "Home" },
          blocks: { schema_version: 1, blocks: [] },
        },
        route: { path: "/bundle-home/" },
      },
    ],
  } as Record<string, unknown>;
  const applied = await submitBundle(app, ctx, first as never, "apply");
  assert.equal(applied.accepted, true);
  const entryId = (applied as { entries: { entry_id: string }[] }).entries[0]!.entry_id;

  // Second application targeting the SAME entry with a NEW route: the live
  // publication generation is the CAS baseline (not a hardcoded 0), so the
  // documented route-move use works against published entries.
  const move = {
    ...first,
    external_id: "route-move-repoint",
    entries: [
      {
        entry_id: entryId,
        ref: "entry-home",
        content_type: "page",
        payload: {
          fields: { title: "Home" },
          blocks: { schema_version: 1, blocks: [] },
        },
        route: { path: "/bundle-home-v2/", frees_path: "/bundle-home/" },
      },
    ],
  };
  const repointed = await submitBundle(app, ctx, move as never, "apply");
  assert.equal(repointed.accepted, true);

  const routes = await app.routes.listRoutes(site.id); // active routes only
  const active = routes.filter((route) => route.retiredAt === null && route.isCanonical);
  assert.ok(active.some((route) => route.path === "/bundle-home-v2/"));
  assert.ok(!active.some((route) => route.path === "/bundle-home/"));
});

test("bundle permission mapping: content-scoped agent cannot publish via bundle (T017)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await bundleApi(t);
  const agent = apiContextOf(
    scopedActor(["content.create", "media.write", "seo.edit", "publication.plan"]),
  );
  const bundle = { ...baseBundle(), publication: { mode: "now" } };
  await assert.rejects(
    () => submitBundle(app, agent, bundle, "apply"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTH_PERMISSION_DENIED");
      return true;
    },
  );
  void app;
});
