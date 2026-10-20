// PCMS-NAV-T009 — default trailing-slash route policy (Navigation spec §25).
// `/foo` permanently redirects to `/foo/`; extension forms are exempt;
// uppercase requests redirect to the lowercase canonical (spec §45).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ROUTE_POLICY,
  decideRequestPath,
  LEGACY_HTML_ROUTE_POLICY,
  normalizeStoredPath,
  type RoutingError,
} from "@pcms/routing";

test("slashless content requests redirect permanently to the slash form", () => {
  const decision = decideRequestPath("/foo", DEFAULT_ROUTE_POLICY);
  assert.deepEqual(decision, { kind: "redirect", statusCode: 301, location: "/foo/" });
  assert.deepEqual(decideRequestPath("/services/audit", DEFAULT_ROUTE_POLICY), {
    kind: "redirect",
    statusCode: 301,
    location: "/services/audit/",
  });
});

test("canonical forms pass through unchanged", () => {
  assert.deepEqual(decideRequestPath("/", DEFAULT_ROUTE_POLICY), { kind: "canonical", path: "/" });
  assert.deepEqual(decideRequestPath("/foo/", DEFAULT_ROUTE_POLICY), {
    kind: "canonical",
    path: "/foo/",
  });
  assert.deepEqual(decideRequestPath("/services/audit/", DEFAULT_ROUTE_POLICY), {
    kind: "canonical",
    path: "/services/audit/",
  });
});

test("uppercase requests redirect to the lowercase canonical (spec §45)", () => {
  assert.deepEqual(decideRequestPath("/Services", DEFAULT_ROUTE_POLICY), {
    kind: "redirect",
    statusCode: 301,
    location: "/services/",
  });
  // No filesystem-like folding: unregistered case variants are just redirects.
  assert.deepEqual(decideRequestPath("/ABOUT/", DEFAULT_ROUTE_POLICY), {
    kind: "redirect",
    statusCode: 301,
    location: "/about/",
  });
});

test("allowed extensions are exempt from the trailing slash (spec §25)", () => {
  assert.equal(normalizeStoredPath("/about.html", LEGACY_HTML_ROUTE_POLICY), "/about.html");
  assert.equal(normalizeStoredPath("/news/bar.html", LEGACY_HTML_ROUTE_POLICY), "/news/bar.html");
  // A slash appended to an extension form redirects back to the extension form.
  assert.deepEqual(decideRequestPath("/about.html/", LEGACY_HTML_ROUTE_POLICY), {
    kind: "redirect",
    statusCode: 301,
    location: "/about.html",
  });
  // New-site policy rejects .html outright (spec §24).
  assert.throws(
    () => normalizeStoredPath("/about.html", DEFAULT_ROUTE_POLICY),
    (err: RoutingError) =>
      err.code === "ROUTE_PATH_INVALID" || err.code === "ROUTE_INVALID_ENCODING",
  );
});

test("unsafe request paths are invalid, never normalized into something else", () => {
  for (const path of ["/a%2Fb", "/a%5C", "/a//b", "/a/../b", "/a\\b", "/\u0000"]) {
    const decision = decideRequestPath(path, DEFAULT_ROUTE_POLICY);
    assert.equal(decision.kind, "invalid", path);
  }
});

test("stored-path normalization is idempotent", () => {
  for (const path of ["/", "/foo/", "/services/audit/", "/about.html"]) {
    const once = normalizeStoredPath(path, LEGACY_HTML_ROUTE_POLICY);
    assert.equal(normalizeStoredPath(once, LEGACY_HTML_ROUTE_POLICY), once);
  }
});
