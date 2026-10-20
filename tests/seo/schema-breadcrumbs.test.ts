// PCMS-SEO-T014 — BreadcrumbList renderer (spec §38). The normalized trail
// arrives from the routing/navigation strategy; positions are 1-based; the
// current crumb may omit its url. No trail → no node, never a guess.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BreadcrumbFacts, buildBreadcrumbNode, validateGraphNode } from "@pcms/seo";

const TRAIL: BreadcrumbFacts = {
  id: "https://example.ru/services/audit/#breadcrumb",
  items: [
    { name: "Главная", url: "https://example.ru/" },
    { name: "Услуги", url: "https://example.ru/services/" },
    { name: "Аудит", url: "https://example.ru/services/audit/" },
  ],
};

test("breadcrumb items carry position, name and url where appropriate", () => {
  const node = buildBreadcrumbNode(TRAIL);
  assert.equal(node["@type"], "BreadcrumbList");
  assert.deepEqual(node.itemListElement, [
    { "@type": "ListItem", position: 1, name: "Главная", item: "https://example.ru/" },
    { "@type": "ListItem", position: 2, name: "Услуги", item: "https://example.ru/services/" },
    { "@type": "ListItem", position: 3, name: "Аудит", item: "https://example.ru/services/audit/" },
  ]);
  assert.deepEqual(validateGraphNode(node), []);
});

test("the current crumb may omit its url; unsafe urls are rejected", () => {
  const node = buildBreadcrumbNode({
    id: TRAIL.id,
    items: [
      { name: "Главная", url: "https://example.ru/" },
      { name: "Аудит", url: null },
    ],
  });
  assert.deepEqual(node.itemListElement, [
    { "@type": "ListItem", position: 1, name: "Главная", item: "https://example.ru/" },
    { "@type": "ListItem", position: 2, name: "Аудит" },
  ]);
  assert.throws(
    () => buildBreadcrumbNode({ id: TRAIL.id, items: [{ name: "X", url: "javascript:alert(1)" }] }),
    (err: Error) => err.message.includes("absolute http(s) URL"),
  );
});

test("an empty trail is invalid input, not an empty node", () => {
  assert.throws(
    () => buildBreadcrumbNode({ id: TRAIL.id, items: [] }),
    (err: Error) => err.message.includes("must not be empty"),
  );
});
