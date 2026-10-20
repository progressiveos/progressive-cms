// Structural folder invariants (entry_kind = "folder"; owner decision
// 2026-09-24): folders organize the editorial Content Tree only — the
// application layer rejects every public surface with stable codes, moving
// stays route/navigation-neutral, cycle protection still applies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OperationContext } from "@pcms/api";
import {
  ApiError,
  archiveEntry,
  changeEntryRoute,
  createDraft,
  createNavigationSet,
  createThemePreview,
  duplicateEntryOp,
  getEntryRoute,
  insertNavigationItem,
  listContentTree,
  moveEntryOp,
  publishRevision,
  sealRevision,
  updateEntrySeo,
} from "@pcms/api";
import type { ContentTypeDefinition } from "@pcms/content";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

function referenceDefinitions(): ContentTypeDefinition[] {
  const raw = JSON.parse(
    readFileSync(join("fixtures", "content", "reference-content-types.json"), "utf8"),
  ) as { contentTypes: ContentTypeDefinition[] };
  return raw.contentTypes;
}

function codeOf(error: unknown): string {
  assert.ok(
    error instanceof ApiError || (error as { code?: string }).code !== undefined,
    `expected a coded error, got ${String(error)}`,
  );
  return (error as { code: string }).code;
}

test("folders: created via the folder content type, visible as kind=folder in the tree", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, { contentTypeDefinitions: referenceDefinitions() });
  const ctx: OperationContext = apiContextOf(ownerActor());
  const folder = await createDraft(app, ctx, {
    content_type: "folder",
    payload: { fields: { title: "Услуги" }, blocks: null },
  });
  const child = await createDraft(app, ctx, {
    content_type: "page",
    parent_entry_id: folder.entry_id,
    payload: { fields: { title: "Кровля" }, blocks: null },
  });
  const tree = await listContentTree(app, ctx, {});
  const row = tree.items.find((item) => item.entry_id === folder.entry_id);
  assert.ok(row !== undefined);
  assert.equal(row.kind, "folder");
  assert.equal(row.title, "Услуги");
  const childRow = tree.items.find((item) => item.entry_id === child.entry_id);
  assert.equal(childRow?.kind, "content");
  assert.equal(childRow?.parent_entry_id, folder.entry_id);
});

test("folders: cannot be sealed, published, routed, SEO-documented or duplicated", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, { contentTypeDefinitions: referenceDefinitions() });
  const ctx: OperationContext = apiContextOf(ownerActor());
  const folder = await createDraft(app, ctx, {
    content_type: "folder",
    payload: { fields: { title: "Проекты" }, blocks: null },
  });

  await assert.rejects(
    () => sealRevision(app, ctx, { revision_id: folder.revision_id }),
    (error: unknown) => codeOf(error) === "ENTRY_KIND_FORBIDDEN",
  );
  await assert.rejects(
    () =>
      publishRevision(app, ctx, {
        entity_type: "entry",
        entity_id: folder.entry_id,
        target_revision_id: folder.revision_id,
        expected_generation: folder.edit_generation,
      }),
    (error: unknown) => codeOf(error) === "ENTRY_KIND_FORBIDDEN",
  );
  await assert.rejects(
    () => changeEntryRoute(app, ctx, { entry_id: folder.entry_id, to_path: "/services" }),
    (error: unknown) => codeOf(error) === "ENTRY_KIND_FORBIDDEN",
  );
  await assert.rejects(
    () => updateEntrySeo(app, ctx, { entry_id: folder.entry_id, document: { description: "x" } }),
    (error: unknown) => codeOf(error) === "ENTRY_KIND_FORBIDDEN",
  );
  await assert.rejects(
    () => duplicateEntryOp(app, ctx, { entry_id: folder.entry_id }),
    (error: unknown) => codeOf(error) === "ENTRY_KIND_FORBIDDEN",
  );
  await assert.rejects(
    () =>
      createThemePreview(app, ctx, {
        scope: {
          kind: "revision",
          entity_type: "entry",
          entity_id: folder.entry_id,
          revision_id: folder.revision_id,
        },
      }),
    (error: unknown) => codeOf(error) === "ENTRY_KIND_FORBIDDEN",
  );
});

