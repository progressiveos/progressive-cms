// Navigation placement contract tests (PCMS-THEME-T011).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createNavigationPlacementRegistry,
  type NavigationAssignment,
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
    {
      id: "header.primary",
      required: true,
      max_depth: 2,
      supported_item_types: ["internal_entry", "external_url", "group"],
      fallback: "header.compact",
    },
    {
      id: "header.compact",
      required: false,
      max_depth: 1,
      supported_item_types: ["internal_entry", "external_url", "anchor"],
    },
    {
      id: "header.mobile",
      required: true,
      max_depth: 3,
      supported_item_types: ["internal_entry", "group", "separator"],
    },
    { id: "footer.legal", required: false, max_depth: 1, supported_item_types: ["internal_entry"] },
  ],
  media_presets: [{ id: "card", width: 800 }],
  settings_schema: [],
});

const ENTRY = "0198c0a9-8f7d-7cc0-9a2a-5f1e2d3c4b5a";

test("placements list deterministically with their contracts", () => {
  const registry = createNavigationPlacementRegistry(MANIFEST);
  assert.deepEqual(
    registry.listPlacements().map((p) => p.id),
    ["footer.legal", "header.compact", "header.mobile", "header.primary"],
  );
  const primary = registry.getPlacement("header.primary");
  assert.equal(primary?.maxDepth, 2);
  assert.equal(primary?.required, true);
  assert.equal(primary?.fallback, "header.compact");
});

test("depth and item-type validation per placement", () => {
  const registry = createNavigationPlacementRegistry(MANIFEST);
  const assignments: NavigationAssignment[] = [
    {
      placement: "header.primary",
      items: [
        { type: "internal_entry", entry_id: ENTRY, title: "Home", href: "/", items: [] },
        {
          type: "group",
          title: "Services",
          items: [
            // depth 2 = OK for header.primary
            { type: "internal_entry", entry_id: ENTRY, title: "Audit", href: "/audit", items: [] },
            // depth 3 → exceeds max_depth 2
            {
              type: "group",
              title: "Deep",
              items: [
                {
                  type: "internal_entry",
                  entry_id: ENTRY,
                  title: "Too deep",
                  href: "/x",
                  items: [],
                },
              ],
            },
          ],
        },
        // separator is not supported on header.primary:
        { type: "separator" },
      ],
    },
    // keep the other required placement satisfied so only real issues remain
    {
      placement: "header.mobile",
      items: [{ type: "internal_entry", entry_id: ENTRY, title: "Home", href: "/", items: [] }],
    },
  ];
  const issues = registry.validateAssignments(assignments);
  assert.deepEqual(
    issues.map((i) => [i.code, i.path]),
    [
      ["THEME_NAV_DEPTH_EXCEEDED", "/assignments/0/items/1/items/1/items/0"],
      ["THEME_NAV_ITEM_TYPE_UNSUPPORTED", "/assignments/0/items/2"],
    ],
  );
});

test("required placements need an assignment or a resolvable fallback", () => {
  const registry = createNavigationPlacementRegistry(MANIFEST);
  // header.primary missing → falls back to header.compact assignment.
  const withFallback: NavigationAssignment[] = [
    {
      placement: "header.compact",
      items: [{ type: "internal_entry", entry_id: ENTRY, title: "Home", href: "/", items: [] }],
    },
    {
      placement: "header.mobile",
      items: [{ type: "internal_entry", entry_id: ENTRY, title: "Home", href: "/", items: [] }],
    },
  ];
  assert.deepEqual(registry.validateAssignments(withFallback), []);
  // Remove it → header.primary becomes missing.
  const missing = registry.validateAssignments([withFallback[1] as NavigationAssignment]);
  assert.deepEqual(
    missing.map((i) => i.code),
    ["THEME_PLACEMENT_REQUIRED_MISSING"],
  );
  // The fallback's depth-1 set also satisfies depth/type checks of the target.
  assert.equal(registry.resolveItems(withFallback, "header.primary")?.length, 1);
  assert.equal(registry.resolveItems([], "header.mobile"), null);
});

test("item shape rules: hrefs, anchors, stable IDs", () => {
  const registry = createNavigationPlacementRegistry(MANIFEST);
  const issues = registry.validateAssignments([
    {
      placement: "header.compact",
      items: [
        { type: "external_url", title: "t", href: "javascript:alert(1)", items: [] },
        { type: "internal_entry", entry_id: "not-a-uuid", title: "t", href: "/ok", items: [] },
        {
          type: "internal_entry",
          entry_id: ENTRY,
          title: "t",
          href: "https://elsewhere.example",
          items: [],
        },
        { type: "anchor", title: "t", anchor: "", items: [] },
      ],
    },
    // keep the other required placement satisfied so only shape issues remain
    {
      placement: "header.mobile",
      items: [{ type: "internal_entry", entry_id: ENTRY, title: "Home", href: "/", items: [] }],
    },
  ]);
  assert.deepEqual(
    issues.map((i) => i.code),
    [
      "THEME_NAV_ITEM_MALFORMED",
      "THEME_NAV_ITEM_MALFORMED",
      "THEME_NAV_ITEM_MALFORMED",
      "THEME_NAV_ITEM_MALFORMED",
    ],
  );
});

test("assignments to undeclared placements are rejected; one set may serve several placements", () => {
  const registry = createNavigationPlacementRegistry(MANIFEST);
  const unknown = registry.validateAssignments([
    { placement: "sidebar.nope", items: [] },
    // keep required placements satisfied so only the unknown-placement issue remains
    { placement: "header.primary", items: [] },
    {
      placement: "header.mobile",
      items: [{ type: "internal_entry", entry_id: ENTRY, title: "Home", href: "/", items: [] }],
    },
  ]);
  assert.deepEqual(
    unknown.map((i) => i.code),
    ["THEME_PLACEMENT_UNKNOWN"],
  );

  // Same nav set assigned to desktop AND mobile placements (spec §23).
  const sharedItems: NavigationAssignment["items"] = [
    { type: "internal_entry", entry_id: ENTRY, title: "Home", href: "/", items: [] },
  ];
  const shared = registry.validateAssignments([
    { placement: "header.primary", items: sharedItems },
    { placement: "header.mobile", items: sharedItems },
  ]);
  assert.deepEqual(shared, []);
});
