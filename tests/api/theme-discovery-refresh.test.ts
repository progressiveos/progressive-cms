// Theme discovery refreshes its manifest when theme.json changes on disk
// (2026-10-04 report: the site rendered refreshed theme 2.10.0 while the
// template-pick API still held the boot-time catalog and rejected a template
// the live theme declared — TEMPLATE_INCOMPATIBLE on news-index).
// The discovery now applies the same fingerprint rule as the site render
// stack: one stat() per read, re-parse only on change, last good manifest
// survives a half-written deploy.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDraft } from "@pcms/api";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const REFERENCE_TYPES = JSON.parse(
  readFileSync("fixtures/content/reference-content-types.json", "utf8"),
) as { contentTypes: never };

test("template-pick API sees an in-place theme update without restart", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const root = mkdtempSync(join(tmpdir(), "pcms-discovery-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const themeDir = join(root, "theme");
  cpSync("themes/reference-theme-v1", themeDir, { recursive: true });

  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: REFERENCE_TYPES.contentTypes as never,
    themeDir,
  });
  const ctx = apiContextOf(ownerActor("discovery-refresh"));
  assert.equal(
    app.themeDiscovery?.getManifest().templates.some((x) => x.id === "news-index"),
    false,
  );

  // In-place theme package update: new version + a new template for pages.
  const manifest = JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8")) as {
    version: string;
    templates: { id: string; file: string; accepts_content_types: string[] }[];
  };
  manifest.version = "2.10.0";
  manifest.templates.push({
    id: "news-index",
    file: "templates/news-index.liquid",
    accepts_content_types: ["page@1"],
  });
  writeFileSync(join(themeDir, "templates", "news-index.liquid"), "<main>{{ body_html }}</main>");
  // Replace (not rewrite in place) so the fingerprint changes for sure.
  const manifestPath = join(themeDir, "theme.json");
  const tmpPath = `${manifestPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));

  const { renameSync } = await import("node:fs");
  renameSync(tmpPath, manifestPath);

  // Discovery (and every template-pick consumer behind it) now reports the
  // refreshed theme without any restart or re-composition.
  assert.equal(app.themeDiscovery.getManifest().version, "2.10.0");
  const templates = app.themeDiscovery.listTemplates();
  assert.ok(templates.some((x) => x.id === "news-index"));

  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Новости" }, blocks: { schema_version: 1, blocks: [] } },
  });
  // The exact rejection from the report: assigning the new template through
  // the API must succeed now, not answer TEMPLATE_INCOMPATIBLE.
  const { setEntryTemplateOp } = await import("@pcms/api");
  await setEntryTemplateOp(app, ctx, { entry_id: draft.entry_id, template_key: "news-index" });
  // An actually-unknown template still answers the typed error.
  await assert.rejects(
    setEntryTemplateOp(app, ctx, { entry_id: draft.entry_id, template_key: "no-such-template" }),
    /TEMPLATE_INCOMPATIBLE|not declared by the active theme/,
  );
});
