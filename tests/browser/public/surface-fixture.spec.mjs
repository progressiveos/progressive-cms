// Extension Contract 2.0 browser acceptance (CORE-SHOP-01 P0-b/P0-c; ADR-0018).
// Fixture: progressive.platform-fixture (composition ui-test). Covers:
// install/enable → transactional operation (+ rollback negative) → site-level
// mount → canonical URL WITHOUT /x/ → base-template view render → sitemap →
// unauthenticated mutation refused. Run with PCMS_ADMIN_UI_TEST=1.
// @ts-check
import { request as httpRequest } from "node:http";
import { expect, test } from "@playwright/test";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const uiTestMode = process.env.PCMS_ADMIN_UI_TEST === "1";
const BASE = "http://127.0.0.1:8788";
const API = `${BASE}/api/v1`;
const FIXTURE = "progressive.platform-fixture";
const SLUG = `w${Date.now().toString(36)}`;

const unique = Date.now().toString(36);
test.skip(!hasDb || !uiTestMode, "requires PCMS_TEST_DATABASE_URL and PCMS_ADMIN_UI_TEST=1");
test.setTimeout(120_000);

async function ownerContext(request) {
  const login = await request.post(`${API}/auth/login`, {
    data: {
      email: "owner@example.com",
      password: process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!",
    },
  });
  expect(login.ok()).toBe(true);
  const body = await login.json();
  const cookie = login
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value)
    .find((value) => value.startsWith("pcms_session="));
  return { cookie: cookie.split(";")[0], csrf: body.csrf_token };
}

