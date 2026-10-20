// Theme registry + version/capability resolver tests (PCMS-THEME-T003).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createThemeRegistry,
  parseThemeManifest,
  satisfiesVersion,
  type ThemeManifest,
  validateThemeManifest,
} from "@pcms/themes";

function manifestOf(json: Record<string, unknown>): ThemeManifest {
  const result = validateThemeManifest(json);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  return result.value;
}

function baseManifest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "acme-2026",
    name: "Acme 2026",
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
      { id: "header.primary", max_depth: 3, supported_item_types: ["internal_entry"] },
    ],
    media_presets: [{ id: "card", width: 800 }],
    settings_schema: [],
    ...overrides,
  };
}

test("satisfiesVersion covers the manifest range grammar", () => {
  assert.equal(satisfiesVersion("1.4.2", "^1.0"), true);
  assert.equal(satisfiesVersion("1.4.2", "^1.2.3"), true);
  assert.equal(satisfiesVersion("2.0.0", "^1.0"), false);
  assert.equal(satisfiesVersion("1.9.9", "~1.2"), false);
  assert.equal(satisfiesVersion("1.2.9", "~1.2"), true);
  assert.equal(satisfiesVersion("1.2.3", "1.2.3"), true);
  assert.equal(satisfiesVersion("1.2.4", ">=1.2"), true);
  assert.equal(satisfiesVersion("1.1.9", ">=1.2"), false);
  assert.equal(satisfiesVersion("0.9.0", "<1.0"), true);
  assert.equal(satisfiesVersion("9.9.9", "*"), true);
  assert.equal(satisfiesVersion("banana", "^1.0"), false);
  assert.equal(satisfiesVersion("1.0.0-rc.1", ">=1.0.0-rc.1 <2.0.0"), true);
  assert.equal(satisfiesVersion("1.0.0-rc.1", ">=1.0.0 <2.0.0"), false);
});

test("registry stores multiple versions and resolves the highest satisfying one", () => {
  const registry = createThemeRegistry();
  for (const version of ["1.0.0", "1.1.0", "1.9.3", "2.0.0"]) {
    registry.registerTheme(manifestOf(baseManifest({ version })));
  }
  assert.equal(registry.resolveTheme("acme-2026", "^1.0")?.version, "1.9.3");
  assert.equal(registry.resolveTheme("acme-2026", "~1.0")?.version, "1.0.0");
  assert.equal(registry.resolveTheme("acme-2026", "^2.0")?.version, "2.0.0");
  assert.equal(registry.resolveTheme("acme-2026", "^3.0"), null);
  assert.equal(registry.resolveTheme("unknown", "*"), null);
  assert.equal(registry.getTheme("acme-2026", "1.1.0")?.version, "1.1.0");
  assert.deepEqual(
    registry.listThemes().map((m) => m.version),
    ["1.0.0", "1.1.0", "1.9.3", "2.0.0"],
  );
});

test("duplicate (id, version) registration is rejected with a stable code", () => {
  const registry = createThemeRegistry();
  registry.registerTheme(manifestOf(baseManifest({ version: "1.0.0" })));
  assert.throws(
    () => registry.registerTheme(manifestOf(baseManifest({ version: "1.0.0" }))),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_ALREADY_REGISTERED",
  );
});

test("compatible fixture: contract and capabilities match this build", () => {
  const registry = createThemeRegistry();
  const theme = manifestOf(
    baseManifest({
      requires: { "content.block_document": ">=1", "blocks.gallery": ">=1" },
      cms_compatibility: ">=0.1",
    }),
  );
  const result = registry.checkCompatibility(theme, {
    capabilities: { "content.block_document": "1", "blocks.gallery": "1.2" },
    cmsVersion: "0.1.0",
  });
  assert.deepEqual(result, { compatible: true });
});

test("incompatible fixtures: unsupported contract, missing capability, cms range", () => {
  const registry = createThemeRegistry();

  const futureContract = manifestOf(baseManifest({ theme_contract: "^2.0" }));
  const contractResult = registry.checkCompatibility(futureContract);
  assert.equal(contractResult.compatible, false);
  if (!contractResult.compatible) {
    assert.deepEqual(
      contractResult.issues.map((i) => i.code),
      ["THEME_CONTRACT_UNSUPPORTED"],
    );
  }

  const needsGallery = manifestOf(
    baseManifest({ requires: { "blocks.gallery": ">=2" }, cms_compatibility: ">=99.0" }),
  );
  const capResult = registry.checkCompatibility(needsGallery, {
    capabilities: { "blocks.gallery": "1" },
    cmsVersion: "0.1.0",
  });
  assert.equal(capResult.compatible, false);
  if (!capResult.compatible) {
    assert.deepEqual(
      capResult.issues.map((i) => i.code),
      ["THEME_CMS_INCOMPATIBLE", "THEME_CAPABILITY_MISSING"],
    );
  }

  const absentCapability = manifestOf(
    baseManifest({ requires: { "navigation.placements": ">=1" } }),
  );
  const missingResult = registry.checkCompatibility(absentCapability, {});
  assert.equal(missingResult.compatible, false);
});

test("parseThemeManifest round-trips a valid document unchanged", () => {
  const raw = baseManifest({});
  const parsed = parseThemeManifest(JSON.stringify(raw));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.id, "acme-2026");
});
