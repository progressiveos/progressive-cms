// PCMS-NAV-T001 — Navigation/Routing module boundaries and domain model.
//
// Acceptance: "no Content Tree coupling". The strong guard is the repo-wide
// architecture boundary test (tests/architecture.test.ts: L1 packages import
// @pcms/core only, deep imports forbidden). These tests pin the domain
// surface itself: the six v1 item types, the typed action kinds and the
// new-site/legacy policy baselines stay complete and machine-inspectable.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_TREE_DEPTH,
  EXTERNAL_REL_TOKENS,
  MAX_ITEMS_PER_SET,
  NAVIGATION_ITEM_TYPES,
  NavigationError,
  PACKAGE_NAME,
} from "@pcms/navigation";
import {
  DEFAULT_MAX_REDIRECT_CHAIN,
  DEFAULT_ROUTE_POLICY,
  LEGACY_HTML_ROUTE_POLICY,
  PACKAGE_NAME as ROUTING_PACKAGE_NAME,
  RoutingError,
} from "@pcms/routing";

test("navigation domain declares exactly the six v1 item types", () => {
  assert.deepEqual(
    [...NAVIGATION_ITEM_TYPES],
    ["internal_entry", "external_url", "anchor", "group", "separator", "action"],
  );
});

test("navigation safety bounds exist and are machine-readable", () => {
  assert.equal(DEFAULT_MAX_TREE_DEPTH, 10); // spec §12 default
  assert.ok(MAX_ITEMS_PER_SET >= 100);
  assert.deepEqual([...EXTERNAL_REL_TOKENS].sort(), [
    "nofollow",
    "noopener",
    "noreferrer",
    "sponsored",
  ]);
});

test("navigation errors carry stable machine codes, not prose", () => {
  const err = new NavigationError("NAV_OVERRIDE_STALE", "override target gone", {
    details: { item_id: "x" },
  });
  assert.equal(err.code, "NAV_OVERRIDE_STALE");
  assert.equal(err.name, "NavigationError");
  assert.deepEqual(err.details, { item_id: "x" });
});

test("routing errors carry stable machine codes, not prose", () => {
  const err = new RoutingError("ROUTE_COLLISION", "path taken", {
    details: { path: "/x/" },
  });
  assert.equal(err.code, "ROUTE_COLLISION");
  assert.equal(err.name, "RoutingError");
  assert.deepEqual(err.details, { path: "/x/" });
});

test("default route policy is the new-site baseline (spec §24)", () => {
  assert.equal(DEFAULT_ROUTE_POLICY.trailingSlash, true);
  assert.equal(DEFAULT_ROUTE_POLICY.lowercase, true);
  assert.deepEqual(DEFAULT_ROUTE_POLICY.allowedExtensions, []);
  for (const reserved of ["/admin/", "/api/", "/mcp/", "/assets/", "/health/", "/preview/"]) {
    assert.ok(DEFAULT_ROUTE_POLICY.reservedPrefixes.includes(reserved), reserved);
  }
});

test("legacy policy preserves .html without hacks (spec §26)", () => {
  assert.deepEqual(LEGACY_HTML_ROUTE_POLICY.allowedExtensions, [".html"]);
  assert.equal(LEGACY_HTML_ROUTE_POLICY.trailingSlash, true);
});

test("redirect chain threshold is configurable and finite", () => {
  assert.ok(DEFAULT_MAX_REDIRECT_CHAIN >= 1);
});

test("packages expose a single public entry name", () => {
  assert.equal(PACKAGE_NAME, "@pcms/navigation");
  assert.equal(ROUTING_PACKAGE_NAME, "@pcms/routing");
});
