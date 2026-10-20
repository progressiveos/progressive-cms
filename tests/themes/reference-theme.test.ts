// Reference theme proof (PCMS-THEME-T022): contract validation + rendering
// of every fixture (all 17 mandatory blocks, placements, settings, media).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createThemePreview,
  type MediaAssetViewModel,
  type NavigationAssignment,
  renderRichText,
  type ThemeManifest,
  validateThemeDir,
  validateThemeManifest,
} from "@pcms/themes";

const THEME_DIR = "themes/reference-theme-v1";
const MANDATORY_V1 = [
  "text",
  "heading",
  "image",
  "gallery",
  "quote",
  "callout",
  "list",
  "table",
  "code",
  "faq",
  "cta",
  "video",
  "calculator",
  "map",
  "timeline",
  "documents",
  "related_content",
];

interface Fixture {
  readonly name: string;
  readonly entry: {
    templateKey: string;
    contentTypeKey: string;
    contentTypeVersion: number;
    title: string;
    fields: Record<string, unknown>;
    blocks: Parameters<ReturnType<typeof createThemePreview>["blocks"]["renderBlockDocument"]>[0];
  };
  readonly media: Record<string, MediaAssetViewModel>;
  readonly navigation: NavigationAssignment[];
  readonly globals: Record<string, unknown>;
  readonly bodyHtml?: string;
  readonly expectContains: readonly string[];
}

function loadFixtures(): Fixture[] {
  const dir = join(THEME_DIR, "fixtures");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture);
}

test("reference theme passes cms theme validate", () => {
  const report = validateThemeDir(THEME_DIR, {
    capabilities: {
      "content.block_document": "1",
      "navigation.placements": "1",
      "media.presets": "1",
    },
  });
  assert.equal(report.theme, "reference-theme-v1");
  assert.deepEqual(report.issues, []);
  assert.equal(report.ok, true);
});

test("manifest maps every mandatory v1 block and declares the spec placements", () => {
  const manifestResult = validateThemeManifest(
    JSON.parse(readFileSync(join(THEME_DIR, "theme.json"), "utf8")),
  );
  assert.equal(manifestResult.ok, true);
  if (!manifestResult.ok) return;
  const manifest: ThemeManifest = manifestResult.value;
  const mapped = new Set(manifest.block_renderers.map((r) => r.block.split("@")[0]));
  for (const type of MANDATORY_V1) assert.ok(mapped.has(type), `missing renderer: ${type}`);
  const placements = manifest.navigation_placements.map((p) => p.id);
  for (const placement of [
    "header.primary",
    "header.compact",
    "header.mobile",
    "header.utility",
    "footer.primary",
    "footer.legal",
  ]) {
    assert.ok(placements.includes(placement), `missing placement: ${placement}`);
  }
  const presets = manifest.media_presets.map((p) => p.id);
  for (const preset of ["hero", "card", "thumbnail", "gallery", "social-display"]) {
    assert.ok(presets.includes(preset), `missing media preset: ${preset}`);
  }
});

test("every fixture renders and contains its expected markers", async () => {
  const manifestResult = validateThemeManifest(
    JSON.parse(readFileSync(join(THEME_DIR, "theme.json"), "utf8")),
  );
  assert.ok(manifestResult.ok);
  if (!manifestResult.ok) return;
  const preview = createThemePreview({ manifest: manifestResult.value, snapshot: readSnapshot() });
  const rendered: string[] = [];
  for (const fixture of loadFixtures()) {
    const bodyHtml =
      fixture.bodyHtml ??
      (fixture.entry.fields.body !== undefined &&
      typeof fixture.entry.fields.body === "object" &&
      fixture.entry.fields.body !== null &&
      "type" in (fixture.entry.fields.body as object)
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
      { siteName: "Акме", navigationAssignments: fixture.navigation },
    );
    for (const marker of fixture.expectContains) {
      assert.ok(html.includes(marker), `fixture "${fixture.name}" misses marker: ${marker}`);
    }
    rendered.push(fixture.name);
  }
  // Full mandatory-block coverage across fixtures.
  const allHtml = rendered.join(",");
  assert.equal(rendered.length, loadFixtures().length);
  assert.ok(allHtml.length > 0);
});

let snapshotCache: Record<string, string> | null = null;
function readSnapshot(): Record<string, string> {
  if (snapshotCache !== null) return snapshotCache;
  const snapshot: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else snapshot[`${prefix}${entry.name}`] = readFileSync(full, "utf8");
    }
  };
  for (const dir of ["templates", "components", "blocks"]) {
    walk(join(THEME_DIR, dir), `${dir}/`);
  }
  snapshotCache = snapshot;
  return snapshot;
}

