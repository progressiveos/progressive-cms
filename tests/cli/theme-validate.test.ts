// cms theme validate service/CLI tests (PCMS-THEME-T019).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runCli } from "@pcms/cli";
import { type ThemeValidationReport, validateThemeDir } from "@pcms/themes";

const MANIFEST = {
  id: "fixture-theme",
  name: "Fixture",
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
  settings_schema: [
    { key: "primary_color", type: "color", default: "#0f62fe", token: "--color-primary" },
  ],
  assets: { css: ["assets/css/theme.css"], js: ["assets/js/theme.js"], fingerprint: true },
};

function makeTheme(overrides: {
  manifest?: Record<string, unknown>;
  files?: Record<string, string>;
  noFixtures?: boolean;
  noTokens?: boolean;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "pcms-validate-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of [
    "templates/page-default.liquid",
    "components/button.liquid",
    "blocks/text.liquid",
    "assets/css/theme.css",
  ]) {
    const full = join(dir, file);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "/* fixture */");
  }
  mkdirSync(join(dir, "assets/js"), { recursive: true });
  writeFileSync(
    join(dir, "assets/js/theme.js"),
    overrides.files?.["assets/js/theme.js"] ?? "console.log('ok');",
  );
  if (!overrides.noTokens) {
    mkdirSync(join(dir, "tokens"), { recursive: true });
    writeFileSync(
      join(dir, "tokens/base.json"),
      JSON.stringify({ "color.primary": { value: "#0f62fe", type: "color" } }),
    );
  }
  if (!overrides.noFixtures) {
    mkdirSync(join(dir, "fixtures"), { recursive: true });
    writeFileSync(join(dir, "fixtures", "home.json"), "{}");
  }
  writeFileSync(join(dir, "theme.json"), JSON.stringify(overrides.manifest ?? MANIFEST));
  return dir;
}

test("a valid fixture theme passes all checks", () => {
  const dir = makeTheme({});
  const report = validateThemeDir(dir);
  assert.equal(report.theme, "fixture-theme");
  assert.deepEqual(report.issues, []);
  assert.equal(report.ok, true);
});

test("each broken area reports a stable issue", () => {
  const missingTemplate = makeTheme({
    files: { "assets/js/theme.js": "console.log('ok');" },
  });
  rmSync(join(missingTemplate, "components/button.liquid"));
  const report = validateThemeDir(missingTemplate);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === "THEME_FILE_MISSING"));

  const badToken = makeTheme({
    manifest: {
      ...MANIFEST,
      settings_schema: [
        { key: "accent", type: "color", default: "#000000", token: "--color-accent" },
      ],
    },
  });
  const tokenReport = validateThemeDir(badToken);
  assert.ok(tokenReport.issues.some((i) => i.code === "THEME_SETTING_TOKEN_UNKNOWN"));

  const leakyJs = makeTheme({ files: { "assets/js/theme.js": "const k = PCMS_SECRET_API_KEY;" } });
  const jsReport = validateThemeDir(leakyJs);
  assert.ok(jsReport.issues.some((i) => i.code === "THEME_JS_PRIVILEGED_TOKEN"));

  const noFixtures = makeTheme({ noFixtures: true });
  assert.ok(validateThemeDir(noFixtures).issues.some((i) => i.code === "THEME_FIXTURES_MISSING"));

  const futureContract = makeTheme({ manifest: { ...MANIFEST, theme_contract: "^2.0" } });
  assert.ok(
    validateThemeDir(futureContract).issues.some((i) => i.code === "THEME_CONTRACT_UNSUPPORTED"),
  );
});

test("missing manifest fails fast with a stable code", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcms-empty-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const report = validateThemeDir(dir);
  assert.equal(report.theme, null);
  assert.deepEqual(
    report.issues.map((i) => i.code),
    ["THEME_MANIFEST_MISSING"],
  );
});

test("CLI prints a machine-readable report with --json", async () => {
  const dir = makeTheme({});
  const result = await runCli(["theme", "validate", dir, "--json"]);
  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout) as ThemeValidationReport;
  assert.equal(payload.theme, "fixture-theme");
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.issues));
});

test("CLI exits non-zero and reports issues for a broken theme", async () => {
  const dir = makeTheme({ noFixtures: true });
  const result = await runCli(["theme", "validate", dir, "--json"]);
  assert.equal(result.exitCode, 1);
  const payload = JSON.parse(result.stdout) as ThemeValidationReport;
  assert.equal(payload.ok, false);
  assert.ok(payload.issues.length > 0);
});
