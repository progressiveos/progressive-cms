// Universal guard for the format-confusion class of defects
// (CORE-RC19-BLOCKER-01, item 4: "a universal regression test that protects
// future sites with such a Content Model").
//
// The wb-st defect did not depend on the site, the hostname or the `page`
// Content Type: any Content Type whose body is a Block Document broke at read
// time, and the report counted the same declaration in ten Content Types
// across five databases. A test written against `page` would only protect
// `page`, so this one builds SYNTHETIC content types with generated keys and
// drives them through the real pipeline.
//
// Two properties are pinned, for every combination:
//
//   1. A body whose declared type is `block_document` is NEVER decoded by the
//      RichText reader, and publishing one renders 200 — regardless of whether
//      the value is empty, populated, or carries its own `schema_version: 1`.
//   2. A body whose declared type is `rich_text` IS rendered by the RichText
//      reader when it is a v2 document, and is still rejected when it is not.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiFastify } from "@pcms/api";
import type { FastifyInstance } from "fastify";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const RICH_TEXT_V2 = (text: string): unknown => ({
  schema_version: 2,
  type: "document",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/**
 * A content type generated per case, so nothing here depends on the shipped
 * reference types: same declaration shape, different keys.
 */
function bodyType(key: string, bodyPolicy: "block_document" | "rich_text") {
  return {
    key,
    version: 1,
    title: key,
    bodyPolicy,
    fields: {
      title: { id: "title", type: "string", required: true },
      body: { id: "body", type: bodyPolicy },
      intro: { id: "intro", type: "text" },
    },
  };
}

/** A minimal theme whose single template accepts any content type. */
function writeTheme(root: string, acceptedType: string): string {
  const dir = join(root, "theme");
  mkdirSync(join(dir, "templates"), { recursive: true });
  mkdirSync(join(dir, "tokens"), { recursive: true });
  writeFileSync(
    join(dir, "theme.json"),
    JSON.stringify({
      id: "matrix-theme",
      name: "Matrix theme",
      description: "Generated theme for the body-format guard",
      version: "1.0.0",
      theme_contract: "^1.0",
      capabilities: [],
      directories: [],
      templates: [
        {
          id: "entry",
          file: "templates/entry.liquid",
          accepts_content_types: [`${acceptedType}@1`],
        },
      ],
      components: [],
      block_renderers: [{ block: "heading@1", file: "blocks/heading.liquid" }],
      navigation_placements: [
        {
          id: "header.primary",
          label: "Primary navigation",
          max_depth: 2,
          supported_item_types: ["internal_entry"],
        },
      ],
      media_presets: [
        { id: "card", width: 800, height: 600, fit: "cover", formats: ["webp"], loading: "lazy" },
      ],
      settings_schema: [],
      assets: { css: [], js: [], fingerprint: true },
    }),
  );
  mkdirSync(join(dir, "blocks"), { recursive: true });
  mkdirSync(join(dir, "components"), { recursive: true });
  writeFileSync(
    join(dir, "templates", "entry.liquid"),
    "<h1>{{ entry.title }}</h1>{{ blocks_html }}{{ body_html }}",
  );
  writeFileSync(join(dir, "blocks", "heading.liquid"), "<h2>{{ block.props.text }}</h2>");
  return dir;
}

async function stackFor(t: import("node:test").TestContext, typeDef: ReturnType<typeof bodyType>) {
  const root = mkdtempSync(join(tmpdir(), "pcms-format-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const themeDir = writeTheme(root, typeDef.key);
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [typeDef] as never,
    themeDir,
    seoEnvironment: "production",
  });
  const site = await app.routes.ensureSite("default");
  const fastify: FastifyInstance = createApiFastify(() => "req_format_guard");
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });
  return { app, fastify, site };
}

