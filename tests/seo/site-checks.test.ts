// PCMS-SEO-T006 — duplicate title/description diagnostics across indexable
// pages (§5/§7): warning-level, deterministic, noindex pages excluded.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SITE_SEO_DEFAULTS,
  duplicateContentIssues,
  emptySeoDocument,
  resolveSeoMetadata,
  type SeoResolvedPage,
} from "@pcms/seo";

function page(entryId: string, pageTitle: string | null, indexable = true): SeoResolvedPage {
  return {
    entryId,
    resolved: resolveSeoMetadata(
      null,
      { page_title: pageTitle, intro: `intro ${entryId}`, hero_image: null },
      DEFAULT_SITE_SEO_DEFAULTS,
    ),
    indexable,
  };
}

test("duplicate titles across indexable pages are warnings with owner details", () => {
  const issues = duplicateContentIssues([
    page("b-entry", "Same"),
    page("a-entry", "Same"),
    page("c-entry", "Unique"),
  ]);
  const dup = issues.find((i) => i.code === "SEO_DUPLICATE_TITLE");
  assert.ok(dup);
  assert.equal(dup.severity, "warning");
  assert.deepEqual(dup.details, { owners: ["a-entry", "b-entry"] });
});

test("noindex pages do not compete — duplicates among them are not reported", () => {
  assert.deepEqual(
    duplicateContentIssues([page("x", "Same", false), page("y", "Same", false)]),
    [],
  );
});

test("duplicate descriptions are reported; missing values are not duplicates", () => {
  const shared = resolveSeoMetadata(
    { ...emptySeoDocument(), meta_description: "Same description" },
    { page_title: null, intro: null, hero_image: null },
    DEFAULT_SITE_SEO_DEFAULTS,
  );
  const issues = duplicateContentIssues([
    { entryId: "1", resolved: shared, indexable: true },
    { entryId: "2", resolved: shared, indexable: true },
  ]);
  assert.equal(issues.filter((i) => i.code === "SEO_DUPLICATE_DESCRIPTION").length, 1);
  // Missing titles resolve to null → no duplicate pairs.
  assert.ok(!issues.some((i) => i.code === "SEO_DUPLICATE_TITLE"));
});

test("output order is deterministic (titles then descriptions, sorted by value)", () => {
  const issues = duplicateContentIssues([
    page("1", "A"),
    page("2", "A"),
    page("3", "B"),
    page("4", "B"),
  ]);
  assert.deepEqual(
    issues.map((i) => [i.code, i.path as string]),
    [
      ["SEO_DUPLICATE_TITLE", "/title"],
      ["SEO_DUPLICATE_TITLE", "/title"],
    ],
  );
  const owners = issues[0]?.details as { owners: readonly string[] } | undefined;
  assert.ok(owners?.owners[0] === "1");
});
