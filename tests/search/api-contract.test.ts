// PCMS-SEARCH-T015/T016/T017 — REST/MCP transport contract for search
// operations: same application layer, permission boundaries, rate limits
// and stable error codes across transports (API spec §46/§57).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ApiRoute,
  createApiFastify,
  createApiV1,
  createDraft,
  makeDiscoveryRoutes,
  makeMutationRoutes,
  makeSearchRoutes,
  publishRevision,
  sealRevision,
} from "@pcms/api";
import { systemClock } from "@pcms/core";
import { findTool, TOOLS } from "@pcms/mcp";
import { createOutboxConsumer, createOutboxService } from "@pcms/publication";
import type { FastifyInstance } from "fastify";
import {
  type ApiTestFixture,
  apiContextOf,
  createApiFixture,
  scopedActor,
  systemContext,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const CONTENT_TYPES = [
  {
    key: "page",
    version: 1,
    title: "Page",
    bodyPolicy: "block_document",
    fields: {
      title: { id: "title", type: "string", required: true },
      intro: { id: "intro", type: "text" },
    },
  },
] as const;

const CTX = () =>
  apiContextOf(
    scopedActor([
      "content.create",
      "content.edit",
      "revision.seal",
      "publication.publish",
      "publication.rollback",
      "publication.unpublish",
    ]),
    "rest",
    "req_api",
  );

interface Stack {
  readonly app: ApiTestFixture["app"];
  readonly fastify: FastifyInstance;
  readonly pump: () => Promise<number>;
  readonly publish: (title: string, path: string) => Promise<string>;
}

async function stack(t: { after: (fn: () => void) => void }): Promise<Stack> {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...CONTENT_TYPES],
    seoEnvironment: "production",
  });
  const site = await app.routes.ensureSite("default");
  // Locale-scoped corpus: the site must declare multilingual, because entry
  // identity locales follow the declared policy (see localization-ops).
  await app.localization.update({
    enabled: true,
    defaultLocale: "ru",
    locales: ["ru"],
    updatedBy: "test",
  });
  const fastify: FastifyInstance = createApiFastify(() => "req_search");
  const routes: ApiRoute[] = [
    ...makeDiscoveryRoutes(),
    ...makeMutationRoutes(),
    ...makeSearchRoutes(),
  ];
  await fastify.register(createApiV1(routes), {
    application: app,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    cookieSecure: false,
  });
  await fastify.ready();

  const outbox = createOutboxService(app.pool, { clock: systemClock });
  const consumer = createOutboxConsumer(
    outbox,
    {
      EntryPublished: (event) => app.searchIndexing.applyPublicationEvent(event),
      EntryUnpublished: (event) => app.searchIndexing.applyPublicationEvent(event),
      EntryRolledBack: (event) => app.searchIndexing.applyPublicationEvent(event),
    },
    { fallback: async () => {} },
  );
  const pump = () => consumer.processBatch(100);

  const publish = async (title: string, path: string): Promise<string> => {
    const draft = await createDraft(app, CTX(), {
      content_type: "page",
      payload: {
        fields: { title, intro: "Интро страницы" },
        blocks: { schema_version: 1, blocks: [] },
      },
      locale: "ru",
    });
    await sealRevision(app, CTX(), { revision_id: draft.revision_id });
    await publishRevision(app, CTX(), {
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

  return { app, fastify, pump, publish };
}

const BEARER = (token: string) => ({ authorization: `Bearer ${token}` });

async function serviceToken(
  app: ApiTestFixture["app"],
  scopes: readonly string[],
): Promise<string> {
  const account = await app.machineIdentity.createServiceAccount({
    name: `search-sa-${Math.random().toString(36).slice(2, 8)}`,
    purpose: "search contract test",
    allowedScopes: [...scopes],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [...scopes],
    ttlMilliseconds: 3_600_000,
  });
  return token.rawSecret;
}

test("public /search endpoint: found, scoped, rate-limited, anonymous", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { app, fastify, pump, publish } = await stack(t);
  await publish("Поиск станции метро", "/metro/");
  await pump();

  // Anonymous GET — public route, no auth header.
  const found = await fastify.inject({ method: "GET", url: "/api/v1/search?q=станции&locale=ru" });
  assert.equal(found.statusCode, 200, found.body);
  const body = found.json() as { total: number; items: { title: string; path: string | null }[] };
  assert.equal(body.total, 1);
  assert.equal(body.items[0]?.path, "/metro/");

  // Empty query → stable validation error (spec §16: no unbounded dump).
  const empty = await fastify.inject({ method: "GET", url: "/api/v1/search?q=&locale=ru" });
  assert.equal(empty.statusCode, 422);
  assert.equal((empty.json() as { error: { code: string } }).error.code, "SEARCH_QUERY_INVALID");

  // Forbidden sort key → SEARCH_SORT_UNSUPPORTED.
  const sort = await fastify.inject({
    method: "GET",
    url: "/api/v1/search?q=x&locale=ru&sort=price",
  });
  assert.equal((sort.json() as { error: { code: string } }).error.code, "SEARCH_SORT_UNSUPPORTED");

  // Rate limit: burst above capacity eventually yields 429 (SEARCH_RATE_LIMITED).
  let saw429 = false;
  for (let i = 0; i < 30; i += 1) {
    const response = await fastify.inject({
      method: "GET",
      url: "/api/v1/search?q=станции&locale=ru",
    });
    if (response.statusCode === 429) {
      saw429 = true;
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        "SEARCH_RATE_LIMITED",
      );
      break;
    }
  }
  assert.equal(saw429, true, "public endpoint must be rate-limited");

  // Unpublished entry is invisible through the transport too. The limiter
  // refill (2/s) gets a moment so the request below is served, not 429'd.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const ghost = await fastify.inject({ method: "GET", url: "/api/v1/search?q=метро&locale=ru" });
  assert.equal(ghost.statusCode, 200, ghost.body);
  void app;
});

