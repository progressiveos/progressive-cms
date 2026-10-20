// Media preset contract tests (PCMS-THEME-T015).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildImageModel,
  createMediaPresetRegistry,
  type MediaAssetViewModel,
  resolveDerivative,
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
    { id: "header.primary", max_depth: 2, supported_item_types: ["internal_entry"] },
  ],
  media_presets: [
    {
      id: "hero",
      width: 1600,
      height: 900,
      fit: "cover",
      formats: ["avif", "webp"],
      quality: 82,
      loading: "eager",
    },
    { id: "card", width: 800 },
    { id: "thumbnail", width: 96, height: 96, fit: "cover" },
  ],
  settings_schema: [],
});

const ASSET: MediaAssetViewModel = {
  id: "0198c0a9-8f7d-7cc0-9a2a-5f1e2d3c4b5a",
  alt: "Стройка",
  width: 4000,
  height: 3000,
  derivatives: [
    { preset: "hero", url: "/m/hero.avif", width: 1600, height: 900, mime: "image/avif" },
    { preset: "hero", url: "/m/hero.webp", width: 1600, height: 900, mime: "image/webp" },
    { preset: "card", url: "/m/card-800.avif", width: 800, height: 600, mime: "image/avif" },
    { preset: "card", url: "/m/card-800.webp", width: 800, height: 600, mime: "image/webp" },
    { preset: "thumbnail", url: "/m/thumb-96.webp", width: 96, height: 96, mime: "image/webp" },
    // Core derivative (og-v1): must never leak into a theme preset model.
    { preset: "og-v1", url: "/m/og-1200.jpeg", width: 1200, height: 630, mime: "image/jpeg" },
  ],
};

test("preset discovery is deterministic (Media module consumes it in M05)", () => {
  const registry = createMediaPresetRegistry(MANIFEST);
  assert.deepEqual(
    registry.listPresets().map((p) => p.id),
    ["card", "hero", "thumbnail"],
  );
  const hero = registry.listPresets().find((p) => p.id === "hero");
  assert.deepEqual(hero, {
    id: "hero",
    width: 1600,
    height: 900,
    fit: "cover",
    formats: ["avif", "webp"],
    loading: "eager",
  });
  assert.equal(registry.getPreset("nope"), null);
});

test("derivatives resolve by preset from the Media view model", () => {
  assert.equal(resolveDerivative(ASSET, "card")?.url, "/m/card-800.avif");
  assert.equal(resolveDerivative(ASSET, "social"), null);
});

test("buildImageModel produces ready-to-render image data without URL math", () => {
  const registry = createMediaPresetRegistry(MANIFEST);
  const model = buildImageModel(ASSET, "card", registry.getPreset("card"));
  assert.equal(model.src, "/m/card-800.avif");
  assert.equal(model.loading, "lazy");
  assert.equal(model.width, 800);
  assert.equal(model.alt, "Стройка");
  // Responsive candidates scope to the preset's OWN derivatives: no hero,
  // thumbnail or og-v1/core candidates, no cross-preset aspect ratios
  // (p-cms.com 0.1.162 audit — the srcset used to mix every other preset).
  assert.equal(model.srcset, "/m/card-800.avif 800w");
  assert.deepEqual(model.sources, [{ mime: "image/webp", srcset: "/m/card-800.webp 800w" }]);

  const hero = buildImageModel(ASSET, "hero", registry.getPreset("hero"));
  assert.equal(hero.loading, "eager", "hero preset declares above-the-fold eager loading");
  assert.equal(hero.srcset, "/m/hero.avif 1600w");
  assert.deepEqual(hero.sources, [{ mime: "image/webp", srcset: "/m/hero.webp 1600w" }]);
});

test("missing derivatives are loud, not silently degraded to originals", () => {
  assert.throws(
    () => buildImageModel(ASSET, "social-display"),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_MEDIA_PRESET_UNKNOWN",
  );
});
