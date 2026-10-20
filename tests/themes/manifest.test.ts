// theme.json manifest schema tests (PCMS-THEME-T002).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseThemeManifest,
  THEME_MANIFEST_JSON_SCHEMA,
  ThemeError,
  validateThemeManifest,
} from "@pcms/themes";

/** Minimal structurally-valid manifest used as the mutation base. */
function validManifest(): Record<string, unknown> {
  return {
    id: "reference-theme-v1",
    name: "Progressive Reference",
    version: "1.0.0",
    theme_contract: "^1.0",
    templates: [
      {
        id: "page-default",
        file: "templates/page-default.liquid",
        accepts_content_types: ["page@1"],
        required_fields: ["title"],
      },
    ],
    components: [{ id: "header", file: "components/header.liquid" }],
    block_renderers: [{ block: "text@1", file: "blocks/text.liquid" }],
    navigation_placements: [
      {
        id: "header.primary",
        required: true,
        max_depth: 3,
        supported_item_types: ["internal_entry", "external_url", "group"],
      },
    ],
    media_presets: [{ id: "hero", width: 1600, height: 900, fit: "cover", quality: 82 }],
    settings_schema: [
      { key: "primary_color", type: "color", default: "#0f62fe", token: "--color-primary" },
    ],
  };
}

function codes(result: ReturnType<typeof validateThemeManifest>): string[] {
  assert.equal(result.ok, false, "expected validation failure");
  return result.issues.map((i) => i.code);
}

/** First entry of a manifest section as a mutable record (fixtures guarantee one). */
function firstItem(manifest: Record<string, unknown>, key: string): Record<string, unknown> {
  const item = (manifest[key] as Record<string, unknown>[])[0];
  assert.ok(item, `fixture needs at least one ${key} entry`);
  return item;
}

test("schema document itself is versioned and published under a stable $id", () => {
  assert.equal(
    THEME_MANIFEST_JSON_SCHEMA.$id,
    "https://progressive-cms.dev/schemas/theme-manifest-v2.json",
  );
});

