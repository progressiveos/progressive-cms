// Block renderer registry tests (PCMS-THEME-T008) — all 17 mandatory v1
// Content blocks render through manifest-declared renderer templates.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BlockNodeViewModel,
  createBlockRendererRegistry,
  createRenderService,
  loadTemplateSnapshot,
  type RenderService,
  type ThemeManifest,
  validateThemeManifest,
} from "@pcms/themes";

const MANDATORY_V1: readonly string[] = [
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

function manifestOf(value: Record<string, unknown>): ThemeManifest {
  const result = validateThemeManifest(value);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  return result.value;
}

function makeManifest(
  extraRenderers: readonly { block: string; file: string }[] = [],
): ThemeManifest {
  return manifestOf({
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
    block_renderers: [
      // Real per-type templates for a few types; the rest share a generic
      // echo template proving the mapping (the reference theme, T022, gives
      // each block its real markup).
      { block: "text@1", file: "blocks/text.liquid" },
      { block: "cta@1", file: "blocks/cta.liquid", variants: ["inline", "wide", "accent"] },
      ...MANDATORY_V1.filter((t) => t !== "text" && t !== "cta").map((t) => ({
        block: `${t}@1`,
        file: "blocks/generic.liquid",
      })),
      ...extraRenderers,
    ],
    navigation_placements: [
      { id: "header.primary", max_depth: 2, supported_item_types: ["internal_entry"] },
    ],
    media_presets: [{ id: "card", width: 800 }],
    settings_schema: [],
  });
}

const MANIFEST = makeManifest();

function makeRegistry(
  blocks: Record<string, string>,
  extraRenderers: readonly { block: string; file: string }[] = [],
  actions?: Parameters<typeof createBlockRendererRegistry>[2],
): {
  registry: ReturnType<typeof createBlockRendererRegistry>;
  service: RenderService;
} {
  const snapshot: Record<string, string> = {
    "blocks/text.liquid": "<div class=richtext>{{ block.props.rich_text }}</div>",
    "blocks/cta.liquid":
      '<a class="cta cta--{{ block.variant | default: "inline" }}" href="#">{{ block.props.title }}</a>',
    "blocks/generic.liquid":
      '<section data-block="{{ block.type }}">{{ block.props.title | default: block.type }}</section>',
  };
  for (const [name, src] of Object.entries(blocks)) snapshot[name] = src;
  const manifest = extraRenderers.length === 0 ? MANIFEST : makeManifest(extraRenderers);
  const service = createRenderService({ manifest, snapshot });
  return { registry: createBlockRendererRegistry(manifest, service, actions), service };
}

function block(
  type: string,
  props: Record<string, unknown>,
  variant: string | null = null,
): BlockNodeViewModel {
  return { id: `b-${type}`, type, schemaVersion: 1, variant, props, children: [] };
}

test("every mandatory v1 block type has a manifest mapping and renders", async () => {
  const { registry } = makeRegistry({});
  const mapped = new Set(registry.listRenderers().map((r) => r.type));
  for (const type of MANDATORY_V1) {
    assert.equal(mapped.has(type), true, `missing renderer mapping: ${type}`);
  }
  const html = await registry.renderBlockDocument(
    MANDATORY_V1.map((type) => block(type, { title: `Title ${type}` })),
  );
  const out = html.html;
  assert.match(out, /<section data-block="heading">Title heading<\/section>/);
  assert.match(out, /<section data-block="calculator">Title calculator<\/section>/);
  assert.match(out, /<section data-block="related_content">Title related_content<\/section>/);
});

test("text and cta render through their dedicated templates", async () => {
  const { registry } = makeRegistry({});
  const text = await registry.renderBlock(block("text", { rich_text: "<p>hello</p>" }));
  assert.equal(text, "<div class=richtext>&lt;p&gt;hello&lt;/p&gt;</div>");
  const cta = await registry.renderBlock(block("cta", { title: "Buy & try" }, "accent"));
  assert.equal(cta, '<a class="cta cta--accent" href="#">Buy &amp; try</a>');
});

test("unsupported variants and unknown renderers are rejected", async () => {
  const { registry } = makeRegistry({});
  assert.equal(registry.resolveRenderer("text", 1)?.file, "blocks/text.liquid");
  assert.equal(registry.resolveRenderer("text", 2), null);

  const badVariant = registry.checkBlockSupport(block("cta", { title: "x" }, "mega"));
  assert.equal(badVariant?.code, "THEME_BLOCK_VARIANT_UNSUPPORTED");
  const noVariantSupport = registry.checkBlockSupport(block("text", {}, "wide"));
  assert.equal(noVariantSupport?.code, "THEME_BLOCK_VARIANT_UNSUPPORTED");
  const unknown = registry.checkBlockSupport(block("form", {}));
  assert.equal(unknown?.code, "THEME_BLOCK_RENDERER_NOT_FOUND");

  await assert.rejects(
    () => registry.renderBlock(block("cta", { title: "x" }, "mega")),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_BLOCK_VARIANT_UNSUPPORTED",
  );
  await assert.rejects(
    () => registry.renderBlock(block("nope", {})),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_BLOCK_RENDERER_NOT_FOUND",
  );
});

test("children render depth-first and arrive as trusted fragments", async () => {
  const { registry } = makeRegistry(
    {
      "blocks/columns.liquid": '<div class="cols">{{ children }}</div>',
      "blocks/generic.liquid":
        '<section data-block="{{ block.type }}">{{ block.props.title | default: block.type }}</section>',
    },
    [{ block: "columns@1", file: "blocks/columns.liquid" }],
  );
  const html = await registry.renderBlock({
    id: "b-columns",
    type: "columns",
    schemaVersion: 1,
    variant: null,
    props: {},
    children: [block("heading", { title: "inside" }), block("text", { rich_text: "x" })],
  });
  assert.equal(
    html,
    '<div class="cols"><section data-block="heading">inside</section>\n<div class=richtext>x</div></div>',
  );
});

test("typed actions in props get resolved hrefs injected (Content spec §47)", async () => {
  // 2026-10-01 prod defect: internal_entry actions rendered as href="#"
  // because the entry→route mapping is engine knowledge the theme lacks.
  const { registry } = makeRegistry(
    {
      "blocks/generic.liquid":
        "{% for item in block.props.items %}" +
        '<a href="{{ item.link.resolved.href | default: \'#\' }}" data-ext="{{ item.link.resolved.external }}">{{ item.link.anchor_text | default: "Подробнее" }}</a>{% endfor %}',
    },
    [],
    {
      async resolveAction(action) {
        if (action.type === "internal_entry" && action.entry_id === "e1") {
          return { href: "/development/" };
        }
        if (action.type === "external_url") {
          return { href: String(action.url), external: true };
        }
        return null; // unresolved (e.g. unrouted entry) → theme falls back
      },
    },
  );
  const html = await registry.renderBlock(
    block("list", {
      items: [
        {
          title: "Разработка",
          link: { type: "internal_entry", entry_id: "e1", anchor_text: "Заказать разработку" },
        },
        {
          title: "Внешнее",
          link: { type: "external_url", url: "https://x.example/", target: "_blank" },
        },
        { title: "Ссылка-пустышка", link: { type: "internal_entry", entry_id: "gone" } },
      ],
    }),
  );
  assert.match(html, /href="\/development\/"[^>]*>Заказать разработку<\/a>/);
  assert.match(html, /href="https:\/\/x\.example\/" data-ext="true"/);
  // Unresolved action: no injection, the template default wins.
  assert.match(html, /href="#"/);
});

test("without an action resolver props pass through untouched", async () => {
  const { registry } = makeRegistry({});
  const html = await registry.renderBlock(
    block("cta", { title: "t", primary_action: { type: "internal_entry", entry_id: "e1" } }),
  );
  assert.equal(html, '<a class="cta cta--inline" href="#">t</a>');
});

test("rich text props survive action resolution as HTML, not JSON (0.1.129 regression)", async () => {
  // renderRichTextInProps yields SafeHtml instances; the action resolver's
  // props walk must not clone them into plain {"html":…} objects — the
  // template output would serialize the wrapper instead of the HTML.
  const { registry } = makeRegistry(
    {
      "blocks/text.liquid":
        '{{ block.props.rich_text }}|<a href="{{ block.props.link.resolved.href }}">x</a>',
    },
    [],
    {
      async resolveAction(action) {
        if (action.type === "internal_entry" && action.entry_id === "e1") {
          return { href: "/development/" };
        }
        return null;
      },
    },
  );
  const html = await registry.renderBlock(
    block("text", {
      rich_text: {
        schema_version: 2,
        type: "document",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Привет" }] }],
      },
      link: { type: "internal_entry", entry_id: "e1" },
    }),
  );
  assert.ok(html.includes("<p>Привет</p>"), html);
  assert.ok(!html.includes('{"html"'), html);
  assert.ok(html.includes('href="/development/"'), html);
});

test("table@1 object cells render valid RichText as escaped semantic HTML", async () => {
  const { registry } = makeRegistry({
    "blocks/generic.liquid":
      "<table>{% for row in block.props.rows %}<tr>{% for cell in row %}<td>{{ cell }}</td>{% endfor %}</tr>{% endfor %}</table>",
  });
  const html = await registry.renderBlock(
    block("table", {
      rows: [
        [
          {
            schema_version: 2,
            type: "document",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "cell <script>alert(1)</script>" },
                  { type: "link", href: "/docs", content: [{ type: "text", text: "docs" }] },
                  {
                    type: "link",
                    href: "javascript:alert(1)",
                    content: [{ type: "text", text: "unsafe href" }],
                  },
                ],
              },
            ],
          },
        ],
      ],
    }),
  );
  // v2 rendering wraps every document in the canonical container class, so
  // the expected markup includes it (v1 rendered the fragment bare).
  assert.match(
    html,
    /<td><div class="pcms-richtext-document"><p>cell &lt;script&gt;alert\(1\)&lt;\/script&gt;<a href="\/docs">docs<\/a>unsafe href<\/p><\/div><\/td>/,
  );
  assert.doesNotMatch(html, /<script>/);
});
