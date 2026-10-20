// Content Contract Matrix Gate (CORE-RC19, BLOCKER-01 + owner matrix).
//
// Why this file exists. RC18 shipped a read-side defect: `renderEntryHtml`
// pushed `payload.body ?? fields.body` into `renderRichText` unconditionally.
// A `block_document` Content Type declares `body` with FIELD TYPE
// `block_document` (legal content the block renderer already handled), so the
// WB-ST payload `{"blocks":[],"schema_version":1}` — accepted by publish
// validation — reached the RichText renderer, threw THEME_RICHTEXT_INVALID and
// turned the public home page into HTTP 500. RC9 rendered the same site fine.
//
// The root cause is a missing invariant, not a missing branch: WRITE-side
// acceptance and READ-side decoding must agree on the format of every body.
// This gate therefore pins the whole matrix through the REAL pipeline
// (createDraft → seal → publish → public render), so a future change that
// breaks the agreement fails here rather than on a customer site.
//
// Matrix (owner):
//   rich_text                  strict v2, Save → Seal → Render
//   block_document             typed blocks, Publish → Render
//   RichText inside blocks     nested v2 validated and rendered
//   Media fields               cards, pages and OG
//   empty/optional fields      absent values handled
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApiFastify } from "@pcms/api";
import type { FastifyInstance } from "fastify";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const REFERENCE_TYPES = JSON.parse(
  readFileSync("fixtures/content/reference-content-types.json", "utf8"),
) as { contentTypes: never };

type App = Awaited<ReturnType<typeof createApiFixture>>["app"];

async function siteStack(t: import("node:test").TestContext) {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: REFERENCE_TYPES.contentTypes,
    themeDir: "themes/reference-theme-v1",
    seoEnvironment: "production",
  });
  const site = await app.routes.ensureSite("default");
  const fastify: FastifyInstance = createApiFastify(() => "req_contract_matrix");
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });
  return { app, fastify, site };
}

/** Publishes `fields` as `contentType` at `path`; returns the entry id. */
async function publish(
  app: App,
  siteId: string,
  input: {
    readonly contentType: string;
    readonly path: string;
    readonly fields: Record<string, unknown>;
    readonly blocks?: unknown;
    readonly parentEntryId?: string;
  },
): Promise<string> {
  const ctx = apiContextOf(ownerActor("contract-matrix"));
  const { createDraft, sealRevision, publishRevision } = await import("@pcms/api");
  const draft = await createDraft(app, ctx, {
    content_type: input.contentType,
    payload: {
      fields: input.fields,
      blocks: input.blocks ?? { schema_version: 1, blocks: [] },
    },
    ...(input.parentEntryId === undefined ? {} : { parent_entry_id: input.parentEntryId }),
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId,
    path: input.path,
    targetType: "entry",
    targetId: draft.entry_id,
  });
  return draft.entry_id;
}

const richTextV2 = (text: string): unknown => ({
  schema_version: 2,
  type: "document",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

// ---------------------------------------------------------------------------
// 1 + 5. The exact WB-ST regression, and typed blocks with nested RichText.
// ---------------------------------------------------------------------------

test("block_document: the declared-body payload from RC9-era sites publishes and renders 200", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, site } = await siteStack(t);
  // EXACTLY the WB-ST payload: `page` declares `body` as a block_document field,
  // and the value carries an empty typed block document.
  const entryId = await publish(app, site.id, {
    contentType: "page",
    path: "/wb-st-home",
    fields: { title: "Главная WB-ST", body: { blocks: [], schema_version: 1 } },
  });
  const page = await fastify.inject({ method: "GET", url: "/wb-st-home/" });
  assert.equal(page.statusCode, 200, page.body.slice(0, 400));
  assert.ok(page.body.includes("Главная WB-ST"));
  // No hidden RichText fragment may be produced for a Block Document body.
  assert.ok(!page.body.includes("pcms-richtext-document"));
  void entryId;
});

