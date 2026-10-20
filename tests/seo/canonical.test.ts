// PCMS-SEO-T003 — canonical override validation + signal consistency (§9/§10).
// Routing stays the canonical source; SEO only validates the override and
// checks that all emitted URL signals agree.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalConsistencyIssues, resolveCanonical, validateCanonicalOverride } from "@pcms/seo";

test("effective canonical: override wins, routing fills the rest, provenance tracked", () => {
  assert.deepEqual(
    resolveCanonical(
      { canonical_override: "https://x.example/a/" } as never,
      "https://example.com/a/",
    ),
    {
      url: "https://x.example/a/",
      source: "canonical_override",
    },
  );
  assert.deepEqual(resolveCanonical(null, "https://example.com/a/"), {
    url: "https://example.com/a/",
    source: "canonical_route",
  });
  assert.deepEqual(resolveCanonical(null, null), { url: null, source: null });
});

test("override validation: absolute http(s) URLs and site-absolute paths pass", () => {
  assert.deepEqual(
    validateCanonicalOverride("https://example.com/a/", { routeUrl: "https://example.com/a/" }),
    [],
  );
  assert.deepEqual(validateCanonicalOverride("/services/audit/", { routeUrl: null }), []);
  assert.deepEqual(validateCanonicalOverride("http://example.com/a/", { routeUrl: null }), []);
});

test("override validation: malformed URLs and non-http(s) schemes are errors", () => {
  for (const bad of [
    "not a url",
    "javascript:alert(1)",
    "data:text/html,x",
    "ftp://example.com/a",
    "//example.com/a",
  ]) {
    const issues = validateCanonicalOverride(bad, { routeUrl: null });
    assert.ok(
      issues.some((i) => i.code === "SEO_CANONICAL_INVALID" && i.severity === "error"),
      `expected rejection of ${bad}`,
    );
  }
});

test("override validation: query strings and fragments are not canonical identity (§52)", () => {
  for (const bad of ["https://example.com/a/?utm_source=x", "/a/?page=2", "/a/#top"]) {
    assert.ok(
      validateCanonicalOverride(bad, { routeUrl: null }).some(
        (i) => i.code === "SEO_CANONICAL_INVALID",
      ),
      `expected rejection of ${bad}`,
    );
  }
});

test("external-host overrides need explicit permission — otherwise an error", () => {
  const ctx = { routeUrl: "https://example.com/a/" };
  const denied = validateCanonicalOverride("https://other.example/a/", ctx);
  assert.ok(denied.some((i) => i.code === "SEO_CANONICAL_EXTERNAL" && i.severity === "error"));
  const allowed = validateCanonicalOverride("https://other.example/a/", {
    ...ctx,
    allowExternalCanonical: true,
  });
  assert.ok(allowed.some((i) => i.code === "SEO_CANONICAL_EXTERNAL" && i.severity === "warning"));
  // Host comparison is case-insensitive; the configured host never comes from a request.
  assert.deepEqual(validateCanonicalOverride("https://EXAMPLE.com/a/", ctx), []);
});

test("canonical consistency: og:url, structured data and sitemap loc must agree (§10)", () => {
  const canonical = "https://example.com/a/";
  assert.deepEqual(
    canonicalConsistencyIssues({
      canonical,
      og_url: canonical,
      structured_data_url: canonical,
      sitemap_loc: canonical,
    }),
    [],
  );
  const issues = canonicalConsistencyIssues({
    canonical,
    og_url: "https://example.com/b/",
    structured_data_url: canonical,
    sitemap_loc: "https://example.com/a?page=1",
  });
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.code === "SEO_CANONICAL_MISMATCH" && i.severity === "error"));
  // Missing signals are not mismatches.
  assert.deepEqual(
    canonicalConsistencyIssues({ canonical: null, og_url: canonical, structured_data_url: null }),
    [],
  );
});
