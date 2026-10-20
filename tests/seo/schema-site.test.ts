// PCMS-SEO-T011 — WebSite/Organization JSON-LD (spec §21/§31/§33/§41).
// Homepage graph validates internally: required properties present, stable
// absolute @ids derived from the canonical origin, only supplied facts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOrganizationNode,
  buildWebPageNode,
  buildWebSiteNode,
  validateGraphNode,
} from "@pcms/seo";

const ORIGIN = "https://example.ru";

test("homepage graph: WebSite + Organization with stable @ids and supplied facts only", () => {
  const website = buildWebSiteNode({ id: `${ORIGIN}/#website`, name: "Пример", url: ORIGIN });
  assert.deepEqual(website, {
    "@type": "WebSite",
    "@id": `${ORIGIN}/#website`,
    name: "Пример",
    url: ORIGIN,
  });

  const org = buildOrganizationNode({
    id: `${ORIGIN}/#organization`,
    name: "ООО «Пример»",
    url: ORIGIN,
    telephone: "+7 495 000-00-00",
    email: "hi@example.ru",
    address: { locality: "Москва", country: "RU" },
    same_as: ["https://t.me/example"],
    logo: `${ORIGIN}/media/a/x/v1/logo-abc.png`,
  });
  assert.equal(org["@type"], "Organization");
  assert.equal(org["@id"], `${ORIGIN}/#organization`);
  assert.equal(org.logo, `${ORIGIN}/media/a/x/v1/logo-abc.png`);
  assert.deepEqual(org.address, {
    "@type": "PostalAddress",
    addressLocality: "Москва",
    addressCountry: "RU",
  });
  assert.deepEqual(org.sameAs, ["https://t.me/example"]);
  // Absent facts are absent nodes — nothing invented.
  assert.ok(!("legalName" in org));
  assert.ok(!("priceRange" in org));

  // The homepage graph validates internally.
  for (const node of [website, org]) assert.deepEqual(validateGraphNode(node), []);
});

test("alternate site name flows into WebSite; internal validation catches broken nodes", () => {
  const website = buildWebSiteNode({
    id: `${ORIGIN}/#website`,
    name: "Пример",
    alternate_name: "Example",
    url: ORIGIN,
  });
  assert.equal(website.alternateName, "Example");
  assert.deepEqual(
    validateGraphNode({ "@type": "WebSite", "@id": "not-absolute", name: "x", url: "" }),
    ["@id must be an absolute http(s) URL", "url must be an absolute http(s) URL"],
  );
  assert.deepEqual(
    validateGraphNode({ "@type": "Organization", "@id": `${ORIGIN}/#organization` }).length > 0,
    true,
  );
});

test("unsafe URLs never enter nodes (spec §70)", () => {
  assert.throws(
    () =>
      buildOrganizationNode({
        id: `${ORIGIN}/#organization`,
        name: "X",
        url: "javascript:alert(1)",
      }),
    (err: Error) => err.message.includes("absolute http(s) URL"),
  );
  assert.throws(
    () => buildOrganizationNode({ id: `${ORIGIN}/#organization`, name: "X", same_as: ["ftp://x"] }),
    (err: Error) => err.message.includes("sameAs"),
  );
});

test("WebPage ties into the graph via stable @ids", () => {
  const page = buildWebPageNode({
    id: `${ORIGIN}/services/#webpage`,
    name: "Услуги",
    url: `${ORIGIN}/services/`,
    is_part_of: `${ORIGIN}/#website`,
    in_language: "ru-RU",
    primary_image_url: `${ORIGIN}/media/a/x/v1/social-abc.jpeg`,
    breadcrumb: `${ORIGIN}/services/#breadcrumb`,
  });
  assert.deepEqual(page.breadcrumb, { "@id": `${ORIGIN}/services/#breadcrumb` });
  assert.deepEqual(page.isPartOf, { "@id": `${ORIGIN}/#website` });
  assert.deepEqual(validateGraphNode(page), []);
});
