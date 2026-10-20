// PCMS-SEO-T016 — Schema Registry + @graph composer (spec §42): duplicate
// nodes suppressed, conflicting nodes detected with the site-level winner,
// broken facts degrade to diagnostics, output order deterministic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { composeStructuredData, type StructuredDataPageInput, serializeJsonLd } from "@pcms/seo";

const ORIGIN = "https://example.ru";

const INPUT: StructuredDataPageInput = {
  website: { id: `${ORIGIN}/#website`, name: "Пример", url: ORIGIN },
  organization: { id: `${ORIGIN}/#organization`, name: "ООО «Пример»", url: ORIGIN },
  webpage: {
    id: `${ORIGIN}/news/x/#webpage`,
    name: "Новость",
    url: `${ORIGIN}/news/x/`,
    is_part_of: `${ORIGIN}/#website`,
  },
  breadcrumbs: {
    id: `${ORIGIN}/news/x/#breadcrumb`,
    items: [
      { name: "Главная", url: ORIGIN },
      { name: "Новость", url: null },
    ],
  },
  article: {
    id: `${ORIGIN}/news/x/#article`,
    type: "news_article",
    headline: "Новость",
    url: `${ORIGIN}/news/x/`,
    date_published: "2026-09-01T10:00:00+03:00",
    date_modified: null,
    author: null,
    publisher: { id: `${ORIGIN}/#organization`, name: "ООО «Пример»" },
  },
  video: null,
};

test("composes one deterministic @graph document from supplied facts", () => {
  const composed = composeStructuredData(INPUT);
  assert.deepEqual(composed.diagnostics, []);
  assert.deepEqual(
    composed.nodes.map((n) => n["@type"]),
    ["WebSite", "Organization", "WebPage", "BreadcrumbList", "NewsArticle"],
  );
  assert.equal(composed.json_ld.length, 1);
  const parsed = JSON.parse(composed.json_ld[0] as string) as {
    "@context": string;
    "@graph": unknown[];
  };
  assert.equal(parsed["@context"], "https://schema.org");
  assert.equal(parsed["@graph"].length, 5);
  // Deterministic: byte-identical for identical input.
  assert.equal(composed.json_ld[0], composeStructuredData(INPUT).json_ld[0]);
});

test("empty input produces no script and no diagnostics", () => {
  const empty = composeStructuredData({
    website: null,
    organization: null,
    webpage: null,
    article: null,
    breadcrumbs: null,
    video: null,
  });
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.json_ld, []);
  assert.deepEqual(empty.diagnostics, []);
});

test("identical facts are suppressed; conflicting @id nodes report the earlier winner (§42)", () => {
  // Two identical page nodes from the same slot values → one node, no noise.
  const single = composeStructuredData(INPUT);
  assert.equal(single.nodes.filter((n) => n["@id"] === `${ORIGIN}/#website`).length, 1);

  // Webpage and article accidentally share an @id with different content.
  const webpage = INPUT.webpage;
  assert.ok(webpage != null);
  const conflicting = composeStructuredData({
    ...INPUT,
    webpage: { ...webpage, id: `${ORIGIN}/news/x/#article` },
  });
  assert.ok(conflicting.diagnostics.some((d) => d.code === "SEO_STRUCTURED_DATA_CONFLICT"));
  const sharing = conflicting.nodes.filter((n) => n["@id"] === `${ORIGIN}/news/x/#article`);
  assert.equal(sharing.length, 1);
  assert.equal(sharing[0]?.["@type"], "WebPage"); // earlier (registry-order) node wins
});

test("broken facts degrade to diagnostics, never to invalid JSON-LD output", () => {
  const article = INPUT.article;
  assert.ok(article != null);
  const broken = composeStructuredData({
    ...INPUT,
    article: { ...article, date_published: "someday", url: `${ORIGIN}/news/x/` },
  });
  assert.ok(broken.diagnostics.some((d) => d.code === "SEO_STRUCTURED_DATA_INVALID"));
  assert.ok(!broken.nodes.some((n) => n["@id"] === `${ORIGIN}/news/x/#article`));
  // The rest of the graph still parses as valid JSON.
  const parsed = JSON.parse(broken.json_ld[0] as string) as { "@graph": unknown[] };
  assert.equal(parsed["@graph"].length, 4);
});

test("serialization is script-safe: < and U+2028/2029 escaped (T017 layer)", () => {
  assert.equal(serializeJsonLd({ a: "</script>" }), '{"a":"\\u003c/script>"}');
  assert.ok(!serializeJsonLd({ x: "\u2028\u2029" }).includes("\u2028"));
});
