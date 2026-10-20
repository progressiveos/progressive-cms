// Template loader/render service tests (PCMS-THEME-T005).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  createRenderService,
  loadTemplateSnapshot,
  parseThemeManifest,
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
  components: [{ id: "button", file: "components/button.liquid" }],
  block_renderers: [{ block: "text@1", file: "blocks/text.liquid" }],
  navigation_placements: [
    { id: "header.primary", max_depth: 2, supported_item_types: ["internal_entry"] },
  ],
  media_presets: [{ id: "card", width: 800 }],
  settings_schema: [],
});

function writeTheme(dir: string): void {
  mkdirSync(join(dir, "templates"), { recursive: true });
  mkdirSync(join(dir, "components"), { recursive: true });
  mkdirSync(join(dir, "blocks"), { recursive: true });
  writeFileSync(join(dir, "templates/page-default.liquid"), "<h1>{{ entry.title }}</h1>");
  writeFileSync(join(dir, "components/button.liquid"), "<button>{{ label }}</button>");
  writeFileSync(join(dir, "blocks/text.liquid"), "<p>{{ block_html }}</p>");
}

function makeService(devMode = false): RenderService {
  const dir = mkdtempSync(join(tmpdir(), "pcms-theme-"));
  writeTheme(dir);
  const { snapshot } = loadTemplateSnapshot(dir, [
    "templates/page-default.liquid",
    "components/button.liquid",
    "blocks/text.liquid",
  ]);
  return createRenderService({ manifest: MANIFEST, snapshot, devMode });
}

test("snapshot loader reads declared files and reports missing ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcms-theme-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeTheme(dir);
  const { snapshot, missing } = loadTemplateSnapshot(dir, [
    "templates/page-default.liquid",
    "templates/nope.liquid",
    "../../outside.liquid",
  ]);
  assert.deepEqual(missing, ["templates/nope.liquid", "../../outside.liquid"]);
  assert.match(snapshot["templates/page-default.liquid"] ?? "", /<h1>/);
});

test("renderTemplate renders by logical template ID", async () => {
  const service = makeService();
  const html = await service.renderTemplate("page-default", { entry: { title: "Привет & <b>" } });
  assert.equal(html, "<h1>Привет &amp; &lt;b&gt;</h1>");
  assert.equal(service.hasTemplate("page-default"), true);
  assert.equal(service.hasTemplate("nope"), false);
});

test("unknown template IDs and missing sources fail with stable codes", async () => {
  const service = makeService();
  await assert.rejects(
    () => service.renderTemplate("nope", {}),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_TEMPLATE_NOT_FOUND",
  );
  const empty = createRenderService({ manifest: MANIFEST, snapshot: {} });
  await assert.rejects(
    () => empty.renderTemplate("page-default", {}),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_TEMPLATE_NOT_FOUND",
  );
});

test("render errors carry safe diagnostics in production mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pcms-theme-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "templates"), { recursive: true });
  writeFileSync(
    join(dir, "templates/page-default.liquid"),
    "{{ 1 | divided_by: zeroVar | nosuch }}",
  );
  const { snapshot } = loadTemplateSnapshot(dir, ["templates/page-default.liquid"]);
  const service = createRenderService({ manifest: MANIFEST, snapshot, devMode: false });
  await assert.rejects(
    () => service.renderTemplate("page-default", {}, { entryId: "entry-1" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const themeErr = err as Error & {
        code: string;
        details: Record<string, unknown>;
        stack?: string;
      };
      assert.equal(themeErr.code, "THEME_TEMPLATE_RENDER_FAILED");
      assert.equal(themeErr.details.entryId, "entry-1");
      assert.equal(themeErr.details.file, "templates/page-default.liquid");
      assert.ok(themeErr.cause === undefined, "production errors must not carry the engine cause");
      return true;
    },
  );
});

test("components render through the same engine (PCMS-THEME-T007 baseline)", async () => {
  const service = makeService();
  const html = await service.renderComponent("components/button.liquid", { label: "Send & go" });
  assert.equal(html, "<button>Send &amp; go</button>");
  await assert.rejects(
    () => service.renderComponent("components/nope.liquid", {}),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_TEMPLATE_NOT_FOUND",
  );
});

test("dev mode attaches the engine cause for developer diagnostics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pcms-theme-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "templates"), { recursive: true });
  writeFileSync(join(dir, "templates/page-default.liquid"), "{{ 1 | nosuchfilter }}");
  const { snapshot } = loadTemplateSnapshot(dir, ["templates/page-default.liquid"]);
  const service = createRenderService({ manifest: MANIFEST, snapshot, devMode: true });
  await assert.rejects(
    () => service.renderTemplate("page-default", {}),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.notEqual((err as Error & { cause?: unknown }).cause, undefined);
      return true;
    },
  );
});

test("parseThemeManifest stays importable from the same entry (smoke)", () => {
  assert.equal(typeof parseThemeManifest, "function");
});