test("all 17 mandatory blocks render through the reference theme renderers", async () => {
  const manifestResult = validateThemeManifest(
    JSON.parse(readFileSync(join(THEME_DIR, "theme.json"), "utf8")),
  );
  assert.ok(manifestResult.ok);
  if (!manifestResult.ok) return;
  const preview = createThemePreview({ manifest: manifestResult.value, snapshot: readSnapshot() });
  const media = {
    "018f6d2c-5f31-7abc-8def-2a3b4c5d6e01": {
      id: "018f6d2c-5f31-7abc-8def-2a3b4c5d6e01",
      alt: "Тестовое фото",
      width: 4000,
      height: 3000,
      derivatives: [
        { preset: "hero", url: "/media/1-hero.avif", width: 1600, height: 900 },
        { preset: "card", url: "/media/1-card.webp", width: 800, height: 600 },
        { preset: "thumbnail", url: "/media/1-thumb.webp", width: 96, height: 96 },
        { preset: "gallery", url: "/media/1-gallery.webp", width: 1200, height: 900 },
        { preset: "social-display", url: "/media/1-social.webp", width: 1200, height: 630 },
      ],
    } satisfies MediaAssetViewModel,
  };
  const rich = (text: string) => ({
    schema_version: 2,
    type: "document",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  const blocks = [
    {
      id: "b1",
      type: "text",
      schemaVersion: 1,
      variant: null,
      props: { rich_text: rich("текст") },
      children: [],
    },
    {
      id: "b2",
      type: "heading",
      schemaVersion: 1,
      variant: null,
      props: { level: 2, text: "Заголовок" },
      children: [],
    },
    {
      id: "b3",
      type: "image",
      schemaVersion: 1,
      variant: null,
      props: { media_id: "018f6d2c-5f31-7abc-8def-2a3b4c5d6e01" },
      children: [],
    },
    {
      id: "b4",
      type: "gallery",
      schemaVersion: 1,
      variant: null,
      props: {
        items: [{ id: "g1", media_id: "018f6d2c-5f31-7abc-8def-2a3b4c5d6e01" }],
        lightbox_enabled: true,
      },
      children: [],
    },
    {
      id: "b5",
      type: "quote",
      schemaVersion: 1,
      variant: null,
      props: { rich_text: rich("цитата"), author: "Автор" },
      children: [],
    },
    {
      id: "b6",
      type: "callout",
      schemaVersion: 1,
      variant: null,
      props: { kind: "warning", body: rich("внимание") },
      children: [],
    },
    {
      id: "b7",
      type: "list",
      schemaVersion: 1,
      variant: null,
      props: { items: [{ title: "пункт" }] },
      children: [],
    },
    {
      id: "b8",
      type: "table",
      schemaVersion: 1,
      variant: null,
      props: { columns: [{ key: "a", title: "А" }], rows: [["1"]] },
      children: [],
    },
    {
      id: "b9",
      type: "code",
      schemaVersion: 1,
      variant: null,
      props: { language: "js", code: "let x = 1;" },
      children: [],
    },
    {
      id: "b10",
      type: "faq",
      schemaVersion: 1,
      variant: null,
      props: { items: [{ id: "q1", question: "Вопрос?", answer: rich("Ответ.") }] },
      children: [],
    },
    {
      id: "b11",
      type: "cta",
      schemaVersion: 1,
      variant: "accent",
      props: { title: "CTA", primary_action: { type: "phone", phone: "+7 900 000-00-00" } },
      children: [],
    },
    {
      id: "b12",
      type: "video",
      schemaVersion: 1,
      variant: null,
      props: { provider: "youtube", video_id: "abcdefghijk" },
      children: [],
    },
    {
      id: "b13",
      type: "calculator",
      schemaVersion: 1,
      variant: null,
      props: {
        inputs: [{ key: "area", label: "Площадь", type: "number", default: 50 }],
        formula: "area*2",
        outputs: [{ label: "Итог", digits: 0 }],
      },
      children: [],
    },
    {
      id: "b14",
      type: "map",
      schemaVersion: 1,
      variant: null,
      props: { markers: [{ id: "m1", title: "Офис", lat: 55.75, lon: 37.61 }] },
      children: [],
    },
    {
      id: "b15",
      type: "timeline",
      schemaVersion: 1,
      variant: null,
      props: { items: [{ id: "t1", date: "2026-01-01", title: "Событие" }] },
      children: [],
    },
    {
      id: "b16",
      type: "documents",
      schemaVersion: 1,
      variant: null,
      props: {
        items: [
          { id: "d1", media_id: "018f6d2c-5f31-7abc-8def-2a3b4c5d6e01", display_title: "Файл" },
        ],
      },
      children: [],
    },
    {
      id: "b17",
      type: "related_content",
      schemaVersion: 1,
      variant: null,
      props: { mode: "manual", entry_ids: ["018f6d2c-5f31-7abc-8def-2a3b4c5d6e10"] },
      children: [],
    },
  ];
  const html = await preview.renderEntry(
    {
      templateKey: "page-default",
      contentTypeKey: "page",
      contentTypeVersion: 1,
      title: "Все блоки",
      fields: { title: "Все блоки" },
      blocks,
      mediaMap: media,
    },
    { siteName: "Акме", navigationAssignments: [] },
  );
  const expected = [
    "текст",
    "<h2",
    "1-card.webp",
    "data-lightbox",
    "<blockquote",
    "block-callout--warning",
    "пункт",
    "<table",
    "let x = 1;",
    "Вопрос?",
    "block-cta--accent",
    "youtube-nocookie.com",
    "data-calculator",
    "map-shell",
    "Событие",
    "Файл",
    "related",
  ];
  for (const marker of expected)
    assert.ok(html.includes(marker), `missing block marker: ${marker}`);
});

test("assets, settings and fixtures satisfy the human-maintainability layout", () => {
  for (const file of [
    "theme.json",
    "README.md",
    "THEME.md",
    "CHANGELOG.md",
    "assets/css/theme.css",
    "assets/js/theme.js",
    "assets/img/logo.svg",
    "tokens/base.json",
  ]) {
    assert.ok(readFileSync(join(THEME_DIR, file), "utf8").length > 0, `empty/missing: ${file}`);
  }
});