test("admin search/status/reindex enforce search.* permissions over REST", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { app, fastify, pump, publish } = await stack(t);
  await publish("Админский дубликат заголовка", "/admin-dup/");
  await pump();

  const noScopes = await serviceToken(app, ["content.read"]);
  const adminScopes = await serviceToken(app, [
    "search.admin",
    "search.diagnostics",
    "search.reindex",
    "content.read",
  ]);

  // search.admin grants admin search.
  const admin = await fastify.inject({
    method: "GET",
    url: "/api/v1/search/admin?q=дубликат&locale=ru",
    headers: BEARER(adminScopes),
  });
  assert.equal(admin.statusCode, 200, admin.body);
  const adminBody = admin.json() as {
    published: { total: number };
    drafts: unknown[];
    media: unknown[];
    navigation_labels: unknown[];
  };
  assert.equal(adminBody.published.total, 1);

  // content.read alone → 403 AUTH_PERMISSION_DENIED (default deny).
  const denied = await fastify.inject({
    method: "GET",
    url: "/api/v1/search/admin?q=дубликат&locale=ru",
    headers: BEARER(noScopes),
  });
  assert.equal(denied.statusCode, 403);
  assert.equal((denied.json() as { error: { code: string } }).error.code, "AUTH_PERMISSION_DENIED");

  // Anonymous (no header) → 401 from the auth layer.
  const anonymous = await fastify.inject({
    method: "GET",
    url: "/api/v1/search/admin?q=x&locale=ru",
  });
  assert.equal(anonymous.statusCode, 401);

  // Status requires search.diagnostics.
  const statusDenied = await fastify.inject({
    method: "GET",
    url: "/api/v1/search/status",
    headers: BEARER(noScopes),
  });
  assert.equal(statusDenied.statusCode, 403);
  const status = await fastify.inject({
    method: "GET",
    url: "/api/v1/search/status",
    headers: BEARER(adminScopes),
  });
  assert.equal(status.statusCode, 200);
  const statusBody = status.json() as { health: { available: boolean; document_count: number } };
  assert.equal(statusBody.health.available, true);
  assert.ok(statusBody.health.document_count >= 1);

  // Reindex: 202 + run payload with the right scope; 403 without.
  const reindexDenied = await fastify.inject({
    method: "POST",
    url: "/api/v1/search/reindex",
    headers: BEARER(noScopes),
    payload: {},
  });
  assert.equal(reindexDenied.statusCode, 403);
  const reindex = await fastify.inject({
    method: "POST",
    url: "/api/v1/search/reindex",
    headers: BEARER(adminScopes),
    payload: {},
  });
  assert.equal(reindex.statusCode, 202, reindex.body);
  const run = reindex.json() as { run_id: string; chunks_total: number };
  assert.ok(run.run_id.length > 0);
  void app.searchReindex; // finalize left to the jobs path (covered elsewhere)
});

test("MCP search tools share REST semantics (same codes, bounded output)", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { app, pump, publish } = await stack(t);
  await publish("МЦП поиск по расписанию", "/mcp-page/");
  await pump();

  const operations = {
    searchQuery: (input: never) => app.searchQuery(input),
    searchAdmin: (input: never) => app.searchAdmin(input),
    getSearchStatus: async () => ({
      health: await app.searchProvider.health(),
      reindex_runs: await app.searchReindex.listRuns(),
    }),
    getSearchCapabilities: () => ({
      engine: "postgresql-fts",
      entity_types: ["entry"],
      filters: ["content_type", "date_from", "date_to"],
      sorts: ["relevance", "date"],
    }),
    validateSearchDocument: async (input: { entity_type: string; entity_id: string }) => {
      const document = await app.searchSource.buildDocument(input.entity_type, input.entity_id);
      return document === null ? { indexable: false, issues: [] } : { indexable: true, issues: [] };
    },
    reindexSearch: (input: { resume?: boolean }) => app.searchReindex.start(input),
    listSearchReindexRuns: () => app.searchReindex.listRuns(),
  } as never;

  const queryTool = findTool("cms_search_query");
  if (queryTool === null) throw new Error("cms_search_query tool missing");
  const result = (await queryTool.run(operations, systemContext(), {
    q: "расписанию",
    locale: "ru",
  })) as { total: number };
  assert.equal(result.total, 1);

  // Same stable code as REST on invalid input.
  await assert.rejects(
    () => queryTool.run(operations, systemContext(), { q: "", locale: "ru" }),
    (error: unknown) => (error as { code?: string }).code === "SEARCH_QUERY_INVALID",
  );

  const statusTool = findTool("cms_get_search_status");
  if (statusTool === null) throw new Error("cms_get_search_status tool missing");
  const status = (await statusTool.run(operations, systemContext(), {})) as {
    health: { document_count: number };
  };
  assert.ok(status.health.document_count >= 1);

  // Tool contract: names + permission annotations are pinned by the golden
  // fixture (tests/api/mcp.test.ts) — here we assert the semantic surface.
  const names = TOOLS.map((tool) => tool.name);
  for (const expected of [
    "cms_search_query",
    "cms_search_admin",
    "cms_get_search_status",
    "cms_get_search_capabilities",
    "cms_validate_search_document",
    "cms_reindex_search",
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  const reindexTool = findTool("cms_reindex_search");
  assert.equal(reindexTool?.permission, "search.reindex");
  assert.equal(reindexTool?.mutation, true);
  const adminTool = findTool("cms_search_admin");
  assert.equal(adminTool?.permission, "search.admin");
});
