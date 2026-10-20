// Per-entry template assignment (Theme Contract §12-§18; owner UX gap C).
// End-to-end at the application layer: create with template, backend
// validation against the active theme, publication safety via the sealed
// sidecar snapshot, discovery surface.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OperationContext } from "@pcms/api";
import {
  ApiError,
  createDraft,
  listCompatibleTemplatesOp,
  listContentTree,
  sealRevision,
  setEntryTemplateOp,
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

async function fixture(t: { after: (fn: () => void) => void }) {
  return createApiFixture(t, {
    contentTypeDefinitions: referenceDefinitions(),
    themeDir: "themes/reference-theme-v1",
  });
}

test("entry template: create with template_key, visible in the tree", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const created = await createDraft(app, ctx, {
    content_type: "page",
    template_key: "page-hero",
    payload: { fields: { title: "Hero" }, blocks: null },
  });
  const tree = await listContentTree(app, ctx, {});
  const row = tree.items.find((item) => item.entry_id === created.entry_id);
  assert.equal(row?.template_key, "page-hero");
});

test("entry template: incompatible/unknown template rejected with a stable error", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  await assert.rejects(
    () =>
      createDraft(app, ctx, {
        content_type: "service",
        template_key: "page-hero",
        payload: { fields: { title: "x" }, blocks: null },
      }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "TEMPLATE_INCOMPATIBLE" && error.status === 422,
  );
  const created = await createDraft(app, ctx, {
    content_type: "service",
    payload: { fields: { title: "x" }, blocks: null },
  });
  await assert.rejects(
    () => setEntryTemplateOp(app, ctx, { entry_id: created.entry_id, template_key: "no-such" }),
    (error: unknown) => codeOf(error) === "TEMPLATE_INCOMPATIBLE",
  );
  await assert.rejects(
    () => setEntryTemplateOp(app, ctx, { entry_id: created.entry_id, template_key: "page-hero" }),
    (error: unknown) => codeOf(error) === "TEMPLATE_INCOMPATIBLE",
  );
});

test("entry template: seal snapshots the assignment (publication safety)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const created = await createDraft(app, ctx, {
    content_type: "page",
    template_key: "page-default",
    payload: { fields: { title: "H" }, blocks: { schema_version: 1, blocks: [] } },
  });
  const sealed = await sealRevision(app, ctx, { revision_id: created.revision_id });
  assert.equal(
    (sealed.sidecar as Record<string, unknown>).template_key,
    "page-default",
    "the sealed revision must carry the template snapshot",
  );
  // Reassign AFTER seal: the sealed snapshot keeps the old template, so the
  // live page cannot change until the new assignment is sealed+published.
  await setEntryTemplateOp(app, ctx, { entry_id: created.entry_id, template_key: "page-hero" });
  assert.equal(
    (sealed.sidecar as Record<string, unknown>).template_key,
    "page-default",
    "post-seal reassignment must not mutate the sealed snapshot",
  );
  const tree = await listContentTree(app, ctx, {});
  const row = tree.items.find((item) => item.entry_id === created.entry_id);
  assert.equal(row?.template_key, "page-hero");
});

test("entry template: discovery lists only compatible templates", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const service = await listCompatibleTemplatesOp(app, ctx, "service");
  assert.deepEqual(service.items.map((template) => template.id).sort(), [
    "service-default",
    "service-premium",
  ]);
});

function codeOf(error: unknown): string {
  assert.ok(
    error instanceof ApiError || (error as { code?: string }).code !== undefined,
    `expected a coded error, got ${String(error)}`,
  );
  return (error as { code: string }).code;
}
