// Public multilingual acceptance (work package §47): enable the opt-in
// capability through the Admin API, build a ru-RU default page plus an en-US
// translation, publish both through the normal per-locale publication flow,
// then verify prefixed routing, html lang, hreflang, the missing-translation
// 404 (no wrong-language fallback) and locale-scoped search.
//
// Single-language compatibility stays proven by the entire existing corpus
// (it never enables localization and asserts the baseline behavior).
// @ts-check
import { expect, test } from "@playwright/test";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const API = "http://127.0.0.1:8788/api/v1";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const unique = Date.now().toString(36);

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

async function apiLogin(request, email, password) {
  const response = await request.post(`${API}/auth/login`, { data: { email, password } });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const cookies = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie");
  const cookieLine = cookies
    .map((header) => header.value)
    .find((value) => value.startsWith("pcms_session="));
  return { cookie: cookieLine.split(";")[0], csrf: body.csrf_token };
}

function authHeaders(owner) {
  return { cookie: owner.cookie, "x-pcms-csrf": owner.csrf };
}

async function publishViaChangeset(request, owner, { entryId, revisionId, path, locale, context }) {
  const seal = await request.post(`${API}/revisions/${revisionId}/seal`, {
    headers: authHeaders(owner),
    data: {},
  });
  expect(seal.ok(), await seal.text()).toBe(true);
  const changeset = await request.post(`${API}/changesets`, {
    headers: authHeaders(owner),
    data: { title: `m17-loc-${unique}-${locale ?? "default"}` },
  });
  expect(changeset.ok(), await changeset.text()).toBe(true);
  const changesetId = (await changeset.json()).id;
  const routeOperation = {
    kind: "set",
    site_id: await siteId(request, owner),
    path,
    ...(locale === undefined ? {} : { locale }),
  };
  const item = await request.post(`${API}/changesets/${changesetId}/items`, {
    headers: authHeaders(owner),
    data: {
      entity_type: "entry",
      entity_id: entryId,
      intent: "PUBLISH",
      target_revision_id: revisionId,
      expected_generation: 0,
      ...(context === undefined ? {} : { context }),
      route_operation: routeOperation,
    },
  });
  expect(item.ok(), await item.text()).toBe(true);
  const preflight = await request.post(`${API}/changesets/${changesetId}/preflight`, {
    headers: authHeaders(owner),
    data: {},
  });
  expect(preflight.ok(), await preflight.text()).toBe(true);
  const applied = await request.post(`${API}/changesets/${changesetId}/apply`, {
    headers: authHeaders(owner),
  });
  expect(applied.ok(), await applied.text()).toBe(true);
}

let siteIdCache = null;
async function siteId(request, owner) {
  if (siteIdCache !== null) return siteIdCache;
  const bootstrap = await request.get(`${API}/agent/bootstrap`, {
    headers: { cookie: owner.cookie },
  });
  const body = await bootstrap.json();
  siteIdCache = body.site.id;
  return siteIdCache;
}

