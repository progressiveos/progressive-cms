// PCMS-ADMIN-T002 — schema-driven editing contracts:
//  - `get_content_type_schema` exposes the full typed field schema;
//  - `list_content_tree` feeds the Admin Content Tree + pickers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OperationContext } from "@pcms/api";
import { createDraft, listContentTree } from "@pcms/api";
import type {
  ContentTypeDefinition,
  RelationListFieldSchema,
  RepeaterFieldSchema,
} from "@pcms/content";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

function referenceDefinitions(): ContentTypeDefinition[] {
  const raw = JSON.parse(
    readFileSync(join("fixtures", "content", "reference-content-types.json"), "utf8"),
  ) as { contentTypes: ContentTypeDefinition[] };
  return raw.contentTypes;
}

async function fixture(t: { after: (fn: () => void) => void }) {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: referenceDefinitions(),
  });
  return { app };
}

test("get_content_type_schema exposes the full field schema (deep parameters)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const schema = app.contentDiscovery.getLatestContentTypeSchema("service");
  assert.ok(schema !== null);
  // shallow summary unchanged
  assert.equal(schema.fields.price?.type, "money");
  // deep schema: money, repeater with stable item fields, relation accepts
  const price = schema.fieldSchema.fields.price;
  assert.ok(price !== undefined);
  assert.equal(price.type, "money");
  const features = schema.fieldSchema.fields.features as RepeaterFieldSchema | undefined;
  assert.ok(features !== undefined);
  assert.equal(features.type, "repeater");
  assert.ok(features.item !== undefined);
  assert.ok(features.item.fields.feature_title !== undefined);
  const related = schema.fieldSchema.fields.related_services as RelationListFieldSchema | undefined;
  assert.ok(related !== undefined);
  assert.deepEqual(related.accepts, ["service"]);
  // enum deep values (article.tags uses list; news.category? use news fixture)
  const news = app.contentDiscovery.getLatestContentTypeSchema("news");
  assert.ok(news !== null);
  const category = news.fieldSchema.fields.category;
  if (category !== undefined && category.type === "enum") {
    const values = (category as { values?: readonly string[] }).values;
    assert.ok(Array.isArray(values) && values.length > 0);
  }
  // JSON round-trip detach: mutation of the returned snapshot is allowed
  const again = app.contentDiscovery.getLatestContentTypeSchema("service");
  assert.deepEqual(schema, again);
});

test("list_content_tree: rows carry title/working/publication indicators", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const created = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "О компании" }, blocks: null },
  });

  const tree = await listContentTree(app, ctx, {});
  const row = tree.items.find((item) => item.entry_id === created.entry_id);
  assert.ok(row !== undefined);
  assert.equal(row.title, "О компании");
  assert.equal(row.has_working, true);
  assert.ok(typeof row.working_revision_id === "string");
  assert.equal(row.has_publication, false);
  assert.equal(row.parent_entry_id, null);
  assert.equal(row.archived_at, null);
});

test("list_content_tree: permission denied without content.read", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx = apiContextOf(scopedActor(["media.read"]));
  await assert.rejects(
    () => listContentTree(app, ctx, {}),
    (error: { readonly code?: string }) => error?.code === "AUTH_PERMISSION_DENIED",
  );
});

test("list_content_tree: nested parent links are preserved", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const parent = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Родитель" }, blocks: null },
  });
  const child = await createDraft(app, ctx, {
    content_type: "page",
    parent_entry_id: parent.entry_id,
    payload: { fields: { title: "Ребёнок" }, blocks: null },
  });
  const tree = await listContentTree(app, ctx, {});
  const childRow = tree.items.find((item) => item.entry_id === child.entry_id);
  assert.ok(childRow !== undefined);
  assert.equal(childRow.parent_entry_id, parent.entry_id);
});

// --- PCMS-ADMIN-T003: Content Tree operations. ---
import { createWorkingDraft, duplicateEntryOp, moveEntryOp, restoreEntryOp } from "@pcms/api";

async function draftOf(
  app: Awaited<ReturnType<typeof fixture>>["app"],
  title: string,
  parent?: string,
) {
  const ctx: OperationContext = apiContextOf(ownerActor());
  return createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title }, blocks: { schema_version: 1, blocks: [] } },
    ...(parent === undefined ? {} : { parent_entry_id: parent }),
  });
}