test("a structurally complete manifest passes", () => {
  const full = {
    ...validManifest(),
    description: "Reference theme",
    cms_compatibility: ">=1.0",
    requires: { "content.block_document": ">=1.0", "blocks.gallery": ">=1.0" },
    capabilities: ["mobile_menu", "gallery_lightbox"],
    directories: ["locales", "tests"],
    components: [
      { id: "header", file: "components/header.liquid" },
      { id: "service-card", file: "components/service-card.liquid" },
    ],
    block_renderers: [
      { block: "text@1", file: "blocks/text.liquid" },
      { block: "cta@1", file: "blocks/cta.liquid", variants: ["inline", "wide", "accent"] },
    ],
    navigation_placements: [
      {
        id: "header.primary",
        required: true,
        max_depth: 3,
        supported_item_types: ["internal_entry", "external_url", "group"],
        fallback: "header.mobile",
        supports_mega_menu: false,
      },
      { id: "header.mobile", max_depth: 2, supported_item_types: ["internal_entry", "group"] },
    ],
    media_presets: [
      {
        id: "hero",
        width: 1600,
        height: 900,
        fit: "cover",
        crop: "entropy",
        formats: ["avif", "webp"],
        quality: 82,
        loading: "eager",
      },
      { id: "thumbnail", width: 96 },
    ],
    settings_schema: [
      {
        key: "primary_color",
        type: "color",
        default: "#0f62fe",
        token: "--color-primary",
        label: "Main color",
      },
      { key: "sticky_header", type: "boolean", default: true },
      { key: "header_variant", type: "enum", default: "default", choices: ["default", "compact"] },
      { key: "container_width", type: "number", default: 1200, min: 800, max: 1600 },
      { key: "logo", type: "media", default: "assets/img/logo.svg", token: "--logo-url" },
    ],
    assets: {
      css: ["assets/css/theme.css"],
      js: ["assets/js/theme.js"],
      fingerprint: true,
      csp: { frame_src: ["https://www.youtube-nocookie.com"], img_src: ["'self'"] },
    },
  };
  const result = validateThemeManifest(full);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test("unknown and missing top-level keys are rejected with the stable schema code", () => {
  assert.deepEqual(codes(validateThemeManifest({ ...validManifest(), extra: true })), [
    "THEME_MANIFEST_INVALID",
  ]);
  const missing = validManifest();
  delete missing.block_renderers;
  assert.deepEqual(codes(validateThemeManifest(missing)), ["THEME_MANIFEST_INVALID"]);
  assert.deepEqual(codes(validateThemeManifest(42)), ["THEME_MANIFEST_INVALID"]);
});

test("invalid identity/version/contract shapes are rejected", () => {
  assert.ok(
    codes(validateThemeManifest({ ...validManifest(), id: "Bad_Id" })).includes(
      "THEME_MANIFEST_INVALID",
    ),
  );
  assert.ok(
    codes(validateThemeManifest({ ...validManifest(), version: "1.0" })).includes(
      "THEME_MANIFEST_INVALID",
    ),
  );
  assert.ok(
    codes(validateThemeManifest({ ...validManifest(), theme_contract: "not-semver" })).includes(
      "THEME_VERSION_RANGE_INVALID",
    ),
  );
});

test("SemVer compatibility accepts a compound range with the active release candidate", () => {
  assert.equal(
    validateThemeManifest({
      ...validManifest(),
      cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
    }).ok,
    true,
  );
  assert.ok(
    codes(validateThemeManifest({ ...validManifest(), cms_compatibility: "not-semver" })).includes(
      "THEME_VERSION_RANGE_INVALID",
    ),
  );
});

test("template/component/placement/preset/setting/renderer ids must be unique", () => {
  const dupTemplate = validManifest();
  (dupTemplate.templates as unknown[]).push((dupTemplate.templates as unknown[])[0]);
  assert.ok(codes(validateThemeManifest(dupTemplate)).includes("THEME_TEMPLATE_ID_DUPLICATE"));

  const dupPlacement = validManifest();
  (dupPlacement.navigation_placements as unknown[]).push(
    JSON.parse(JSON.stringify((dupPlacement.navigation_placements as unknown[])[0])),
  );
  assert.ok(codes(validateThemeManifest(dupPlacement)).includes("THEME_PLACEMENT_ID_DUPLICATE"));

  const dupRenderer = validManifest();
  (dupRenderer.block_renderers as unknown[]).push((dupRenderer.block_renderers as unknown[])[0]);
  assert.ok(
    codes(validateThemeManifest(dupRenderer)).includes("THEME_BLOCK_RENDERER_ID_DUPLICATE"),
  );
});

test("default extension-view layout must reference a declared theme component", () => {
  const valid = validateThemeManifest({
    ...validManifest(),
    layout: { default: "header" },
  });
  assert.equal(valid.ok, true);

  const invalid = validateThemeManifest({ ...validManifest(), layout: { default: "missing" } });
  assert.deepEqual(codes(invalid), ["THEME_LAYOUT_COMPONENT_UNKNOWN"]);
});

test("file paths cannot escape the theme directory", () => {
  const escapePath = validManifest();
  firstItem(escapePath, "templates").file = "templates/a/../evil.liquid";
  assert.deepEqual(codes(validateThemeManifest(escapePath)), ["THEME_FILE_PATH_INVALID"]);
});

test("placement fallback must reference a declared placement and not itself", () => {
  const unknownFallback = validManifest();
  firstItem(unknownFallback, "navigation_placements").fallback = "footer.missing";
  assert.ok(
    codes(validateThemeManifest(unknownFallback)).includes("THEME_PLACEMENT_FALLBACK_UNKNOWN"),
  );

  const selfFallback = validManifest();
  firstItem(selfFallback, "navigation_placements").fallback = "header.primary";
  assert.ok(codes(validateThemeManifest(selfFallback)).includes("THEME_PLACEMENT_FALLBACK_SELF"));
});

test("enum settings must declare choices and a default within them", () => {
  const noChoices = validManifest();
  Object.assign(firstItem(noChoices, "settings_schema"), {
    key: "header_variant",
    type: "enum",
    default: "default",
  });
  assert.ok(codes(validateThemeManifest(noChoices)).includes("THEME_MANIFEST_INVALID"));

  const badDefault = validManifest();
  Object.assign(firstItem(badDefault, "settings_schema"), {
    key: "header_variant",
    type: "enum",
    default: "mega",
    choices: ["default", "compact"],
  });
  assert.deepEqual(codes(validateThemeManifest(badDefault)), ["THEME_SETTING_DEFAULT_INVALID"]);
});

test("color/media settings must target a documented token", () => {
  const untokened = validManifest();
  delete firstItem(untokened, "settings_schema").token;
  assert.ok(codes(validateThemeManifest(untokened)).includes("THEME_MANIFEST_INVALID"));
});

test("parseThemeManifest reports non-JSON as a stable error", () => {
  assert.throws(
    () => parseThemeManifest("{nope"),
    (err: unknown) => err instanceof ThemeError && err.code === "THEME_MANIFEST_INVALID",
  );
});
