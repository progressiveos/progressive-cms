// Candidate theme preview context tests (PCMS-THEME-T021).
// Preview without activation: the same entry renders against several
// candidate themes from pure inputs — no activation state anywhere.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createThemePreview,
  type NavigationAssignment,
  parseThemeManifest,
  type ThemeManifest,
} from "@pcms/themes";

function manifestOf(value: Record<string, unknown>): ThemeManifest {
  const result = parseThemeManifest(JSON.stringify(value));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  return result.value;
}

const ENTRY = {
  templateKey: "page-default",
  contentTypeKey: "page",
  contentTypeVersion: 1,
  title: "Услуги",
  fields: { title: "Услуги", intro: "Preview intro" },
  blocks: [],
};

function theme(kind: "a" | "b"): ThemeManifest {
  return manifestOf({
    id: `candidate-${kind}`,
    name: `Candidate ${kind.toUpperCase()}`,
    version: "1.0.0",
    theme_contract: "^1.0",
    templates: [
      {
        id: "page-default",
        file: "templates/page-default.liquid",
        accepts_content_types: ["page@1"],
      },
    ],
    components: [],
    block_renderers: [{ block: "text@1", file: "blocks/text.liquid" }],
    navigation_placements: [
      {
        id: "header.primary",
        required: true,
        max_depth: 2,
        supported_item_types: ["internal_entry"],
      },
    ],
    media_presets: [{ id: "card", width: 800 }],
    settings_schema: [
      { key: "primary_color", type: "color", default: "#0f62fe", token: "--color-primary" },
    ],
  });
}

const SNAPSHOT_A = {
  "templates/page-default.liquid":
    "<main data-theme=a><h1>{{ entry.title }}</h1>{{ blocks_html }}</main>",
  "blocks/text.liquid": "<p>text-a</p>",
};
const SNAPSHOT_B = {
  "templates/page-default.liquid":
    "<main data-theme=b><h1>{{ entry.title }}</h1><style>{{ tokens_css }}</style>{{ blocks_html }}</main>",
  "blocks/text.liquid": "<p>text-b</p>",
  "tokens/base.json": JSON.stringify({ "color.primary": { value: "#0f62fe", type: "color" } }),
};

const NAV: NavigationAssignment[] = [
  {
    placement: "header.primary",
    items: [
      {
        type: "internal_entry",
        entry_id: "0198c0a9-8f7d-7cc0-9a2a-5f1e2d3c4b5a",
        title: "Home",
        href: "/",
        items: [],
      },
    ],
  },
];

test("preview renders without activation, against any candidate snapshot", async () => {
  const previewA = createThemePreview({ manifest: theme("a"), snapshot: SNAPSHOT_A });
  const previewB = createThemePreview({ manifest: theme("b"), snapshot: SNAPSHOT_B });
  const htmlA = await previewA.renderEntry(ENTRY, { siteName: "Акме", navigationAssignments: NAV });
  const htmlB = await previewB.renderEntry(ENTRY, { siteName: "Акме", navigationAssignments: NAV });
  assert.match(htmlA, /data-theme=a/);
  assert.match(htmlB, /data-theme=b/);
  assert.match(htmlA, /<h1>Услуги<\/h1>/);
  // No activation state was involved — pure function of inputs.
  assert.equal(previewA.themeId, "candidate-a");
  assert.equal(previewB.themeId, "candidate-b");
});

test("preview applies settings overrides to tokens and blocks render", async () => {
  const previewB = createThemePreview({
    manifest: theme("b"),
    snapshot: SNAPSHOT_B,
    settings: { primary_color: "#aa0000" },
  });
  const css = previewB.tokensCss([
    {
      name: "base",
      source: JSON.stringify({ "color.primary": { value: "#0f62fe", type: "color" } }),
    },
  ]);
  assert.match(css, /--color-primary: #aa0000;/);
  const withBlocks = {
    ...ENTRY,
    blocks: [
      { id: "t1", type: "text", schemaVersion: 1, variant: null, props: { x: 1 }, children: [] },
    ],
  };
  const html = await previewB.renderEntry(withBlocks, { siteName: "Акме" });
  assert.match(html, /<p>text-b<\/p>/);
  assert.match(html, /&lt;style&gt;|:root/);
});

test("preview enforces template acceptance before rendering", async () => {
  const previewA = createThemePreview({ manifest: theme("a"), snapshot: SNAPSHOT_A });
  assert.equal(previewA.checkAcceptance(ENTRY).ok, true);
  assert.equal(previewA.checkAcceptance({ ...ENTRY, templateKey: "nope" }).ok, false);
  await assert.rejects(
    () => previewA.renderEntry({ ...ENTRY, templateKey: "nope" }),
    /THEME_TEMPLATE_NOT_FOUND/,
  );
});