test("move_entry: reparents and rejects cycles", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const a = await draftOf(app, "A");
  const b = await draftOf(app, "B", a.entry_id);
  const c = await draftOf(app, "C", b.entry_id);

  // A cannot move under its own descendant C.
  await assert.rejects(
    () => moveEntryOp(app, ctx, { entry_id: a.entry_id, parent_entry_id: c.entry_id }),
    (error: { readonly code?: string }) => error?.code === "ENTRY_CYCLE",
  );
  // An entry cannot parent itself.
  await assert.rejects(
    () => moveEntryOp(app, ctx, { entry_id: a.entry_id, parent_entry_id: a.entry_id }),
    (error: { readonly code?: string }) => error?.code === "ENTRY_CYCLE",
  );
  // Successful reparent: C becomes a root entry.
  await moveEntryOp(app, ctx, { entry_id: c.entry_id, parent_entry_id: null });
  const moved = await app.entries.findEntry(c.entry_id as never);
  assert.equal(moved?.parentEntryId, null);
});

test("restore_entry: clears the archive flag set by archive_entry", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const entry = await draftOf(app, "Архивный");
  await app.entries.archiveEntry(entry.entry_id as never);
  assert.notEqual((await app.entries.findEntry(entry.entry_id as never))?.archivedAt ?? null, null);
  await restoreEntryOp(app, ctx, { entry_id: entry.entry_id });
  assert.equal((await app.entries.findEntry(entry.entry_id as never))?.archivedAt ?? null, null);
  // idempotent restore
  await restoreEntryOp(app, ctx, { entry_id: entry.entry_id });
  assert.equal((await app.entries.findEntry(entry.entry_id as never))?.archivedAt ?? null, null);
});

test("duplicate_entry: copies the latest payload into a new sibling draft", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const parent = await draftOf(app, "Раздел");
  const source = await draftOf(app, "Источник", parent.entry_id);
  const copy = await duplicateEntryOp(app, ctx, { entry_id: source.entry_id });
  assert.notEqual(copy.entry_id, source.entry_id);
  const copyEntry = await app.entries.findEntry(copy.entry_id as never);
  assert.equal(copyEntry?.parentEntryId, parent.entry_id);
  const copyRevision = await app.revisions.getRevision(app.pool, copy.revision_id as never);
  assert.ok(copyRevision !== null);
  assert.equal(copyRevision.state, "WORKING");
  const fields = (copyRevision.payload as { fields?: Record<string, unknown> }).fields ?? {};
  assert.equal(fields.title, "Источник");
});

test("create_working_draft: idempotent open, then branch from a sealed revision", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const entry = await draftOf(app, "Черновик-тест");

  const opened = await createWorkingDraft(app, ctx, { entry_id: entry.entry_id });
  assert.equal(opened.created, false);
  assert.equal(opened.revision_id, entry.revision_id);

  // seal the working revision, then create a fresh draft from it
  await app.revisions.sealRevision({ revisionId: entry.revision_id as never });
  const branched = await createWorkingDraft(app, ctx, { entry_id: entry.entry_id });
  assert.equal(branched.created, true);
  assert.notEqual(branched.revision_id, entry.revision_id);
  const branchedRevision = await app.revisions.getRevision(app.pool, branched.revision_id as never);
  assert.ok(branchedRevision !== null);
  const fields = (branchedRevision.payload as { fields?: Record<string, unknown> }).fields ?? {};
  assert.equal(fields.title, "Черновик-тест");
});

// --- PCMS-ADMIN-T005: canonical rich text conversion for the Admin editor. ---
test("convert_rich_text: markdown↔AST through the canonical M02 adapter", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const { convertRichText } = await import("@pcms/api");

  const ast = await convertRichText(app, ctx, {
    direction: "markdown_to_ast",
    value: "# Заголовок\n\nПривет **мир** и *курсив* [ссылка](https://example.ru)",
  });
  assert.equal(ast.ok, true);
  const doc = ast.value as { type: string; content: readonly { type: string }[] };
  assert.equal(doc.type, "document");
  assert.equal(doc.content[0]?.type, "heading");
  assert.equal(doc.content[1]?.type, "paragraph");

  const md = await convertRichText(app, ctx, { direction: "ast_to_markdown", value: doc });
  assert.equal(md.ok, true);
  assert.match(String(md.value), /# Заголовок/);
  assert.match(String(md.value), /\*\*мир\*\*/);
});

test("convert_rich_text: raw HTML and unsafe hrefs are rejected", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const { convertRichText } = await import("@pcms/api");

  const html = await convertRichText(app, ctx, {
    direction: "markdown_to_ast",
    value: "<script>alert(1)</script>",
  });
  assert.equal(html.ok, false);

  const href = await convertRichText(app, ctx, {
    direction: "markdown_to_ast",
    value: "[x](javascript:alert(1))",
  });
  assert.equal(href.ok, false);
});

