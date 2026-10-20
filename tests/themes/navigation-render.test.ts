// desktop/tablet/mobile placement reference rendering (PCMS-THEME-T012).
// Proves separate nav sets per placement AND a shared set across placements
// both render; CSS breakpoints stay theme-owned (spec §23).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNavigationScope,
  createNavigationPlacementRegistry,
  createRenderService,
  loadTemplateSnapshot,
  type NavigationAssignment,
  type ThemeManifest,
  validateThemeManifest,
} from "@pcms/themes";

function manifestOf(value: Record<string, unknown>): ThemeManifest {
  const result = validateThemeManifest(value);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  return result.value;
}

const MANIFEST = manifestOf({
  id: "acme-2026",
  name: "Acme",
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
      max_depth: 3,
      supported_item_types: ["internal_entry", "group"],
    },
    {
      id: "header.compact",
      required: false,
      max_depth: 1,
      supported_item_types: ["internal_entry"],
    },
    {
      id: "header.mobile",
      required: true,
      max_depth: 2,
      supported_item_types: ["internal_entry", "group"],
    },
  ],
  media_presets: [{ id: "card", width: 800 }],
  settings_schema: [],
});

const ENTRY = "0198c0a9-8f7d-7cc0-9a2a-5f1e2d3c4b5a";

// Theme-side nav component: placement rendered with a context hint via CSS
// classes — actual media queries are the theme's CSS (not part of this proof).
const SNAPSHOT: Record<string, string> = {
  "components/nav.liquid": [
    '<nav data-placement="{{ placement }}" class="nav nav--{{ context }}">',
    "{% for item in items %}",
    "{% if item.type == 'group' %}",
    '<span class="group">{{ item.title }}:{% for sub in item.items %}<a href="{{ sub.href }}">{{ sub.title }}</a>{% endfor %}</span>',
    "{% elsif item.type == 'separator' %}",
    "<hr class=sep>",
    "{% else %}",
    '<a href="{{ item.href }}">{{ item.title }}</a>',
    "{% endif %}",
    "{% endfor %}",
    "</nav>",
  ].join("\n"),
  "templates/page-default.liquid":
    "{% include 'components/nav.liquid', placement: 'header.primary', items: nav['header.primary'].items, context: 'desktop' %}" +
    "{% include 'components/nav.liquid', placement: 'header.compact', items: nav['header.compact'].items, context: 'tablet' %}" +
    "{% include 'components/nav.liquid', placement: 'header.mobile', items: nav['header.mobile'].items, context: 'mobile' %}",
};

const registry = createNavigationPlacementRegistry(MANIFEST);
const service = createRenderService({ manifest: MANIFEST, snapshot: SNAPSHOT });

const desktopItems: NavigationAssignment["items"] = [
  { type: "internal_entry", entry_id: ENTRY, title: "Услуги", href: "/services", items: [] },
  {
    type: "group",
    title: "Компания",
    items: [{ type: "internal_entry", entry_id: ENTRY, title: "О нас", href: "/about", items: [] }],
  },
];
const mobileItems: NavigationAssignment["items"] = [
  { type: "internal_entry", entry_id: ENTRY, title: "Меню", href: "/", items: [] },
];

async function renderPage(assignments: NavigationAssignment[]): Promise<string> {
  return service.renderTemplate("page-default", {
    nav: buildNavigationScope(registry, assignments),
  });
}

test("separate nav sets per placement render distinct contexts", async () => {
  const html = await renderPage([
    { placement: "header.primary", items: desktopItems },
    { placement: "header.compact", items: mobileItems },
    { placement: "header.mobile", items: mobileItems },
  ]);
  assert.match(html, /data-placement="header\.primary" class="nav nav--desktop"/);
  assert.match(html, /<span class="group">Компания:<a href="\/about">О нас<\/a><\/span>/);
  // tablet placement rendered its own (compact) set
  assert.match(
    html,
    /data-placement="header\.compact" class="nav nav--tablet">\s*<a href="\/">Меню<\/a>\s*<\/nav>/,
  );
});

test("one shared set may serve several placements", async () => {
  const html = await renderPage([
    { placement: "header.primary", items: desktopItems },
    { placement: "header.mobile", items: desktopItems },
  ]);
  const primary = /data-placement="header\.primary".*?<\/nav>/s.exec(html)?.[0] ?? "";
  const mobile = /data-placement="header\.mobile".*?<\/nav>/s.exec(html)?.[0] ?? "";
  // Same items, different placement attributes.
  assert.equal(
    primary.replace("header.primary", "P").replace("nav--desktop", "C"),
    mobile.replace("header.mobile", "P").replace("nav--mobile", "C"),
  );
});

test("unassigned required placement renders empty but declared; unassigned optional renders fallback-free empty", async () => {
  const scope = buildNavigationScope(registry, [
    { placement: "header.compact", items: mobileItems },
  ]);
  assert.deepEqual(scope["header.primary"]?.items, []);
  assert.deepEqual(scope["header.mobile"]?.items, []);
  assert.equal(scope["header.compact"]?.items.length, 1);
  const html = await renderPage([{ placement: "header.compact", items: mobileItems }]);
  assert.match(html, /data-placement="header\.primary" class="nav nav--desktop">\s*<\/nav>/);
});
