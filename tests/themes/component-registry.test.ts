// Component include/render contract tests (PCMS-THEME-T007).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  type ComponentRegistry,
  createComponentRegistry,
  createRenderService,
  loadTemplateSnapshot,
  type RenderService,
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
  components: [
    { id: "button", file: "components/button.liquid" },
    { id: "breadcrumbs", file: "components/breadcrumbs.liquid" },
  ],
  block_renderers: [{ block: "text@1", file: "blocks/text.liquid" }],
  navigation_placements: [
    { id: "header.primary", max_depth: 2, supported_item_types: ["internal_entry"] },
  ],
  media_presets: [{ id: "card", width: 800 }],
  settings_schema: [],
});

function makeTheme(): { service: RenderService; components: ComponentRegistry; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pcms-components-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "templates"), { recursive: true });
  mkdirSync(join(dir, "components"), { recursive: true });
  mkdirSync(join(dir, "blocks"), { recursive: true });
  writeFileSync(
    join(dir, "components/button.liquid"),
    '{% if href %}<a class="btn" href="{{ href }}">{{ label }}</a>{% else %}<button class="btn">{{ label }}</button>{% endif %}',
  );
  writeFileSync(
    join(dir, "components/breadcrumbs.liquid"),
    "<nav>{% for c in items %}<span>{{ c }}</span>{% endfor %}</nav>",
  );
  writeFileSync(
    join(dir, "templates/page-default.liquid"),
    "<main>{{ include_button }}{% include 'components/button.liquid' %}</main>",
  );
  const { snapshot } = loadTemplateSnapshot(dir, [
    "templates/page-default.liquid",
    "components/button.liquid",
    "components/breadcrumbs.liquid",
  ]);
  const service = createRenderService({ manifest: MANIFEST, snapshot });
  return { service, components: createComponentRegistry(MANIFEST, service), dir };
}

test("components resolve deterministically from manifest IDs", () => {
  const { components } = makeTheme();
  assert.deepEqual(
    components.listComponents(),
    [
      { id: "breadcrumbs", file: "components/breadcrumbs.liquid" },
      { id: "button", file: "components/button.liquid" },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.equal(components.getComponentFile("button"), "components/button.liquid");
  assert.equal(components.getComponentFile("nope"), null);
});

test("registry render by logical ID and inline include produce identical output", async () => {
  const { components, service } = makeTheme();
  const viaRegistry = await components.renderComponent("button", { label: "Записаться" });
  assert.equal(viaRegistry, '<button class="btn">Записаться</button>');

  // The same component inlined by a template resolves to the same file.
  const page = await service.renderTemplate("page-default", {
    include_button: "",
    label: "Записаться",
  });
  assert.match(page, /<button class="btn">Записаться<\/button>/);
});

test("component scope is plain data; hostile values stay escaped", async () => {
  const { components } = makeTheme();
  const html = await components.renderComponent("button", {
    label: "<script>x</script>",
    href: "/a?b=1&c=2",
  });
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="\/a\?b=1&amp;c=2"/);
});

test("unknown component ID fails with a stable code", async () => {
  const { components } = makeTheme();
  await assert.rejects(
    () => components.renderComponent("nope", {}),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_COMPONENT_NOT_FOUND",
  );
});