test("public multilingual lifecycle: enable → translate → publish → verify", async ({
  request,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "lifecycle runs on desktop only");
  const owner = await apiLogin(request, OWNER_EMAIL, OWNER_PASSWORD);

  // 1. Enable multilingual: ru-RU default, en-US secondary (path prefix).
  const enabled = await request.put(`${API}/localization`, {
    headers: authHeaders(owner),
    data: { enabled: true, default_locale: "ru-RU", locales: ["ru-RU", "en-US"] },
  });
  expect(enabled.ok(), await enabled.text()).toBe(true);
  const localizationState = await request.get(`${API}/localization`, {
    headers: { cookie: owner.cookie },
  });
  const localizationBody = await localizationState.json();
  expect(localizationBody.enabled).toBe(true);
  expect(localizationBody.routing_strategy).toBe("path_prefix");

  // 2. Create the default-locale page (RU content).
  const ruTitle = `Услуги локализации ${unique}`;
  const created = await request.post(`${API}/entries`, {
    headers: authHeaders(owner),
    data: {
      content_type: "page",
      payload: {
        fields: { title: ruTitle, intro: `Введение ${unique}` },
        blocks: { schema_version: 1, blocks: [] },
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { entry_id: ruEntryId, revision_id: ruRevisionId } = await created.json();

  // 3. Add the en-US translation (copy source as the working draft).
  const translation = await request.post(`${API}/entries/${ruEntryId}/translations`, {
    headers: authHeaders(owner),
    data: { locale: "en-US", copy_from_source: true },
  });
  expect(translation.ok(), await translation.text()).toBe(true);
  const { entry_id: enEntryId, revision_id: enRevisionId } = await translation.json();

  // Translations listing sees both versions of the same logical entity.
  const list = await request.get(`${API}/entries/${ruEntryId}/translations`, {
    headers: { cookie: owner.cookie },
  });
  const listBody = await list.json();
  const locales = listBody.items.map((item) => item.locale).sort();
  expect(locales).toEqual(["default", "en-US"]);

  // 4. Localized titles: edit the EN draft so the languages are distinguishable.
  const enTitle = `Localization services ${unique}`;
  const patched = await request.patch(`${API}/revisions/${enRevisionId}`, {
    headers: authHeaders(owner),
    data: {
      payload: {
        fields: { title: enTitle, intro: `Introduction ${unique}` },
        blocks: { schema_version: 1, blocks: [] },
      },
      expected_edit_generation: 0,
    },
  });
  expect(patched.ok(), await patched.text()).toBe(true);

  // 5. Publish each locale independently through the normal changeset flow.
  await publishViaChangeset(request, owner, {
    entryId: ruEntryId,
    revisionId: ruRevisionId,
    path: `/loc-${unique}/`,
  });
  await publishViaChangeset(request, owner, {
    entryId: enEntryId,
    revisionId: enRevisionId,
    path: `/loc-${unique}-en/`,
    locale: "en-US",
    context: "en-US",
  });

  // 6. Default locale keeps unprefixed URLs and ru content + html lang.
  await page.goto(`${ADMIN}#/`);
  await page.goto(`http://127.0.0.1:8788/loc-${unique}/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "ru-RU");
  await expect(page.getByRole("heading", { name: ruTitle })).toBeVisible();

  // 7. Secondary locale serves the EN version under /en/ with its own slug.
  await page.goto(`http://127.0.0.1:8788/en/loc-${unique}-en/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByRole("heading", { name: enTitle })).toBeVisible();
  const head = await page.locator("head").innerHTML();
  // Reciprocal hreflang alternates — published locales only.
  expect(head).toContain('hreflang="en-US"');
  expect(head).toContain('hreflang="ru-RU"');
  // (Self-canonical is composed from the primary domain binding — spec §38
  // never uses the request Host — and asserted by the SEO suite; this e2e
  // environment intentionally has no domain binding.)

  // 8. No wrong-language fallback: an EN URL without an EN publication 404s.
  const missing = await request.get(`http://127.0.0.1:8788/en/loc-${unique}/`);
  expect(missing.status()).toBe(404);
  // Unknown locale prefix never maps to content.
  const fr = await request.get(`http://127.0.0.1:8788/fr/loc-${unique}/`);
  expect(fr.status()).toBe(404);

  // Locale-scoped search (documents indexed per publication context, query
  // filtered by locale) is covered by the node suite
  // (tests/search: "site and locale scoping keeps tenants and languages
  // isolated"); the e2e harness has no worker to drain the indexing outbox.

  // Sitemap alternates are covered by the pure builder test
  // (tests/localization/sitemap.test.ts); the dev-guarded e2e environment
  // intentionally serves 404 for /sitemap.xml (noindex, SEO spec §15).

  // 11. Disable → the site falls back to single-language behavior; prefixed
  // URLs stop resolving (capability OFF means baseline).
  const disabled = await request.put(`${API}/localization`, {
    headers: authHeaders(owner),
    data: { enabled: false, default_locale: "ru-RU", locales: ["ru-RU"] },
  });
  expect(disabled.ok(), await disabled.text()).toBe(true);
  const afterDisable = await request.get(`http://127.0.0.1:8788/en/loc-${unique}-en/`);
  expect(afterDisable.status()).toBe(404);
});