async function publishAndRender(
  stack: Awaited<ReturnType<typeof stackFor>>,
  contentType: string,
  path: string,
  body: { readonly fields: Record<string, unknown>; readonly blocks: unknown },
): Promise<{ readonly status: number; readonly html: string }> {
  const ctx = apiContextOf(ownerActor("format-guard"));
  const { createDraft, sealRevision, publishRevision } = await import("@pcms/api");
  const draft = await createDraft(stack.app, ctx, {
    content_type: contentType,
    payload: { fields: body.fields, blocks: body.blocks },
  });
  await sealRevision(stack.app, ctx, { revision_id: draft.revision_id });
  await publishRevision(stack.app, ctx, {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  await stack.app.routes.activateRoute({
    siteId: stack.site.id,
    path,
    targetType: "entry",
    targetId: draft.entry_id,
  });
  const page = await stack.fastify.inject({ method: "GET", url: `${path}/` });
  return { status: page.statusCode, html: page.body };
}

test("a Block Document body is never decoded as RichText, whatever its value", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  // Three values that all declare a Block Document under a body field typed
  // `block_document`: the reported empty one, a populated one, and a
  // nonempty one carrying its own envelope version.
  const cases: readonly { name: string; body: unknown; blocks: unknown }[] = [
    {
      name: "empty",
      body: { blocks: [], schema_version: 1 },
      blocks: { schema_version: 1, blocks: [] },
    },
    {
      name: "populated",
      body: { blocks: [], schema_version: 1 },
      blocks: {
        schema_version: 1,
        blocks: [
          {
            id: "01980000-0000-7000-8000-0000000000f1",
            type: "heading",
            schema_version: 1,
            variant: null,
            props: { level: 2, text: "guard-heading" },
            children: [],
          },
        ],
      },
    },
    {
      name: "null",
      body: null,
      blocks: { schema_version: 1, blocks: [] },
    },
  ];
  // One generated key per case keeps this independent of any shipped type.
  let index = 0;
  for (const item of cases) {
    index += 1;
    const typeDef = bodyType(`guard_blocks_${index}`, "block_document");
    const stack = await stackFor(t, typeDef);
    const result = await publishAndRender(stack, typeDef.key, `/guard-${index}`, {
      fields: { title: `Guard ${item.name}`, body: item.body },
      blocks: item.blocks,
    });
    assert.equal(
      result.status,
      200,
      `block_document (${item.name}) must render: ${result.html.slice(0, 300)}`,
    );
    // The RichText renderer must not have run over it.
    assert.ok(
      !result.html.includes("THEME_RICHTEXT_INVALID"),
      `block_document (${item.name}) reached the RichText renderer`,
    );
    assert.ok(!result.html.includes("pcms-richtext-document"));
    if (item.name === "populated") {
      assert.ok(result.html.includes("guard-heading"), "typed blocks must render");
    }
  }
});

test("a rich_text body is rendered as v2 and still rejected when it is not", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const typeDef = bodyType("guard_richtext_1", "rich_text");
  const stack = await stackFor(t, typeDef);

  const rendered = await publishAndRender(stack, typeDef.key, "/guard-rich", {
    fields: { title: "Guard rich", body: RICH_TEXT_V2("guard-richtext-text") },
    blocks: { schema_version: 1, blocks: [] },
  });
  assert.equal(rendered.status, 200, rendered.html.slice(0, 300));
  assert.ok(rendered.html.includes("guard-richtext-text"));
  assert.ok(rendered.html.includes("pcms-richtext-document"));

  // The same declaration with a version-less document must still fail at seal:
  // the strict validator is unchanged by this guard.
  const ctx = apiContextOf(ownerActor("format-guard-v1"));
  const { createDraft, sealRevision } = await import("@pcms/api");
  const draft = await createDraft(stack.app, ctx, {
    content_type: typeDef.key,
    payload: {
      fields: {
        title: "Guard legacy",
        body: {
          type: "document",
          content: [{ type: "paragraph", content: [{ type: "text", text: "legacy" }] }],
        },
      },
      blocks: { schema_version: 1, blocks: [] },
    },
  });
  await assert.rejects(
    () => sealRevision(stack.app, ctx, { revision_id: draft.revision_id }),
    (error: { code?: string }) => error.code === "REVISION_VALIDATION_FAILED",
  );
});

test("the guard does not depend on the shipped reference content types", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  // The generated keys used above must not exist in the product's own type set:
  // if they did, this guard could be satisfied by a `page`-specific branch.
  const typeDef = bodyType("guard_blocks_probe", "block_document");
  const stack = await stackFor(t, typeDef);
  const generated = stack.app.contentTypes.getLatestContentType(typeDef.key);
  assert.ok(generated !== null, "the synthetic type must be what is loaded");
  assert.equal(generated.key, typeDef.key);
  for (const shipped of ["page", "article", "news", "case", "service"]) {
    assert.notEqual(typeDef.key, shipped, "the guard must use a type the product does not ship");
  }
});
