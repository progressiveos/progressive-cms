// Unsupported block/variant diagnostics tests (PCMS-THEME-T009).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BlockNodeViewModel,
  createBlockRendererRegistry,
  createRenderService,
  diagnoseBlockDocument,
  renderBlockDocumentWithDiagnostics,
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
  block_renderers: [
    { block: "text@1", file: "blocks/text.liquid" },
    { block: "columns@1", file: "blocks/columns.liquid" },
    { block: "cta@1", file: "blocks/cta.liquid", variants: ["inline", "wide"] },
  ],
  navigation_placements: [
    { id: "header.primary", max_depth: 2, supported_item_types: ["internal_entry"] },
  ],
  media_presets: [{ id: "card", width: 800 }],
  settings_schema: [],
});

const SNAPSHOT: Record<string, string> = {
  "blocks/text.liquid": "<p>{{ block.props.text }}</p>",
  "blocks/columns.liquid": '<div class="cols">{{ children }}</div>',
  "blocks/cta.liquid": '<a href="#" class="cta--{{ block.variant }}">{{ block.props.title }}</a>',
};

const registry = createBlockRendererRegistry(
  MANIFEST,
  createRenderService({ manifest: MANIFEST, snapshot: SNAPSHOT }),
);

function block(
  id: string,
  type: string,
  props: Record<string, unknown> = {},
  variant: string | null = null,
  children: BlockNodeViewModel[] = [],
): BlockNodeViewModel {
  return { id, type, schemaVersion: 1, variant, props, children };
}

test("diagnoseBlockDocument reports every unsupported node with its tree path", () => {
  const diagnostics = diagnoseBlockDocument(registry, [
    block("b1", "text", { text: "ok" }),
    block("b2", "cta", { title: "x" }, "mega"),
    block("b3", "columns", {}, null, [
      block("b4", "text", { text: "inner ok" }),
      block("b5", "form", {}),
    ]),
  ]);
  assert.deepEqual(
    diagnostics.map((d) => [d.code, d.path]),
    [
      ["THEME_BLOCK_VARIANT_UNSUPPORTED", "/blocks/1"],
      ["THEME_BLOCK_RENDERER_NOT_FOUND", "/blocks/2/children/1"],
    ],
  );
});

test("preview mode renders placeholders for unsupported blocks and keeps supported parents", async () => {
  const { html, diagnostics } = await renderBlockDocumentWithDiagnostics(registry, [
    block("b1", "text", { text: "hello" }),
    block("b2", "columns", {}, null, [
      block("b3", "form", {}),
      block("b4", "text", { text: "kept" }),
    ]),
  ]);
  const out = html.html;
  assert.match(out, /<p>hello<\/p>/);
  assert.match(out, /<div class="cols">/);
  assert.match(
    out,
    /data-pcms-diagnostic="unsupported-block" data-code="THEME_BLOCK_RENDERER_NOT_FOUND"/,
  );
  assert.match(out, /\[Unsupported block form — shown in preview only\]/);
  assert.match(out, /<p>kept<\/p>/);
  // Content is never silently dropped: every diagnostic is explicit.
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.blockId, "b3");
});

test("production render rejects unsupported blocks (validation error policy)", async () => {
  await assert.rejects(
    () => registry.renderBlock(block("b1", "cta", { title: "x" }, "mega")),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_BLOCK_VARIANT_UNSUPPORTED",
  );
  await assert.rejects(
    () => registry.renderBlock(block("b1", "form", {})),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_BLOCK_RENDERER_NOT_FOUND",
  );
  // ...and unsupported children fail the parent render too.
  await assert.rejects(
    () => registry.renderBlock(block("b1", "columns", {}, null, [block("b2", "form", {})])),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_BLOCK_RENDERER_NOT_FOUND",
  );
});

test("placeholder markup is escaped and bounded", async () => {
  const { html } = await renderBlockDocumentWithDiagnostics(registry, [
    block('b1" onload="x', "form", {}),
  ]);
  assert.doesNotMatch(html.html, /onload="x"/);
  assert.match(html.html, /data-code="THEME_BLOCK_RENDERER_NOT_FOUND"/);
});
