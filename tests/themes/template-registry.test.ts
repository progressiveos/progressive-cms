// Template registry + Content Type acceptance tests (PCMS-THEME-T006).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertTemplateAcceptance,
  createTemplateRegistry,
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
      id: "service-default",
      file: "templates/service-default.liquid",
      accepts_content_types: ["service@1"],
      required_fields: ["title", "price"],
      optional_fields: ["intro"],
      globals: ["contacts"],
    },
    {
      id: "service-premium",
      file: "templates/service-premium.liquid",
      accepts_content_types: ["service@1"],
      required_fields: ["title"],
      supported_blocks: ["text", "gallery"],
    },
    {
      id: "page-default",
      file: "templates/page-default.liquid",
      accepts_content_types: ["page@1", "landing@2"],
    },
  ],
  components: [],
  block_renderers: [{ block: "text@1", file: "blocks/text.liquid" }],
  navigation_placements: [
    { id: "header.primary", max_depth: 2, supported_item_types: ["internal_entry"] },
  ],
  media_presets: [{ id: "card", width: 800 }],
  settings_schema: [],
});

test("one Content Type may be served by several templates; one template may take several types", () => {
  const registry = createTemplateRegistry(MANIFEST);
  assert.deepEqual(
    registry.listTemplates().map((t) => t.id),
    ["page-default", "service-default", "service-premium"],
  );
  // service@1 → both service templates (Content Type ≠ Template).
  assert.equal(registry.acceptsContentTypeKey("service-default", "service"), true);
  assert.equal(registry.acceptsContentTypeKey("service-premium", "service"), true);
  assert.equal(registry.acceptsContentTypeKey("page-default", "service"), false);
  // landing@2 accepted, landing@1 not (version is part of the contract).
  assert.equal(registry.acceptsContentTypeKey("page-default", "landing"), true);
});

test("compatible entry passes acceptance", () => {
  const registry = createTemplateRegistry(MANIFEST);
  const result = registry.checkAcceptance({
    templateId: "service-default",
    contentTypeKey: "service",
    contentTypeVersion: 1,
    presentFields: ["title", "price", "intro"],
    presentGlobals: ["contacts", "extra"],
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.contract.id, "service-default");
});

test("incompatible entries are rejected with precise codes", () => {
  const registry = createTemplateRegistry(MANIFEST);

  const unknown = registry.checkAcceptance({
    templateId: "nope",
    contentTypeKey: "service",
    contentTypeVersion: 1,
    presentFields: [],
  });
  assert.equal(unknown.ok, false);
  if (!unknown.ok)
    assert.deepEqual(
      unknown.issues.map((i) => i.code),
      ["THEME_TEMPLATE_NOT_FOUND"],
    );

  const wrongType = registry.checkAcceptance({
    templateId: "service-default",
    contentTypeKey: "page",
    contentTypeVersion: 1,
    presentFields: ["title", "price"],
    presentGlobals: ["contacts"],
  });
  if (!wrongType.ok)
    assert.deepEqual(
      wrongType.issues.map((i) => i.code),
      ["THEME_TEMPLATE_CONTENT_TYPE_REJECTED"],
    );
  else assert.fail("expected rejection");

  const wrongVersion = registry.checkAcceptance({
    templateId: "page-default",
    contentTypeKey: "landing",
    contentTypeVersion: 1,
    presentFields: [],
  });
  if (!wrongVersion.ok)
    assert.deepEqual(
      wrongVersion.issues.map((i) => i.code),
      ["THEME_TEMPLATE_CONTENT_TYPE_REJECTED"],
    );
  else assert.fail("expected rejection");

  const missingField = registry.checkAcceptance({
    templateId: "service-default",
    contentTypeKey: "service",
    contentTypeVersion: 1,
    presentFields: ["title"],
    presentGlobals: ["contacts"],
  });
  if (!missingField.ok) {
    assert.deepEqual(
      missingField.issues.map((i) => i.code),
      ["THEME_TEMPLATE_FIELD_MISSING"],
    );
    assert.equal(missingField.issues[0]?.path, "/fields/price");
  } else assert.fail("expected rejection");

  const missingGlobal = registry.checkAcceptance({
    templateId: "service-default",
    contentTypeKey: "service",
    contentTypeVersion: 1,
    presentFields: ["title", "price"],
  });
  if (!missingGlobal.ok)
    assert.deepEqual(
      missingGlobal.issues.map((i) => i.code),
      ["THEME_TEMPLATE_GLOBAL_MISSING"],
    );
  else assert.fail("expected rejection");
});

test("assertTemplateAcceptance throws the first issue as a ThemeError", () => {
  const registry = createTemplateRegistry(MANIFEST);
  assert.throws(
    () =>
      assertTemplateAcceptance(registry, {
        templateId: "service-default",
        contentTypeKey: "page",
        contentTypeVersion: 1,
        presentFields: [],
      }),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_TEMPLATE_CONTENT_TYPE_REJECTED",
  );
});