test("surface fixture: tx operation → mount → canonical view → sitemap → security", async ({
  request,
}) => {
  const owner = await ownerContext(request);
  const headers = { cookie: owner.cookie, "x-pcms-csrf": owner.csrf };

  // install + enable the fixture
  expect((await request.post(`${API}/extensions/${FIXTURE}/install`, { headers })).ok()).toBe(true);
  expect((await request.post(`${API}/extensions/${FIXTURE}/enable`, { headers })).ok()).toBe(true);

  // R1: extension namespace keys are granted EXPLICITLY. The operator makes
  // a custom role with the fixture keys and assigns it to himself, then
  // re-authenticates (role bundles resolve at login).
  const roleCreate = await request.post(`${API}/roles-admin`, {
    headers,
    data: {
      action: "create",
      role_key: `FIXTURE_OP_${unique.toUpperCase()}`,
      name: "Fixture operator",
      permissions: ["platform.test.read", "platform.test.write", "site.configure"],
    },
  });
  expect(roleCreate.status(), await roleCreate.text()).toBe(200);
  const actor = await (await request.get(`${API}/actor`, { headers })).json();
  expect(
    (
      await request.post(`${API}/users/${actor.actor_id}/roles`, {
        headers,
        data: { role_key: `FIXTURE_OP_${unique.toUpperCase()}` },
      })
    ).ok(),
  ).toBe(true);
  const relogin = await request.post(`${API}/auth/login`, {
    data: {
      email: "owner@example.com",
      password: process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!",
    },
  });
  const fresh = await relogin.json();
  headers.cookie = relogin
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value)
    .find((value) => value.startsWith("pcms_session="))
    .split(";")[0];
  headers["x-pcms-csrf"] = fresh.csrf_token;

  // transactional operation: insert + audit + outbox in one tx
  const created = await request.post(`${API}/extensions/${FIXTURE}/operations/create-item`, {
    headers,
    data: { slug: SLUG, title: `Widget ${SLUG}` },
  });
  expect(created.ok()).toBe(true);

  // rollback negative: fail_after_write must leave NO row
  const failed = await request.post(`${API}/extensions/${FIXTURE}/operations/create-item`, {
    headers,
    data: { slug: `rollback-${SLUG}`, title: "never", fail_after_write: true },
  });
  expect(failed.status()).toBe(500);

  // mount assignment (canonical URL without /x/)
  const mounted = await request.put(`${API}/extensions/${FIXTURE}/mount`, {
    headers,
    data: { path: "/fixtures" },
  });
  expect(mounted.ok()).toBe(true);
  const activeMount = await request.get(`${API}/extensions/${FIXTURE}/mount`, { headers });
  expect(activeMount.status(), await activeMount.text()).toBe(200);
  expect(await activeMount.json()).toMatchObject({
    extension_id: FIXTURE,
    mount_path: "/fixtures",
  });

  // canonical page renders through the package base template
  const page = await request.get(`${BASE}/fixtures/widgets/${SLUG}/`);
  expect(page.status(), await page.text()).toBe(200);
  const html = await page.text();
  expect(html).toContain('data-fixture-view="widget"');
  expect(html).toContain(`data-fixture-slug>${SLUG}<`);

  // SEO policy (CORE-SHOP-SEO-01): the technical space does NOT render
  // duplicate HTML — one permanent 308 to the canonical mount URL.
  const technical = await request.get(`${BASE}/x/${FIXTURE}/widgets/${SLUG}`, {
    maxRedirects: 0,
  });
  expect(technical.status()).toBe(308);
  expect(technical.headers().location).toBe(`/fixtures/widgets/${SLUG}/`);

  // self-canonical link points at the mount-based URL, never /x/
  const canonicalPage = await request.get(`${BASE}/fixtures/widgets/${SLUG}/`);
  expect((await canonicalPage.text()).replace(/\n/g, "")).toContain(
    `rel="canonical" href="/fixtures/widgets/${SLUG}/"`,
  );

  // rollback negative really rolled back (no row → route 404)
  const rolled = await request.get(`${BASE}/fixtures/widgets/rollback-${SLUG}/`);
  expect(rolled.status()).toBe(404);

  // sitemap: candidates include the fixture-owned URL. The e2e server runs
  // a non-production SEO environment whose sitemap is EMPTY by design (§13
  // environment guard) — the hard 200-with-URL assertion lives in the
  // runtime acceptance on a production-env instance (ADR-0018 §Acceptance).
  const sitemap = await request.get(`${BASE}/sitemap.xml`);
  if (sitemap.status() === 200) {
    expect(await sitemap.text()).toContain(`/fixtures/widgets/${SLUG}/`);
  } else {
    expect(sitemap.status()).toBe(404); // guarded: nothing listed at all
  }

  // A JSON body without Content-Type is rejected by the HTTP parser before
  // any guest mutation handler can run (the same behavior curl sees).
  const contentTypeMissing = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: 8788,
        path: `/fixtures/widgets/${SLUG}/notes`,
        method: "POST",
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ body: "missing Content-Type" }));
  });
  expect(contentTypeMissing).toBe(415);

  // The equivalent request with JSON media type reaches the public handler.
  const guestMutation = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: 8788,
        path: `/fixtures/widgets/${SLUG}/notes`,
        method: "POST",
        headers: {
          origin: BASE,
          "content-type": "application/json",
          "idempotency-key": `fixture-note-${unique}`,
        },
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode, setCookie: response.headers["set-cookie"] });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ body: "with Content-Type" }));
  });
  expect(guestMutation.status).toBe(200);
  expect(guestMutation.setCookie.join("; ")).toMatch(/pcms_guest=.*HttpOnly/);

  // security negative: a REALLY anonymous session-only mutation is refused
  // — 401 from the visibility gate, never a silent success.
  const anon = await new Promise((resolve) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: 8788,
        path: "/fixtures/widgets",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => resolve(response.statusCode),
    );
    req.end(JSON.stringify({ slug: "x", title: "x" }));
  });
  expect([401, 403]).toContain(anon);

  // mount move: old published URLs answer one permanent 308 to the new
  // mount; the new mount renders 200; no duplicate HTML anywhere.
  const moved = await request.put(`${API}/extensions/${FIXTURE}/mount`, {
    headers,
    data: { path: "/fixtures-2" },
  });
  expect(moved.ok()).toBe(true);
  // Mount propagation is eventually consistent (≤5s prefix cache, ADR-0018).
  await new Promise((resolve) => setTimeout(resolve, 5100));
  const oldUrl = await request.get(`${BASE}/fixtures/widgets/${SLUG}/`, { maxRedirects: 0 });
  expect(oldUrl.status()).toBe(308);
  expect(oldUrl.headers().location).toBe(`/fixtures-2/widgets/${SLUG}/`);
  const newUrl = await request.get(`${BASE}/fixtures-2/widgets/${SLUG}/`);
  expect(newUrl.status()).toBe(200);
  const localization = await request.put(`${API}/localization`, {
    headers,
    data: { enabled: true, default_locale: "en-US", locales: ["en-US", "ru-RU"] },
  });
  expect(localization.status(), await localization.text()).toBe(200);
  const localizedUrl = await request.get(`${BASE}/ru/fixtures-2/widgets/${SLUG}/`);
  expect(localizedUrl.status(), await localizedUrl.text()).toBe(200);
  expect((await localizedUrl.text()).replace(/\n/g, "")).toContain(
    `rel="canonical" href="/ru/fixtures-2/widgets/${SLUG}/"`,
  );
  const localizedTechnical = await request.get(`${BASE}/ru/x/${FIXTURE}/widgets/${SLUG}`, {
    maxRedirects: 0,
  });
  expect(localizedTechnical.status()).toBe(308);
  expect(localizedTechnical.headers().location).toBe(`/ru/fixtures-2/widgets/${SLUG}/`);
  const localizedMutation = await request.post(`${BASE}/ru/fixtures-2/widgets/${SLUG}/notes`, {
    headers: {
      origin: BASE,
      "content-type": "application/json",
      "idempotency-key": `fixture-localized-note-${unique}`,
    },
    data: { body: "localized route" },
  });
  expect(localizedMutation.status(), await localizedMutation.text()).toBe(200);
  expect(
    (
      await request.put(`${API}/localization`, {
        headers,
        data: { enabled: false, default_locale: "en-US", locales: ["en-US"] },
      })
    ).ok(),
  ).toBe(true);
  // move it back for the disable step
  expect(
    (
      await request.put(`${API}/extensions/${FIXTURE}/mount`, {
        headers,
        data: { path: "/fixtures" },
      })
    ).ok(),
  ).toBe(true);

  // disable → routes gone immediately (R3)
  expect((await request.post(`${API}/extensions/${FIXTURE}/disable`, { headers })).ok()).toBe(true);
  const afterDisable = await request.get(`${BASE}/fixtures/widgets/${SLUG}/`);
  expect(afterDisable.status()).toBe(404);
});
