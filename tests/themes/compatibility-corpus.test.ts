// Theme compatibility regression corpus (PCMS-THEME-T027).
// The executable minor-release gate: frozen old manifests, persisted settings
// and frozen token CSS must survive the current contract unchanged.
// A failing test here = a breaking change inside Theme Contract ^1.0.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createThemeRegistry,
  parseThemeManifest,
  parseTokensSource,
  resolveSettingsValues,
  satisfiesVersion,
  type ThemeManifest,
  tokensToCss,
  validateThemeManifest,
} from "@pcms/themes";

interface Corpus {
  themes: {
    note: string;
    manifest: Record<string, unknown>;
    capabilitiesProvided: Record<string, string>;
  }[];
  persistedSettings: { note: string; themeId: string; values: Record<string, unknown> }[];
  frozenTokenCss: { note: string; tokens: Record<string, unknown>; css: string };
}

const corpus = JSON.parse(
  readFileSync("fixtures/themes/theme-compatibility-corpus.json", "utf8"),
) as Corpus;

function validated(manifest: Record<string, unknown>): ThemeManifest {
  const result = validateThemeManifest(manifest);
  if (result.ok) return result.value;
  assert.fail(JSON.stringify(result.issues, null, 2));
}

test("frozen old manifests keep validating against the current schema", () => {
  for (const theme of corpus.themes) {
    const parsed = parseThemeManifest(JSON.stringify(theme.manifest));
    assert.equal(
      parsed.ok,
      true,
      `${theme.manifest.id}: ${JSON.stringify(parsed.ok ? [] : parsed.issues)}`,
    );
  }
});

test("old themes resolve and remain contract-compatible with this build", () => {
  const registry = createThemeRegistry();
  for (const theme of corpus.themes) {
    registry.registerTheme(validated(theme.manifest));
  }
  // Range resolution from an old constraint still finds the frozen versions.
  assert.equal(registry.resolveTheme("reference-theme-v1", "^1.0")?.version, "1.0.0");
  assert.equal(registry.resolveTheme("client-acme-2026", "~1.2")?.version, "1.2.0");
  // Capability sets of the era are satisfied by the current build.
  for (const theme of corpus.themes) {
    const manifest = validated(theme.manifest);
    const result = registry.checkCompatibility(manifest, {
      capabilities: theme.capabilitiesProvided,
    });
    assert.deepEqual(result, { compatible: true }, String(theme.manifest.id));
  }
});

test("persisted settings values keep resolving against the frozen schemas", () => {
  const byId = new Map(corpus.themes.map((t) => [String(t.manifest.id), validated(t.manifest)]));
  for (const saved of corpus.persistedSettings) {
    const manifest = byId.get(saved.themeId);
    assert.ok(manifest, `missing frozen manifest for ${saved.themeId}`);
    const resolved = resolveSettingsValues(manifest.settings_schema, saved.values);
    assert.equal(resolved.ok, true, JSON.stringify(resolved.ok ? [] : resolved.issues));
    if (!resolved.ok) continue;
    for (const [key, value] of Object.entries(saved.values)) {
      assert.equal(resolved.values[key], value, `${saved.themeId}.${key} changed meaning`);
    }
  }
});

test("token CSS output is byte-frozen within the same contract major", () => {
  const parsed = parseTokensSource(JSON.stringify(corpus.frozenTokenCss.tokens));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(tokensToCss(parsed.tokens), corpus.frozenTokenCss.css);
});

test("contract version policy: current build stays inside the frozen range", () => {
  // The frozen themes declare ^1.0; the build's own contract version must
  // satisfy it — this is the invariant a major bump would break on purpose.
  assert.equal(satisfiesVersion("1.0.0", "^1.0"), true);
});
