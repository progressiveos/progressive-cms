// PCMS-SEO-T013 — Article/NewsArticle/BlogPosting renderer (spec §35/§36/§37).
// Dates are public publication facts; authors/images only when actually
// supplied — nothing fabricated.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ArticleFacts, buildArticleNode, validateGraphNode } from "@pcms/seo";

const BASE: ArticleFacts = {
  id: "https://example.ru/news/audit/#article",
  type: "news_article",
  headline: "Итоги аудита",
  url: "https://example.ru/news/audit/",
  date_published: "2026-09-01T10:00:00+03:00",
  date_modified: "2026-09-15T09:30:00+03:00",
  author: { name: "Мария Петрова" },
  publisher: { id: "https://example.ru/#organization", name: "Пример" },
  image_urls: ["https://example.ru/media/a/x/v1/social-abc.jpeg"],
  is_part_of: "https://example.ru/#website",
  in_language: "ru-RU",
};

test("article maps dates/authors/images/publisher; type follows the hint family", () => {
  const node = buildArticleNode(BASE);
  assert.equal(node["@type"], "NewsArticle");
  assert.equal(node.datePublished, BASE.date_published);
  assert.equal(node.dateModified, BASE.date_modified);
  assert.deepEqual(node.author, { "@type": "Person", name: "Мария Петрова" });
  assert.deepEqual(node.publisher, {
    "@type": "Organization",
    "@id": "https://example.ru/#organization",
    name: "Пример",
  });
  assert.deepEqual(node.image, BASE.image_urls);
  assert.deepEqual(node.isPartOf, { "@id": "https://example.ru/#website" });
  assert.deepEqual(validateGraphNode(node), []);
});

test("BlogPosting/Article subtypes map; anonymous authorship is never invented (§37)", () => {
  assert.equal(buildArticleNode({ ...BASE, type: "blog_posting" })["@type"], "BlogPosting");
  assert.equal(buildArticleNode({ ...BASE, type: "article" })["@type"], "Article");
  const anonymous = buildArticleNode({ ...BASE, type: "article", author: null });
  assert.ok(!("author" in anonymous));
});

test("absent facts stay absent; images only when the provider supplies them", () => {
  const minimal = buildArticleNode({
    ...BASE,
    type: "article",
    date_published: null,
    date_modified: null,
    author: null,
    publisher: null,
    image_urls: [],
    is_part_of: null,
    in_language: null,
  });
  for (const key of [
    "datePublished",
    "dateModified",
    "author",
    "publisher",
    "image",
    "inLanguage",
  ]) {
    assert.ok(!(key in minimal), key);
  }
});

test("invalid dates and unknown types are rejected, not silently emitted", () => {
  assert.throws(
    () => buildArticleNode({ ...BASE, date_published: "last Tuesday" }),
    (err: Error) => err.message.includes("ISO 8601"),
  );
  assert.throws(
    // eslint-disable-next-line
    () => buildArticleNode({ ...BASE, type: "faq_page" as never }),
    (err: Error) => err.message.includes("unknown article type"),
  );
  assert.throws(
    () => buildArticleNode({ ...BASE, image_urls: ["javascript:alert(1)"] }),
    (err: Error) => err.message.includes("absolute http(s) URL"),
  );
});
