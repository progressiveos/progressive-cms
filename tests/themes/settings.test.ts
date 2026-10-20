// Theme Settings schema + token override bridge tests (PCMS-THEME-T014).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTokenOverrides,
  parseTokensSource,
  resolveSettingsValues,
  type ThemeManifestSetting,
  tokenOverridesFromSettings,
  tokensToCss,
  unmatchedSettingTokens,
} from "@pcms/themes";

const SCHEMA: readonly ThemeManifestSetting[] = [
  { key: "sticky_header", type: "boolean", default: true },
  { key: "primary_color", type: "color", default: "#0f62fe", token: "--color-primary" },
  { key: "header_variant", type: "enum", default: "default", choices: ["default", "compact"] },
  { key: "container_width", type: "number", default: 1200, min: 800, max: 1600 },
  { key: "logo", type: "media", default: "assets/img/logo.svg", token: "--logo-url" },
  { key: "footer_note", type: "string" },
];

test("typed settings validate against the schema", () => {
  const good = resolveSettingsValues(SCHEMA, {
    sticky_header: false,
    primary_color: "#ff0000",
    header_variant: "compact",
    container_width: 1440,
    logo: "0198c0a9-8f7d-7cc0-9a2a-5f1e2d3c4b5a",
    footer_note: "© 2026",
  });
  assert.equal(good.ok, true, JSON.stringify(good.ok ? [] : good.issues));
  if (good.ok) {
    assert.equal(good.values.sticky_header, false);
    assert.equal(good.values.primary_color, "#ff0000");
  }

  const bad = resolveSettingsValues(SCHEMA, {
    sticky_header: "yes",
    header_variant: "mega",
    container_width: 100,
    primary_color: "blue",
    logo: "https://evil.example/logo.png",
    unknown_key: 1,
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.deepEqual(
      bad.issues.map((i) => i.code).sort(),
      [
        "THEME_SETTING_TYPE_INVALID",
        "THEME_SETTING_UNKNOWN",
        "THEME_SETTING_VALUE_INVALID",
        "THEME_SETTING_VALUE_INVALID",
        "THEME_SETTING_VALUE_INVALID",
        "THEME_SETTING_VALUE_INVALID",
      ].sort(),
    );
  }
});

test("defaults are deterministic: omitted settings fall back to schema defaults", () => {
  const a = resolveSettingsValues(SCHEMA, {});
  const b = resolveSettingsValues(SCHEMA, {});
  assert.ok(a.ok && b.ok);
  assert.deepEqual(a.values, b.values);
  assert.deepEqual(a.values, {
    sticky_header: true,
    primary_color: "#0f62fe",
    header_variant: "default",
    container_width: 1200,
    logo: "assets/img/logo.svg",
    footer_note: null,
  });
});

test("token override bridge materializes settings into documented tokens", () => {
  const tokensResult = parseTokensSource(
    JSON.stringify({
      "color.primary": { value: "#0f62fe", type: "color" },
      "logo.url": { value: "assets/img/logo.svg", type: "text" },
    }),
  );
  assert.ok(tokensResult.ok);
  if (!tokensResult.ok) return;

  const resolved = resolveSettingsValues(SCHEMA, {
    primary_color: "#aa0000",
    logo: "assets/img/logo-new.svg",
  });
  assert.ok(resolved.ok);
  if (!resolved.ok) return;
  const overrides = tokenOverridesFromSettings(SCHEMA, resolved.values);
  assert.deepEqual(overrides, {
    "--color-primary": "#aa0000",
    "--logo-url": "assets/img/logo-new.svg",
  });
  const merged = applyTokenOverrides(tokensResult.tokens, overrides);
  const css = tokensToCss(merged);
  assert.match(css, /--color-primary: #aa0000;/);
  assert.match(css, /--logo-url: assets\/img\/logo-new\.svg;/);
  // Source defaults stay version-controlled: the theme's own token file is untouched.
  assert.match(tokensToCss(tokensResult.tokens), /--color-primary: #0f62fe;/);
});

test("settings pointing at undeclared tokens are surfaced for validation", () => {
  const tokensResult = parseTokensSource(
    JSON.stringify({ "color.primary": { value: "#0f62fe", type: "color" } }),
  );
  assert.ok(tokensResult.ok);
  if (!tokensResult.ok) return;
  assert.deepEqual(unmatchedSettingTokens(SCHEMA, tokensResult.tokens), ["--logo-url"]);
});
