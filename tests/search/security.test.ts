// PCMS-SEARCH-T019 — security corpus (owner instructions: mandatory list).
// Every probe must end in a stable error, an empty result, or escaped
// output — never a 500, an injection, or a cross-scope leak.
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
import { createOutboxConsumer, createOutboxService } from "@pcms/publication";
import type { FastifyInstance } from "fastify";
import { registerSearchPageRoute } from "../../apps/web/src/search-page.js";
import { apiContextOf, createApiFixture, scopedActor } from "../helpers/api-composition.js";
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
      secret_note: { id: "secret_note", type: "text" },
    },
  },
] as const;

const CTX = () =>
  apiContextOf(
    scopedActor(["content.create", "revision.seal", "publication.publish"]),
    "rest",
    "req_sec",
  );

async function securedStack(t: { after: (fn: () => void) => void }) {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...CONTENT_TYPES],
    seoEnvironment: "production",
  });
  const site = await app.routes.ensureSite("default");
  // The corpus below is locale-scoped, so the site must declare multilingual
  // (identity locales follow the declared policy — single-locale sites accept
  // the "default" sentinel only).
  await app.localization.update({
    enabled: true,
    defaultLocale: "ru",
    locales: ["ru"],
    updatedBy: "test",
  });
  const fastify: FastifyInstance = createApiFastify(() => "req_sec");
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
  registerSearchPageRoute(fastify, { application: app });
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

  // A published entry whose fields carry injection/XSS payloads plus an
  // unhinted private field that must never reach the corpus.
  const draft = await createDraft(app, CTX(), {
    content_type: "page",
    payload: {
      fields: {
        title: "Акции <script>alert(1)</script> & ко",
        intro: "'); DROP INDEX search_documents_vector_idx;--",
        secret_note: "СЕКРЕТНАЯ_ЗАМЕТКА внутреннее поле без hints",
      },
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
    path: "/xss/",
    targetType: "entry",
    targetId: draft.entry_id,
  });
  await consumer.processBatch(100);
  return { app, fastify };
}

const INJECTION_PROBES = [
  "'); DROP INDEX search_documents_vector_idx;--",
  "x' OR '1'='1",
  "название') || (SELECT 1) --",
  "a'::regproc;--",
  "%'; DROP TABLE publications;--",
  "\u0001engineered\u0002markers\u0000",
];

test("security corpus: injection-shaped queries never corrupt state or 500", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { app, fastify } = await securedStack(t);
  for (const probe of INJECTION_PROBES) {
    const response = await fastify.inject({
      method: "GET",
      url: `/api/v1/search?q=${encodeURIComponent(probe)}&locale=ru`,
    });
    assert.ok([200, 422].includes(response.statusCode), `${probe} → ${response.statusCode}`);
    const body = response.json() as { total?: number; error?: { code?: string } };
    if (response.statusCode === 200) {
      // The corpus deliberately plants one probe string as content — it may
      // match as inert TEXT (proving injection is impossible), never more.
      assert.ok(body.total !== undefined && body.total <= 1);
    } else {
      assert.match(body.error?.code ?? "", /^SEARCH_/);
    }
  }
  // Index and publications tables intact after every probe.
  const health = await app.searchProvider.health();
  assert.equal(health.document_count, 1);
  const publications = await app.pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM publications",
  );
  assert.equal(Number(publications.rows[0]?.count), 1);
});

test("security corpus: oversized and abusive requests are bounded", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { fastify } = await securedStack(t);
  // Oversized query → 422 (validated before the provider).
  const huge = await fastify.inject({
    method: "GET",
    url: `/api/v1/search?q=${encodeURIComponent("a".repeat(5000))}&locale=ru`,
  });
  // Schema-level maxLength (400) and the application limit (422) both bound.
  assert.ok([400, 422].includes(huge.statusCode));

  // Pathological wildcard/prefix: websearch syntax is inert; huge OR-chains
  // are length-capped. Must answer, not hang.
  const wild = await fastify.inject({
    method: "GET",
    url: `/api/v1/search?q=${encodeURIComponent("a OR b OR c OR " + "d ".repeat(200))}&locale=ru`,
  });
  assert.ok([200, 400, 422].includes(wild.statusCode), String(wild.statusCode));

  // Forbidden filter/sort keys are rejected by the schema (400/422), never
  // forwarded anywhere.
  const evilSort = await fastify.inject({
    method: "GET",
    url: `/api/v1/search?q=x&locale=ru&sort=(select+1)`,
  });
  assert.equal(evilSort.statusCode, 422);
  const evilFilter = await fastify.inject({
    method: "GET",
    url: `/api/v1/search?q=x&locale=ru&site_id=../etc&extra_key=1`,
  });
  assert.ok([400, 422].includes(evilFilter.statusCode));

  // Unbounded page requests: a malformed cursor and a beyond-window offset
  // both refuse with distinct stable codes.
  const badCursor = Buffer.from("off:abc", "utf8").toString("base64url");
  const malformed = await fastify.inject({
    method: "GET",
    url: `/api/v1/search?q=x&locale=ru&cursor=${badCursor}&limit=50`,
  });
  assert.equal(malformed.statusCode, 422);
  assert.equal(
    (malformed.json() as { error: { code: string } }).error.code,
    "SEARCH_CURSOR_INVALID",
  );
  const forgedCursor = Buffer.from("off:470", "utf8").toString("base64url");
  const window = await fastify.inject({
    method: "GET",
    url: `/api/v1/search?q=x&locale=ru&cursor=${forgedCursor}&limit=50`,
  });
  assert.equal(window.statusCode, 422);
  assert.equal((window.json() as { error: { code: string } }).error.code, "SEARCH_WINDOW_EXCEEDED");
});

test("security corpus: no private-field, draft or cross-site leakage", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { app, fastify } = await securedStack(t);
  // The unhinted private field's text is nowhere in any result payload.
  const hit = await fastify.inject({ method: "GET", url: "/api/v1/search?q=акции&locale=ru" });
  assert.ok(!hit.body.includes("СЕКРЕТНАЯ_ЗАМЕТКА"), "private field text leaked");
  assert.ok(!hit.body.includes("secret_note"), "private field key leaked");

  // Draft content never surfaces publicly (event-forged draft from the
  // integration suite covers the service; here: transport-level query).
  const leaked = await fastify.inject({ method: "GET", url: "/api/v1/search?q=секретн&locale=ru" });
  assert.equal((leaked.json() as { total: number }).total, 0);

  // Site isolation at the transport: a query for another site key returns
  // nothing even though the actor context is generic-anonymous.
  const other = await app.searchQuery({ q: "акции", locale: "ru", site: "partner" });
  assert.equal(other.total, 0);
  const own = await app.searchQuery({ q: "акции", locale: "ru", site: "default" });
  assert.equal(own.total, 1);
});

test("security corpus: XSS payload in title/snippet is escaped on the /search/ page", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { fastify } = await securedStack(t);
  const page = await fastify.inject({ method: "GET", url: "/search/?q=акции&locale=ru" });
  assert.equal(page.statusCode, 200);
  const body = page.body;
  assert.ok(!body.includes("<script>alert(1)</script>"), "raw script tag reached the page");
  assert.ok(body.includes("&lt;script&gt;"), "payload must be entity-escaped");
  // noindex policy on the search page (Search spec §22).
  assert.equal(page.headers["x-robots-tag"], "noindex, follow");
  assert.match(body, /name="robots" content="noindex/);
});
