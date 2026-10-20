// cms site validate tests (PCMS-THEME-T020): unknown field / block /
// variant / missing global must be found.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  parseThemeManifest,
  type SiteContentTypeInfo,
  type SiteEntryInfo,
  type ThemeManifest,
  validateSiteAgainstTheme,
} from "@pcms/themes";

const MANIFEST_JSON = {
  id: "fixture-theme",
  name: "Fixture",
  version: "1.0.0",
  theme_contract: "^1.0",
  templates: [
    {
      id: "service-default",
      file: "templates/service-default.liquid",
      accepts_content_types: ["service@1"],
      required_fields: ["title"],
      globals: ["contacts"],
    },
  ],
  components: [],
  block_renderers: [
    { block: "text@1", file: "blocks/text.liquid" },
    { block: "cta@1", file: "blocks/cta.liquid", variants: ["inline", "wide"] },
  ],
  navigation_placements: [
    { id: "header.primary", max_depth: 2, supported_item_types: ["internal_entry"] },
  ],
  media_presets: [{ id: "card", width: 800 }],
  settings_schema: [],
};

const manifestResult = parseThemeManifest(JSON.stringify(MANIFEST_JSON));

const CONTENT_TYPES: SiteContentTypeInfo[] = [
  { key: "service", version: 1, fieldIds: ["title", "intro", "body"] },
];

function entry(overrides: Partial<SiteEntryInfo>): SiteEntryInfo {
  return {
    id: "svc-1",
    contentTypeKey: "service",
    contentTypeVersion: 1,
    templateKey: "service-default",
    fieldIds: ["title"],
    blocks: [],
    ...overrides,
  };
}

function reportFor(
  entries: SiteEntryInfo[],
  globals: readonly string[] = ["contacts"],
): Extract<ReturnType<typeof validateSiteAgainstTheme>, { ok: boolean }> {
  if (!manifestResult.ok) throw new Error("fixture manifest invalid");
  return validateSiteAgainstTheme(manifestResult.value, CONTENT_TYPES, entries, { globals });
}

test("compatible entry validates cleanly", () => {
  const report = reportFor([entry({})]);
  assert.deepEqual(report.issues, []);
  assert.equal(report.ok, true);
  assert.equal(report.entries, 1);
});

test("unknown field, unknown template and wrong content type are found", () => {
  const report = reportFor([
    entry({ id: "e1", fieldIds: ["title", "nonsense_field"] }),
    entry({ id: "e2", templateKey: "service-premium" }),
    entry({ id: "e3", contentTypeKey: "landing" }),
    entry({ id: "e4", fieldIds: [] }),
  ]);
  const byEntry = new Map(report.issues.map((i) => [i.entryId, i.code]));
  assert.equal(byEntry.get("e1"), "THEME_SITE_FIELD_UNKNOWN");
  assert.equal(byEntry.get("e2"), "THEME_SITE_TEMPLATE_UNKNOWN");
  assert.equal(byEntry.get("e3"), "THEME_SITE_TEMPLATE_CONTENT_TYPE_REJECTED");
  assert.equal(byEntry.get("e4"), "THEME_SITE_FIELD_MISSING");
});

test("missing global and unsupported block/variant are found", () => {
  if (!manifestResult.ok) throw new Error("fixture manifest invalid");
  const report = reportFor(
    [
      entry({
        id: "e5",
        fieldIds: ["title", "body"],
        blocks: [
          {
            id: "b1",
            type: "cta",
            schemaVersion: 1,
            variant: "mega",
            children: [{ id: "b2", type: "form", schemaVersion: 1, variant: null, children: [] }],
          },
        ],
      }),
    ],
    [], // no globals provided → contacts missing
  );
  const codes = report.issues.map((i) => i.code).sort();
  assert.deepEqual(codes, [
    "THEME_SITE_BLOCK_RENDERER_NOT_FOUND",
    "THEME_SITE_BLOCK_VARIANT_UNSUPPORTED",
    "THEME_SITE_GLOBAL_MISSING",
  ]);
});

test("CLI maps the reference corpus through and validates against a theme", async () => {
  const { runCli } = await import("@pcms/cli");
  const themeDir = mkdtempSync(join(tmpdir(), "pcms-site-"));
  after(() => rmSync(themeDir, { recursive: true, force: true }));
  mkdirSync(join(themeDir, "blocks"), { recursive: true });
  mkdirSync(join(themeDir, "templates"), { recursive: true });
  // The corpus contains 5 content types; the fixture theme accepts them all.
  const allTypes: Record<string, unknown> = JSON.parse(JSON.stringify(MANIFEST_JSON));
  allTypes.templates = ["page", "service", "case", "news", "article"].map((key) => ({
    id: `${key}-default`,
    file: `templates/${key}-default.liquid`,
    accepts_content_types: [`${key}@1`],
  }));
  allTypes.block_renderers = [{ block: "text@1", file: "blocks/text.liquid" }];
  writeFileSync(join(themeDir, "theme.json"), JSON.stringify(allTypes));
  for (const key of ["page", "service", "case", "news", "article"]) {
    writeFileSync(join(themeDir, `templates/${key}-default.liquid`), "<main></main>");
  }
  writeFileSync(join(themeDir, "blocks/text.liquid"), "<div>{{ block.id }}</div>");

  const result = await runCli([
    "site",
    "validate",
    "--theme",
    themeDir,
    "--content",
    "fixtures/content/reference-content-types.json",
    "--json",
  ]);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout) as { ok: boolean; entries: number; issues: unknown[] };
  assert.equal(payload.ok, true, JSON.stringify(payload.issues));
  assert.equal(payload.entries, 9); // valid fixtures in the corpus
});

test("site validate flags an unknown block type in a custom content file", async () => {
  const { runCli } = await import("@pcms/cli");
  const themeDir = mkdtempSync(join(tmpdir(), "pcms-site2-"));
  after(() => rmSync(themeDir, { recursive: true, force: true }));
  writeFileSync(join(themeDir, "theme.json"), JSON.stringify(MANIFEST_JSON));

  const contentFile = join(themeDir, "content.json");
  writeFileSync(
    contentFile,
    JSON.stringify({
      contentTypes: [
        {
          key: "service",
          version: 1,
          fields: {
            title: { id: "title", type: "string" },
            body: { id: "body", type: "block_document" },
          },
        },
      ],
      fixtures: [
        {
          name: "with-form",
          contentType: "service",
          expect: "valid",
          level: "publish",
          fields: {
            title: "S",
            body: {
              schema_version: 1,
              blocks: [
                {
                  id: "018f6d2c-5f31-7abc-8def-2a3b4c5d6e7f",
                  type: "quiz",
                  schema_version: 1,
                  variant: null,
                  props: {},
                  children: [],
                },
              ],
            },
          },
        },
      ],
    }),
  );
  const result = await runCli([
    "site",
    "validate",
    "--theme",
    themeDir,
    "--content",
    contentFile,
    "--json",
  ]);
  assert.equal(result.exitCode, 1);
  const payload = JSON.parse(result.stdout) as { ok: boolean; issues: { code: string }[] };
  assert.equal(payload.ok, false);
  assert.deepEqual(
    payload.issues.map((i) => i.code),
    ["THEME_SITE_BLOCK_RENDERER_NOT_FOUND"],
  );
});
