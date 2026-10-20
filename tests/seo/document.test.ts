// PCMS-SEO-T001 — typed metadata model. The SEO payload is typed plain data:
// raw directive strings cannot enter, unknown fields are rejected, control
// characters (CRLF) never reach a stored value. Deterministic fixtures.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptySeoDocument,
  parseSeoDocument,
  parseSeoRobotsPolicy,
  SeoError,
  STRUCTURED_DATA_TYPE_HINTS,
} from "@pcms/seo";

const ASSET = "0195fdc0-7a5e-7000-8000-000000000001";

function issuesOf(fn: () => unknown): readonly { code: string; path: string; message: string }[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SeoError);
    assert.equal(err.name, "SeoError");
    const issues = (err.details as { issues?: unknown }).issues;
    assert.ok(Array.isArray(issues));
    return issues as { code: string; path: string; message: string }[];
  }
  throw new Error("expected rejection");
}

test("a full document round-trips with exact spec §3 field names", () => {
  const doc = parseSeoDocument({
    seo_title: "Custom title",
    meta_description: "Custom description",
    canonical_override: "https://www.example.com/page/",
    robots_policy: { index: true, follow: false, max_snippet: 100 },
    social_title: "Social title",
    social_description: "Social description",
    social_image: { asset_id: ASSET, version: 2 },
    structured_data_type_hint: "article",
  });
  assert.deepEqual(doc, {
    seo_title: "Custom title",
    meta_description: "Custom description",
    canonical_override: "https://www.example.com/page/",
    robots_policy: { index: true, follow: false, max_snippet: 100 },
    social_title: "Social title",
    social_description: "Social description",
    social_image: { asset_id: ASSET, version: 2 },
    structured_data_type_hint: "article",
  });
});

test("blank/absent explicit fields normalize to null (fallbacks apply)", () => {
  assert.deepEqual(parseSeoDocument({}), emptySeoDocument());
  assert.equal(parseSeoDocument({ seo_title: "   " }).seo_title, null);
  assert.equal(parseSeoDocument({ meta_description: "" }).meta_description, null);
});

test("unknown fields are rejected — the payload is a closed model", () => {
  const issues = issuesOf(() => parseSeoDocument({ seo_title: "t", keywords: "spam, spam" }));
  assert.ok(issues.some((i) => i.path === "/keywords"));
});

test("CRLF and control characters never enter stored values", () => {
  for (const value of ["title\nwith newline", "title\r\n", "tab\tinside"]) {
    const issues = issuesOf(() => parseSeoDocument({ seo_title: value }));
    assert.ok(
      issues.some((i) => i.path === "/seo_title"),
      value,
    );
  }
});

test("robots policy is typed — raw directive strings and unknown keys are rejected", () => {
  const issues = issuesOf(() => parseSeoDocument({ robots_policy: "noindex, nofollow" }));
  assert.ok(issues.some((i) => i.code === "SEO_ROBOTS_INVALID"));
  const unknownIssues: { code: string; path: string; message: string }[] = [];
  parseSeoRobotsPolicy({ index: true, nosnippet_: true }, "/robots_policy", unknownIssues);
  assert.ok(unknownIssues.some((i) => i.message.includes("unknown robots directive")));
});

test("robots policy defaults are index/follow, optional directives type-check", () => {
  assert.deepEqual(parseSeoRobotsPolicy({}, "/", []), { index: true, follow: true });
  assert.deepEqual(
    parseSeoRobotsPolicy(
      {
        noarchive: true,
        nosnippet: true,
        max_snippet: 0,
        max_image_preview: "large",
        max_video_preview: -1,
      },
      "/",
      [],
    ),
    {
      index: true,
      follow: true,
      noarchive: true,
      nosnippet: true,
      max_snippet: 0,
      max_image_preview: "large",
      max_video_preview: -1,
    },
  );
  const previewIssues: { code: string; path: string; message: string }[] = [];
  parseSeoRobotsPolicy({ max_image_preview: "gigantic" }, "/robots_policy", previewIssues);
  assert.ok(previewIssues.some((i) => i.code === "SEO_ROBOTS_INVALID"));
  const snippetIssues: { code: string; path: string; message: string }[] = [];
  parseSeoRobotsPolicy({ max_snippet: -1 }, "/robots_policy", snippetIssues);
  assert.ok(snippetIssues.length > 0);
});

test("social image is a media reference with the M07 version-pinning seam", () => {
  assert.deepEqual(parseSeoDocument({ social_image: { asset_id: ASSET } }).social_image, {
    asset_id: ASSET,
  });
  const bad = issuesOf(() => parseSeoDocument({ social_image: { asset_id: "not-a-uuid" } }));
  assert.ok(bad.some((i) => i.path === "/social_image"));
  assert.ok(
    issuesOf(() => parseSeoDocument({ social_image: { asset_id: ASSET, version: 0 } })).length > 0,
  );
});

test("structured data hint is a closed v1 set", () => {
  assert.deepEqual(
    [...STRUCTURED_DATA_TYPE_HINTS],
    ["web_page", "article", "news_article", "blog_posting"],
  );
  assert.equal(
    parseSeoDocument({ structured_data_type_hint: "news_article" }).structured_data_type_hint,
    "news_article",
  );
  assert.ok(issuesOf(() => parseSeoDocument({ structured_data_type_hint: "Product" })).length > 0);
});