// --- PCMS-ADMIN-T010: entry SEO document operations. ---
test("get/update entry seo: stored document round-trip + permission split", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const { createWorkingDraft, getEntrySeo, updateEntrySeo } = await import("@pcms/api");
  const entry = await createWorkingDraft(app, ctx, {
    entry_id: (
      await createDraft(app, ctx, {
        content_type: "news",
        payload: {
          fields: { title: "Новость SEO", datetime: "2026-09-20T12:00:00Z" },
          blocks: null,
        },
      })
    ).entry_id,
  });

  // find the created entry id from the tree
  const tree = await listContentTree(app, ctx, {});
  const row = tree.items.find((item) => item.title === "Новость SEO");
  assert.ok(row !== undefined);

  const empty = await getEntrySeo(app, ctx, { entry_id: row.entry_id });
  assert.equal(empty.document, null);

  await updateEntrySeo(app, ctx, {
    entry_id: row.entry_id,
    document: {
      seo_title: "Новость — SEO title",
      meta_description: "Описание для выдачи",
      canonical_override: null,
      robots_policy: { index: false, follow: true },
      social_title: "Новость — social",
      social_description: null,
      social_image: null,
      structured_data_type_hint: "news_article",
    },
  });
  const stored = await getEntrySeo(app, ctx, { entry_id: row.entry_id });
  const document = stored.document as { seo_title: string; robots_policy: { index: boolean } };
  assert.equal(document.seo_title, "Новость — SEO title");
  assert.equal(document.robots_policy.index, false);

  // canonical override requires the extra permission
  const editor = apiContextOf(scopedActor(["seo.edit"]));
  await assert.rejects(
    () =>
      updateEntrySeo(app, editor, {
        entry_id: row.entry_id,
        document: {
          seo_title: null,
          meta_description: null,
          canonical_override: "https://example.ru/override",
          robots_policy: null,
          social_title: null,
          social_description: null,
          social_image: null,
          structured_data_type_hint: null,
        },
      }),
    (error: { readonly code?: string }) => error?.code === "AUTH_PERMISSION_DENIED",
  );
});

// --- PCMS-ADMIN-T011: entry route view + explicit canonical change. ---
test("get_entry_route + change_entry_route: proposal, history, redirect", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const { getEntryRoute, changeEntryRoute } = await import("@pcms/api");

  const entry = await createDraft(app, ctx, {
    content_type: "news",
    payload: {
      fields: { title: "Услуга по модернизации", datetime: "2026-09-20T12:00:00Z" },
      blocks: null,
    },
  });

  const view = await getEntryRoute(app, ctx, { entry_id: entry.entry_id });
  assert.equal(view.current, null); // not routed until first publication
  assert.match(view.proposal, /^\/[a-z0-9-]+\/?$/); // normalized from the title

  // Change applies only to routed entries.
  await assert.rejects(
    () => changeEntryRoute(app, ctx, { entry_id: entry.entry_id, to_path: "/new/" }),
    (error: { readonly code?: string }) => error?.code === "API_REQUEST_INVALID",
  );

  // Route it like a publication would, then change canonically.
  await app.routes.activateRoute({
    siteId: view.site_id,
    path: "/usluga/",
    targetType: "entry",
    targetId: entry.entry_id as never,
  });
  const routed = await getEntryRoute(app, ctx, { entry_id: entry.entry_id });
  assert.equal(routed.current?.path, "/usluga/");

  const changed = await changeEntryRoute(app, ctx, {
    entry_id: entry.entry_id,
    to_path: "/modernizaciya/",
    reason: "M10 test",
  });
  assert.equal(changed.old_path, "/usluga/");
  assert.equal(changed.new_path, "/modernizaciya/");

  const after = await getEntryRoute(app, ctx, { entry_id: entry.entry_id });
  assert.equal(after.current?.path, "/modernizaciya/");
  assert.ok(
    after.history.some(
      (record) => record.old_path.replace(/\/+$/, "") === "/usluga" && record.retired_at === null,
    ),
    JSON.stringify(after.history),
  );

  // The old path still resolves as a redirect (recorded history).
  const redirect = await app.routeHistory.findActiveRedirect(view.site_id, "/usluga/");
  assert.ok(redirect !== null);
  assert.equal(redirect.targetType, "path");
  assert.equal(redirect.targetId, "/modernizaciya/");
});
