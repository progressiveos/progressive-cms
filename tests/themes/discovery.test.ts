// Theme Developer Agent discovery hooks tests (PCMS-THEME-T026).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createThemeDiscovery } from "@pcms/themes";

const THEME_DIR = "themes/reference-theme-v1";
const discovery = createThemeDiscovery(THEME_DIR);

test("agent reads the declared contract without guessing from sources", () => {
  assert.equal(discovery.getThemeId(), "reference-theme-v1");
  assert.equal(discovery.getThemeContractVersion(), "1.0.0");
  const templates = discovery.listTemplates();
  assert.ok(
    templates.some(
      (t) => t.id === "service-default" && t.accepts_content_types.includes("service@1"),
    ),
  );
  const renderers = discovery.listBlockRenderers();
  assert.equal(
    renderers.length,
    21,
    "17 mandatory + form/quiz (M12) + video_gallery/audio (0.1.133)",
  );
  assert.ok(renderers.find((r) => r.block === "cta@1")?.variants?.includes("accent"));
  const placements = discovery.listNavigationPlacements();
  assert.ok(placements.some((p) => p.id === "header.mobile" && p.fallback === null));
  const presets = discovery.listMediaPresets();
  assert.ok(presets.some((p) => p.id === "hero"));
});

test("settings schema and token split are discoverable", () => {
  const settings = discovery.getThemeSettingsSchema() as { key: string; type: string }[];
  assert.ok(settings.some((s) => s.key === "primary_color" && s.type === "color"));
  const tokens = discovery.describeTokens();
  assert.ok(tokens.public.includes("color.primary"));
  assert.ok(tokens.public.every((k) => !k.startsWith("debug.")));
});

test("describeTheme returns a deterministic machine-readable snapshot", () => {
  const a = discovery.describeTheme();
  const b = discovery.describeTheme();
  assert.deepEqual(a, b);
  const keys = Object.keys(a).sort();
  assert.deepEqual(keys, [
    "block_renderers",
    "components",
    "manifest",
    "media_presets",
    "navigation_placements",
    "settings_schema",
    "templates",
    "theme_contract_version",
    "tokens",
    "validation",
  ]);
});

test("discovery surfaces validation without running a render", () => {
  const report = discovery.validate();
  assert.equal(report.theme, "reference-theme-v1");
  assert.equal(report.ok, true);
});