test("folders: cannot be navigation targets", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, { contentTypeDefinitions: referenceDefinitions() });
  const ctx: OperationContext = apiContextOf(ownerActor());
  const folder = await createDraft(app, ctx, {
    content_type: "folder",
    payload: { fields: { title: "Документы" }, blocks: null },
  });
  const set = await createNavigationSet(app, ctx, { key: "main", title: "Основное" });
  await assert.rejects(
    () =>
      insertNavigationItem(app, ctx, {
        set_id: set.set_id,
        type: "internal_entry",
        label: "Услуги",
        target: { kind: "internal_entry", entry_id: folder.entry_id },
      }),
    (error: unknown) => codeOf(error) === "ENTRY_KIND_FORBIDDEN",
  );
});

test("folders: archive blocked while children are live, allowed after they move out", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, { contentTypeDefinitions: referenceDefinitions() });
  const ctx: OperationContext = apiContextOf(ownerActor());
  const folder = await createDraft(app, ctx, {
    content_type: "folder",
    payload: { fields: { title: "Архив" }, blocks: null },
  });
  const child = await createDraft(app, ctx, {
    content_type: "page",
    parent_entry_id: folder.entry_id,
    payload: { fields: { title: "Старое" }, blocks: null },
  });
  await assert.rejects(
    () => archiveEntry(app, ctx, { entry_id: folder.entry_id }),
    (error: unknown) => codeOf(error) === "FOLDER_NOT_EMPTY",
  );
  await moveEntryOp(app, ctx, { entry_id: child.entry_id, parent_entry_id: null });
  const archived = await archiveEntry(app, ctx, { entry_id: folder.entry_id });
  assert.ok(archived.archived_at !== null);
});

test("folders: move stays route-neutral; cycle protection still rejects subtree moves", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, { contentTypeDefinitions: referenceDefinitions() });
  const ctx: OperationContext = apiContextOf(ownerActor());
  const folder = await createDraft(app, ctx, {
    content_type: "folder",
    payload: { fields: { title: "Блог" }, blocks: null },
  });
  const article = await createDraft(app, ctx, {
    content_type: "article",
    payload: { fields: { title: "Заметка" }, blocks: null },
  });
  const routeBefore = await getEntryRoute(app, ctx, { entry_id: article.entry_id });

  await moveEntryOp(app, ctx, { entry_id: article.entry_id, parent_entry_id: folder.entry_id });
  // A folder with its subtree moves as a unit; a folder into its own child is
  // the same cycle the Content Tree always rejected.
  await assert.rejects(
    () => moveEntryOp(app, ctx, { entry_id: folder.entry_id, parent_entry_id: article.entry_id }),
    (error: unknown) => codeOf(error) === "ENTRY_CYCLE",
  );

  const routeAfter = await getEntryRoute(app, ctx, { entry_id: article.entry_id });
  assert.deepEqual(
    {
      current: routeAfter.current,
      proposal: routeAfter.proposal,
    },
    { current: routeBefore.current, proposal: routeBefore.proposal },
  );
  // Reparenting wrote nothing but the parent link.
  const tree = await listContentTree(app, ctx, {});
  const moved = tree.items.find((item) => item.entry_id === article.entry_id);
  assert.equal(moved?.parent_entry_id, folder.entry_id);
  assert.equal(moved?.has_publication, false);
});

test("tree: route_path reflects the live canonical route (text=uuid cast regression, 2026-09-29)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, { contentTypeDefinitions: referenceDefinitions() });
  const ctx: OperationContext = apiContextOf(ownerActor());
  const entry = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Маршрутная" }, blocks: null },
  });
  const unrouted = await listContentTree(app, ctx, {});
  assert.equal(unrouted.items.find((item) => item.entry_id === entry.entry_id)?.route_path, null);

  // A live canonical route (routes.target_id is TEXT — the join must cast).
  const site = await app.routes.ensureSite(app.defaultSiteKey);
  await app.pool.query(
    `INSERT INTO routes (id, site_id, path, target_type, target_id, is_canonical)
     VALUES (gen_random_uuid(), $1, '/routeworks', 'entry', $2, TRUE)`,
    [site.id, entry.entry_id],
  );
  const routed = await listContentTree(app, ctx, {});
  assert.equal(
    routed.items.find((item) => item.entry_id === entry.entry_id)?.route_path,
    "/routeworks",
  );
});