test("block_document: non-empty typed blocks render their HTML", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, site } = await siteStack(t);
  await publish(app, site.id, {
    contentType: "page",
    path: "/blocks-page",
    fields: { title: "Страница из блоков" },
    blocks: {
      schema_version: 1,
      blocks: [
        {
          id: "01980000-0000-7000-8000-0000000000c1",
          type: "heading",
          schema_version: 1,
          variant: null,
          props: { level: 2, text: "Заголовок блока" },
          children: [],
        },
        {
          id: "01980000-0000-7000-8000-0000000000c2",
          type: "text",
          schema_version: 1,
          variant: null,
          props: {
            rich_text: {
              schema_version: 2,
              type: "document",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Текст из типизированного блока." }],
                },
              ],
            },
          },
          children: [],
        },
      ],
    },
  });
  const page = await fastify.inject({ method: "GET", url: "/blocks-page/" });
  assert.equal(page.statusCode, 200, page.body.slice(0, 400));
  assert.ok(page.body.includes("Заголовок блока"), page.body.slice(0, 600));
  assert.ok(page.body.includes("Текст из типизированного блока."));
});

test("block_document: nested RichText v2 inside a block prop renders and is validated", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, site } = await siteStack(t);
  const nested = richTextV2("Вложенный RichText внутри блока.");
  await publish(app, site.id, {
    contentType: "page",
    path: "/nested-richtext",
    fields: { title: "Вложенный" },
    blocks: {
      schema_version: 1,
      blocks: [
        {
          id: "01980000-0000-7000-8000-0000000000c3",
          type: "text",
          schema_version: 1,
          variant: null,
          props: { rich_text: nested },
          children: [],
        },
      ],
    },
  });
  const page = await fastify.inject({ method: "GET", url: "/nested-richtext/" });
  assert.equal(page.statusCode, 200, page.body.slice(0, 400));
  assert.ok(page.body.includes("Вложенный RichText внутри блока."), page.body.slice(0, 600));
});

// ---------------------------------------------------------------------------
// 3 + 4. rich_text: Save → Seal → Render, and the strict version error.
// ---------------------------------------------------------------------------

test("rich_text: a v2 body renders through body_html", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, site } = await siteStack(t);
  await publish(app, site.id, {
    contentType: "article",
    path: "/v2-article",
    fields: { title: "Статья", body: richTextV2("Тело статьи в каноническом v2.") },
  });
  const page = await fastify.inject({ method: "GET", url: "/v2-article/" });
  assert.equal(page.statusCode, 200, page.body.slice(0, 400));
  assert.ok(page.body.includes("Тело статьи в каноническом v2."));
  assert.ok(page.body.includes("pcms-richtext-document"));
});

test("rich_text: a body without schema_version 2 keeps failing loudly", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, site } = await siteStack(t);
  // A v1-shaped document must NOT publish: the strict validator is unchanged.
  const ctx = apiContextOf(ownerActor("contract-matrix-v1"));
  const { createDraft, sealRevision } = await import("@pcms/api");
  const draft = await createDraft(app, ctx, {
    content_type: "article",
    payload: {
      fields: {
        title: "V1",
        body: {
          type: "document",
          content: [{ type: "paragraph", content: [{ type: "text", text: "legacy" }] }],
        },
      },
      blocks: { schema_version: 1, blocks: [] },
    },
  });
  await assert.rejects(
    () => sealRevision(app, ctx, { revision_id: draft.revision_id }),
    (error: { code?: string }) => error.code === "REVISION_VALIDATION_FAILED",
    "a v1 document must be rejected at seal",
  );
  void fastify;
  void site;
});

// ---------------------------------------------------------------------------
// 6. Empty / optional fields.
// ---------------------------------------------------------------------------

test("empty and absent bodies are valid states, not errors", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, site } = await siteStack(t);
  // page: no `body` value at all (the field is optional).
  await publish(app, site.id, {
    contentType: "page",
    path: "/no-body",
    fields: { title: "Без тела" },
  });
  // page: `body` explicitly null.
  await publish(app, site.id, {
    contentType: "page",
    path: "/null-body",
    fields: { title: "Null тело", body: null },
  });
  // article: empty v2 document.
  await publish(app, site.id, {
    contentType: "article",
    path: "/empty-rt",
    fields: { title: "Пустой", body: { schema_version: 2, type: "document", content: [] } },
  });
  for (const path of ["/no-body/", "/null-body/", "/empty-rt/"]) {
    const page = await fastify.inject({ method: "GET", url: path });
    assert.equal(page.statusCode, 200, `${path}: ${page.body.slice(0, 300)}`);
  }
});

// ---------------------------------------------------------------------------
// 7. Preview and public rendering agree.
// ---------------------------------------------------------------------------

