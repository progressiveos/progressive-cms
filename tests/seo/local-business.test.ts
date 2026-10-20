// PCMS-SEO-T012 — LocalBusiness renderer/selection policy (spec §34).
// LocalBusiness is emitted only on explicit declaration — never inferred.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOrganizationNode,
  buildWebSiteNode,
  parseSeoSiteIdentity,
  selectOrganizationSchema,
} from "@pcms/seo";

const ORIGIN = "https://example.ru";
const ID = `${ORIGIN}/#organization`;

test("LocalBusiness is emitted only when explicitly declared with facts", () => {
  const explicit = selectOrganizationSchema(
    parseSeoSiteIdentity({
      site_name: "Кофейня",
      organization_type: "LocalBusiness",
      local_business: { subtype: "CafeOrCoffeeShop", opening_hours: "Mo-Su 08:00-22:00" },
    }),
  );
  assert.equal(explicit.type, "LocalBusiness");

  const node = buildOrganizationNode({
    id: ID,
    name: "Кофейня",
    url: ORIGIN,
    same_as: null,
    local_business: {
      subtype: "CafeOrCoffeeShop",
      telephone: "+7 495 000-00-00",
      opening_hours: "Mo-Su 08:00-22:00",
      price_range: "₽₽",
      geo: { latitude: 55.75, longitude: 37.61 },
    },
  });
  assert.deepEqual(node["@type"], ["LocalBusiness", "CafeOrCoffeeShop"]);
  assert.equal(node.openingHours, "Mo-Su 08:00-22:00");
  assert.equal(node.priceRange, "₽₽");
  assert.deepEqual(node.geo, { "@type": "GeoCoordinates", latitude: 55.75, longitude: 37.61 });
});

test("a plain Organization is never blindly marked LocalBusiness (§34)", () => {
  // No organization_type at all → Organization even with stray facts present.
  const selection = selectOrganizationSchema(
    parseSeoSiteIdentity({ site_name: "B2B", local_business: { subtype: "ProfessionalService" } }),
  );
  assert.equal(selection.type, "Organization");
  assert.equal(selection.local_business, null);
  const node = buildOrganizationNode({ id: ID, name: "B2B", url: ORIGIN });
  assert.equal(node["@type"], "Organization");
  assert.ok(!("openingHours" in node));

  // organization_type LocalBusiness without facts → plain LocalBusiness type.
  const bare = selectOrganizationSchema(
    parseSeoSiteIdentity({ site_name: "S", organization_type: "LocalBusiness" }),
  );
  assert.equal(bare.type, "Organization");
});

test("subtype without LocalBusiness facts never fabricates the type", () => {
  const node = buildOrganizationNode({ id: ID, name: "X", url: ORIGIN, same_as: null });
  assert.equal(node["@type"], "Organization");
  // WebSite node stays independent of org selection (homepage graph, §21).
  const site = buildWebSiteNode({ id: `${ORIGIN}/#website`, name: "X", url: ORIGIN });
  assert.equal(site["@type"], "WebSite");
});
