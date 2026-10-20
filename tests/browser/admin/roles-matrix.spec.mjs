// Role-based UI/action matrix (PCMS-ADMIN-T026; Admin spec §56, gate §68).
// The server is the authority: UI may hide controls, but every covered action
// is also proven denied/allowed by real server responses across roles.
// @ts-check
import { expect, request as playwrightRequest, test } from "@playwright/test";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const API = "http://127.0.0.1:8788/api/v1";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const unique = Date.now().toString(36);

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });
test.setTimeout(90_000);

/** API-level login helper returning a cookie+csrf header bag. */
async function apiLogin(request, email, password) {
  const response = await request.post(`${API}/auth/login`, {
    data: { email, password },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const cookies = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie");
  const cookieLine = cookies
    .map((header) => header.value)
    .find((value) => value.startsWith("pcms_session="));
  return {
    cookie: cookieLine.split(";")[0],
    csrf: body.csrf_token,
  };
}

test("seed: invite editor and author through the admin API", async ({ request }) => {
  const owner = await apiLogin(request, "owner@example.com", OWNER_PASSWORD);
  const headers = { cookie: owner.cookie, "x-pcms-csrf": owner.csrf };
  for (const [email, role] of [
    [`editor-${unique}@example.com`, "EDITOR"],
    [`author-${unique}@example.com`, "AUTHOR"],
  ]) {
    const created = await request.post(`${API}/users`, {
      headers,
      data: { display_name: email.split("@")[0], email, role_key: role },
    });
    expect([200, 201]).toContain(created.status());
  }
});

test("permission-key nav rules: AUTHOR has no management sections", async ({ page, request }) => {
  // Author: create + accept via API (server is the source), then log in via UI.
  const owner = await apiLogin(request, "owner@example.com", OWNER_PASSWORD);
  const email = `author-nav-${unique}@example.com`;
  const created = await request.post(`${API}/users`, {
    headers: { cookie: owner.cookie, "x-pcms-csrf": owner.csrf },
    data: { display_name: "Author Nav", email, role_key: "AUTHOR" },
  });
  const inviteToken = (await created.json()).invite_token;
  await request.post(`${API}/auth/invite/accept`, {
    data: { invite_token: inviteToken, password: "author-nav-password-5!" },
  });

  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(email);
  await page.getByLabel("Пароль").fill("author-nav-password-5!");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
  // AUTHOR lacks users.read/audit.read — management nav hidden (server keys).
  await expect(page.getByTestId("nav-users")).toHaveCount(0);
  await expect(page.getByTestId("nav-audit")).toHaveCount(0);
  // Content nav stays available for AUTHOR.
  await expect(page.getByTestId("nav-content-tree")).toBeVisible();
});

test("invite acceptance sets a password through the public route (UI screen)", async ({
  page,
  request,
}) => {
  const owner = await apiLogin(request, "owner@example.com", OWNER_PASSWORD);
  const email = `accept-${unique}@example.com`;
  const created = await request.post(`${API}/users`, {
    headers: { cookie: owner.cookie, "x-pcms-csrf": owner.csrf },
    data: { display_name: "Accept Flow", email, role_key: "AUTHOR" },
  });
  const inviteToken = (await created.json()).invite_token;

  await page.goto(`${ADMIN}#/invite/${inviteToken}`);
  await page.getByLabel("Новый пароль", { exact: true }).fill("accepted-password-11!");
  await page.getByLabel("Повторите пароль").fill("accepted-password-11!");
  await page.getByRole("button", { name: "Установить пароль" }).click();
  await expect(page.getByText("Пароль установлен")).toBeVisible({ timeout: 10_000 });

  // The new user can now log in via API.
  const login = await request.post(`${API}/auth/login`, {
    data: { email, password: "accepted-password-11!" },
  });
  expect(login.ok()).toBe(true);

  // Token is single-use: API replay fails.
  const replay = await request.post(`${API}/auth/invite/accept`, {
    data: { invite_token: inviteToken, password: "another-password-12!" },
  });
  expect(replay.status()).toBeGreaterThanOrEqual(400);
});

test("server denial remains the source: content-only scope cannot seal/publish", async ({
  request,
}) => {
  const owner = await apiLogin(request, "owner@example.com", OWNER_PASSWORD);
  const headers = { cookie: owner.cookie, "x-pcms-csrf": owner.csrf };
  const account = await request.post(`${API}/service-accounts`, {
    headers,
    data: { name: `author-scoped-${unique}`, purpose: "matrix" },
  });
  const accountId = (await account.json()).id;
  const token = await request.post(`${API}/service-accounts/${accountId}/tokens`, {
    headers,
    data: {
      scopes: ["content.read", "content.create", "content.edit"],
      description: "matrix",
      ttl_hours: 24,
    },
  });
  const { raw_secret: rawSecret } = await token.json();
  const scoped = { authorization: `Bearer ${rawSecret}` };

  const draft = await request.post(`${API}/entries`, {
    headers: scoped,
    data: {
      content_type: "news",
      payload: {
        fields: { title: "Author draft", datetime: "2026-09-20T10:00:00Z" },
        blocks: null,
      },
    },
  });
  expect(draft.status()).toBe(201);
  const { revision_id: revisionId } = await draft.json();

  // content-only scope: revision.seal denied (server authority, not UI)
  const seal = await request.post(`${API}/revisions/${revisionId}/seal`, {
    headers: scoped,
    data: {},
  });
  expect(seal.status()).toBe(403);
  const publish = await request.post(`${API}/publications/publish`, {
    headers: scoped,
    data: {
      entity_type: "entry",
      entity_id: "00000000-0000-7000-8000-000000000000",
      target_revision_id: revisionId,
      expected_generation: 0,
    },
  });
  expect(publish.status()).toBe(403);
  const users = await request.get(`${API}/users`, { headers: scoped });
  expect(users.status()).toBe(403);
});
