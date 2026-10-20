// First real-site adaptation spike (PCMS-THEME-T029; Theme Contract spec §75).
// The corporate design (fixtures/reference-corporate/theme) adapts onto
// Theme Contract v1 with NO Core patches: everything is expressed as manifest
// declarations, tokens, components and fixtures. If a contract change had
// been required, that would be an ADR — none was.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createThemeDiscovery,
  createThemePreview,
  type MediaAssetViewModel,
  type NavigationAssignment,
  renderRichText,
  validateSiteAgainstTheme,
  validateThemeDir,
} from "@pcms/themes";

const THEME_DIR = "fixtures/reference-corporate/theme";

interface Fixture {
  name: string;
  entry: {
    templateKey: string;
    contentTypeKey: string;
    contentTypeVersion: number;
    title: string;
    fields: Record<string, unknown>;
    blocks: Parameters<ReturnType<typeof createThemePreview>["blocks"]["renderBlockDocument"]>[0];
  };
  media: Record<string, MediaAssetViewModel>;
  navigation: NavigationAssignment[];
  bodyHtml?: string;
  expectContains: readonly string[];
}

function snapshot(): Record<string, string> {
  const snap: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, `${prefix}${e.name}/`);
      else snap[`${prefix}${e.name}`] = readFileSync(full, "utf8");
    }
  };
  for (const dir of ["templates", "components", "blocks"]) walk(join(THEME_DIR, dir), `${dir}/`);
  return snap;
}

test("corporate theme validates against the same contract as the reference theme", () => {
  const report = validateThemeDir(THEME_DIR, { capabilities: { "content.block_document": "1" } });
  assert.equal(report.theme, "acme-corporate-v1");
  assert.deepEqual(report.issues, []);
  assert.equal(report.ok, true);
  // Contract stays ^1.0 — no contract drift, no Core patch.
  const discovery = createThemeDiscovery(THEME_DIR);
  assert.equal(discovery.getManifest().theme_contract, "^1.0");
});

test("corporate design is expressed only through theme declarations", () => {
  const discovery = createThemeDiscovery(THEME_DIR);
  // Distinct placements/presets/settings versus the reference theme.
  const placements = discovery.listNavigationPlacements().map((p) => p.id);
  assert.ok(placements.includes("header.utility"));
  assert.ok(discovery.listMediaPresets().some((p) => p.id === "hero-wide"));
  const settings = discovery.getThemeSettingsSchema() as { key: string }[];
  assert.ok(settings.some((s) => s.key === "topbar_phone"));
  // …while every mandatory block stays supported on the same type@version keys.
  assert.equal(discovery.listBlockRenderers().length, 17);
});

test("corporate content validates against the corporate theme (site validate)", () => {
  const manifestResult = JSON.parse(readFileSync(join(THEME_DIR, "theme.json"), "utf8")) as never;
  const contentTypes = (
    JSON.parse(
      readFileSync(join(THEME_DIR, "fixtures", "corporate-content-types.json"), "utf8"),
    ) as {
      contentTypes: { key: string; version: number; fields: Record<string, unknown> }[];
    }
  ).contentTypes.map((ct) => ({
    key: ct.key,
    version: ct.version,
    fieldIds: Object.keys(ct.fields),
  }));
  const entries = [
    "corporate-home",
    "corporate-service",
    "corporate-case",
    "corporate-news",
    "corporate-article",
  ].map((name) => {
    const fixture = JSON.parse(
      readFileSync(join(THEME_DIR, "fixtures", `${name}.json`), "utf8"),
    ) as Fixture;
    return {
      id: fixture.name,
      contentTypeKey: fixture.entry.contentTypeKey,
      contentTypeVersion: fixture.entry.contentTypeVersion,
      templateKey: fixture.entry.templateKey,
      fieldIds: Object.keys(fixture.entry.fields),
      blocks: [],
    };
  });
  const report = validateSiteAgainstTheme(manifestResult, contentTypes, entries, { globals: [] });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("corporate fixtures render with the corporate look (no Core involvement)", async () => {
  const manifestResult = JSON.parse(readFileSync(join(THEME_DIR, "theme.json"), "utf8")) as never;
  const preview = createThemePreview({ manifest: manifestResult, snapshot: snapshot() });
  const fixturesDir = join(THEME_DIR, "fixtures");
  for (const file of readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".json") && !f.includes("content-types"))
    .sort()) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as Fixture;
    const bodyHtml =
      fixture.bodyHtml ??
      (typeof fixture.entry.fields.body === "object" && fixture.entry.fields.body !== null
        ? renderRichText(fixture.entry.fields.body).html
        : undefined);
    const html = await preview.renderEntry(
      {
        templateKey: fixture.entry.templateKey,
        contentTypeKey: fixture.entry.contentTypeKey,
        contentTypeVersion: fixture.entry.contentTypeVersion,
        title: fixture.entry.title,
        fields: fixture.entry.fields,
        blocks: fixture.entry.blocks,
        mediaMap: fixture.media,
        ...(bodyHtml === undefined ? {} : { bodyHtml }),
      },
      { siteName: "Acme Корпорация", navigationAssignments: fixture.navigation },
    );
    for (const marker of fixture.expectContains) {
      assert.ok(html.includes(marker), `corporate fixture "${fixture.name}" misses: ${marker}`);
    }
  }
  // Corporate-specific structure markers.
  const home = await preview.renderEntry(
    {
      templateKey: "page-default",
      contentTypeKey: "page",
      contentTypeVersion: 1,
      title: "Главная",
      fields: { title: "Главная" },
      blocks: [],
    },
    { siteName: "Acme Корпорация", navigationAssignments: [] },
  );
  assert.match(home, /class="topbar"/);
  assert.match(home, /site-header__inner/);
});
