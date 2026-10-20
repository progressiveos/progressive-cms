// Content Tree move invariance on a ROUTED entry (owner acceptance §14/§22):
// reparenting a published, routed entry must keep the canonical route and the
// publication state byte-identical — with a real changeset-assigned route.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OperationContext } from "@pcms/api";
import {
  addChangesetItem,
  applyChangeset,
  createChangeset,
  createDraft,
  getEntryRoute,
  listContentTree,
  moveEntryOp,
  preflightChangeset,
  publishRevision,
  sealRevision,
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

test("move of a routed published entry keeps route and publication", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: referenceDefinitions(),
  });
  const ctx: OperationContext = apiContextOf(ownerActor());

  const entry = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Сотрудник" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(app, ctx, { revision_id: entry.revision_id });

  const site = await app.routes.ensureSite(app.defaultSiteKey);
  const changeset = (await createChangeset(app, ctx, { title: "route it" })) as {
    id: string;
  };
  await addChangesetItem(app, ctx, {
    changeset_id: changeset.id,
    entity_type: "entry",
    entity_id: entry.entry_id,
    intent: "PUBLISH",
    target_revision_id: entry.revision_id,
    expected_generation: entry.edit_generation,
    route_operation: { kind: "set", site_id: site.id, path: "/sotrudnik/" },
  });
  await preflightChangeset(app, ctx, { changeset_id: changeset.id as string });
  await applyChangeset(app, ctx, { changeset_id: changeset.id });

  const routeBefore = await getEntryRoute(app, ctx, { entry_id: entry.entry_id });
  assert.equal(routeBefore.current?.path, "/sotrudnik/");
  const publicationBefore = await app.publications.getPublication(
    app.pool,
    "entry",
    entry.entry_id as never,
    "default",
  );

  // Folder + move the routed entry under it (the Spangar reorganization move).
  const folder = await createDraft(app, ctx, {
    content_type: "folder",
    payload: { fields: { title: "Документы" }, blocks: null },
  });
  await moveEntryOp(app, ctx, {
    entry_id: entry.entry_id,
    parent_entry_id: folder.entry_id,
  });

  const routeAfter = await getEntryRoute(app, ctx, { entry_id: entry.entry_id });
  assert.deepEqual(routeAfter, routeBefore);
  const publicationAfter = await app.publications.getPublication(
    app.pool,
    "entry",
    entry.entry_id as never,
    "default",
  );
  assert.equal(publicationAfter?.state, publicationBefore?.state);
  assert.equal(publicationAfter?.generation, publicationBefore?.generation);

  const tree = await listContentTree(app, ctx, {});
  const moved = tree.items.find((item) => item.entry_id === entry.entry_id);
  assert.equal(moved?.parent_entry_id, folder.entry_id);
  assert.equal(moved?.has_publication, true);
});
