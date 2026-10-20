// Native route move leaves a 301 (2026-10-04 site report: a changeset route
// operation with frees_path retired /journal/… and activated /news/…, but the
// old URL 404'd because the changeset path never wrote route_history — the
// documented route-change semantics (Navigation spec §31) the interactive
// changeRoute op already provides).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  addChangesetItem,
  applyChangeset,
  createChangeset,
  createDraft,
  preflightChangeset,
  sealRevision,
} from "@pcms/api";
import type { ContentTypeDefinition } from "@pcms/content";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

function referenceDefinitions(): ContentTypeDefinition[] {
  const raw = JSON.parse(readFileSync("fixtures/content/reference-content-types.json", "utf8")) as {
    contentTypes: ContentTypeDefinition[];
  };
  return raw.contentTypes;
}

test("changeset route move frees the old path into a 301 redirect", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: referenceDefinitions(),
  });
  const ctx = apiContextOf(ownerActor("route-move"));
  const site = await app.routes.ensureSite(app.defaultSiteKey);

  const entry = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Story" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(app, ctx, { revision_id: entry.revision_id });

  // First binding — no frees_path, no redirect must appear.
  const first = (await createChangeset(app, ctx, { title: "route it" })) as { id: string };
  await addChangesetItem(app, ctx, {
    changeset_id: first.id,
    entity_type: "entry",
    entity_id: entry.entry_id,
    intent: "PUBLISH",
    target_revision_id: entry.revision_id,
    expected_generation: entry.edit_generation,
    route_operation: { kind: "set", site_id: site.id, path: "/journal/story/" },
  });
  await preflightChangeset(app, ctx, { changeset_id: first.id });
  await applyChangeset(app, ctx, { changeset_id: first.id });
  assert.equal(await app.routeHistory.findActiveRedirect(site.id, "/journal/story/", null), null);

  // The move: same entry, new canonical path, frees_path = old path.
  const move = (await createChangeset(app, ctx, { title: "move to news" })) as { id: string };
  await addChangesetItem(app, ctx, {
    changeset_id: move.id,
    entity_type: "entry",
    entity_id: entry.entry_id,
    intent: "PUBLISH",
    target_revision_id: entry.revision_id,
    expected_generation: 1,
    route_operation: {
      kind: "set",
      site_id: site.id,
      path: "/news/story/",
      frees_path: "/journal/story/",
    },
  });
  await preflightChangeset(app, ctx, { changeset_id: move.id });
  await applyChangeset(app, ctx, { changeset_id: move.id });

  // The freed path is a historical 301 to the new canonical path.
  const redirect = await app.routeHistory.findActiveRedirect(site.id, "/journal/story/", null);
  assert.ok(redirect, "no redirect recorded for the freed path");
  assert.equal(redirect.targetType, "path");
  assert.equal(redirect.targetId, "/news/story/");
  assert.equal(redirect.statusCode, 301);
  // The live resolver answers it (the public site maps this to a 301 reply).
  const resolution = await app.requestResolver.resolve({ path: "/journal/story/" });
  assert.equal(resolution.kind, "redirect");
  assert.equal(resolution.statusCode, 301);
  if (resolution.kind === "redirect") assert.equal(resolution.location, "/news/story/");
  const target = await app.requestResolver.resolve({ path: "/news/story/" });
  assert.equal(target.kind, "route");
});