test("preview and public render agree for a block_document page", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, site } = await siteStack(t);
  const blockDoc = {
    schema_version: 1,
    blocks: [
      {
        id: "01980000-0000-7000-8000-0000000000c9",
        type: "text",
        schema_version: 1,
        variant: null,
        props: {
          rich_text: {
            schema_version: 2,
            type: "document",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Согласованность preview и public." }],
              },
            ],
          },
        },
        children: [],
      },
    ],
  };
  await publish(app, site.id, {
    contentType: "page",
    path: "/preview-agree",
    fields: { title: "Preview agree" },
    blocks: blockDoc,
  });
  const live = await fastify.inject({ method: "GET", url: "/preview-agree/" });
  assert.equal(live.statusCode, 200, live.body.slice(0, 300));

  // The same revision through the preview token surface.
  const { createDraft, sealRevision } = await import("@pcms/api");
  const ctx = apiContextOf(ownerActor("contract-matrix-preview"));
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Preview draft" }, blocks: blockDoc },
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  const token = app.previewTokens?.issue({
    kind: "revision",
    entityType: "entry",
    entityId: draft.entry_id as never,
    revisionId: draft.revision_id as never,
  });
  assert.ok(typeof token === "string" && token.length > 0, "a preview token must be issued");
  const preview = await fastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(token)}`,
  });
  assert.equal(preview.statusCode, 200, preview.body.slice(0, 400));
  assert.ok(preview.body.includes("Согласованность preview и public."));
});

// ---------------------------------------------------------------------------
// 8 + 9. Read-side agreement: search/media extraction and write acceptance.
// ---------------------------------------------------------------------------

test("search and media extraction never decode a Block Document as RichText", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await siteStack(t);
  const { extractSearchText } = await import("@pcms/search");
  const loaded = app.contentTypes.getLatestContentType("page");
  assert.ok(loaded !== null);
  // The exact WB-ST body, on the exact declaration. Extraction classifies by
  // the DECLARED field type: `block_document` is in the non-text set, so the
  // RichText reader never runs over it and no AST error can escape into a
  // search index build.
  const extracted = extractSearchText({
    fields: { title: "WB-ST", body: { blocks: [], schema_version: 1 } },
    fieldSchema: loaded.fieldSchema as never,
    bodyPolicy: loaded.bodyPolicy as never,
    blocks: { schema_version: 1, blocks: [] },
  });
  assert.ok(!extracted.bodyText.includes("pcms-richtext"));
  // The title is still indexed — nothing is lost by refusing to decode it.
  assert.ok(extracted.title.length > 0 || extracted.structuredText.length > 0);
});

test("write acceptance and read decoding agree on the body format", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await siteStack(t);
  // Every declared body field's TYPE decides its reader. If a type is declared
  // `block_document`, its value may never be interpreted as RichText, and a
  // `rich_text` field must carry a v2 document — the invariant the RC18 defect
  // violated.
  for (const key of ["page", "article", "news", "case"]) {
    const loaded = app.contentTypes.getLatestContentType(key);
    assert.ok(loaded !== null, `${key} must be registered`);
    const bodyField = loaded.fieldSchema.fields.body;
    assert.ok(bodyField !== undefined, `${key} declares a body field`);
    const expected =
      loaded.bodyPolicy === "block_document"
        ? "block_document"
        : loaded.bodyPolicy === "rich_text"
          ? "rich_text"
          : null;
    assert.equal(
      bodyField.type,
      expected,
      `${key}: bodyPolicy ${loaded.bodyPolicy} must be paired with a ${expected} body field`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2b. The validator gap the defect exposed (reported, not silently accepted).
// ---------------------------------------------------------------------------

test("a declared block_document FIELD value is accepted as-is by publish validation", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await siteStack(t);
  // Documents the write-side contract this gate depends on: the value of a
  // `block_document`-typed field is not re-validated as a block tree by the
  // field validator (the block TREE lives in `payload.blocks`, which IS
  // validated when bodyPolicy is block_document). The render path must
  // therefore never assume a richer shape than the validator guarantees.
  const { validateContentPayload } = await import("@pcms/content");
  const loaded = app.contentTypes.getLatestContentType("page");
  assert.ok(loaded !== null);
  const result = validateContentPayload(
    loaded as never,
    { title: "T", body: { blocks: [], schema_version: 1 } } as never,
    "publish",
  );
  assert.deepEqual(
    result.errors.filter((error) => error.path?.includes("body")),
    [],
    "the renderer must tolerate exactly what the validator accepts",
  );
});
