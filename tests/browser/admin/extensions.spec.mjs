// Admin Extensions workspace (PCMS-EXT-T019; Extensions spec §50/§51, task
// brief §77). Minimum corpus: the extensions read surface is visible to a
// permitted actor, states/capabilities/compatibility render, the update
// preflight surface degrades honestly when no target manifest is configured,
// an ordinary editor cannot manage extensions, and there is no source
// upload/editor anywhere on the screen.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const API = "http://127.0.0.1:8788/api/v1";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const EDITOR_EMAIL = `editor-ext-${Date.now().toString(36)}@example.com`;
const EDITOR_PASSWORD = "e2e-Editor-Pass-2026!";

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });
test.setTimeout(90_000);

async function loginViaUi(page, email = OWNER_EMAIL, password = OWNER_PASSWORD) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(email);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

test("owner sees the extensions surface with lifecycle state and no upload control", async ({
  page,
}) => {
  await loginViaUi(page);
  await clickNav(page, "nav-extensions-overview");
  await expect(page.getByRole("tabpanel", { name: "Установленные" })).toBeVisible();
  // The trusted-catalog model is visible in the copy: no upload/editor.
  await expect(page.getByText(/Ни одно расширение не подключено|v\d+/).first()).toBeVisible();
  const body = await page.getByRole("tabpanel").innerText();
  expect(body).not.toMatch(/загрузить|upload|\.js\b/i);
});

async function apiLogin(request, email, password) {
  const response = await request.post(`${API}/auth/login`, { data: { email, password } });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const cookie = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value)
    .find((value) => value.startsWith("pcms_session="));
  return { cookie: cookie.split(";")[0], csrf: body.csrf_token };
}

test("ordinary editor has no extensions navigation and the API denies the surface", async ({
  page,
  request,
}) => {
  const owner = await apiLogin(request, OWNER_EMAIL, OWNER_PASSWORD);
  const email = `editor-ext-${Date.now().toString(36)}@example.com`;
  const created = await request.post(`${API}/users`, {
    headers: { cookie: owner.cookie, "x-pcms-csrf": owner.csrf },
    data: { display_name: "Ext Editor", email, role_key: "EDITOR" },
  });
  expect(created.ok()).toBe(true);
  const inviteToken = (await created.json()).invite_token;
  const accepted = await request.post(`${API}/auth/invite/accept`, {
    data: { invite_token: inviteToken, password: "e2e-Editor-Pass-2026!" },
  });
  expect(accepted.ok()).toBe(true);

  const editor = await apiLogin(request, email, "e2e-Editor-Pass-2026!");
  const denied = await request.get(`${API}/extensions`, {
    headers: { cookie: editor.cookie },
  });
  expect(denied.status()).toBe(403);

  // UI: no extensions nav item for the editor.
  await loginViaUi(page, email, "e2e-Editor-Pass-2026!");
  await expect(page.getByTestId("nav-extensions-overview")).toHaveCount(0);
});

test("update tab surfaces the blocking/backup state honestly without an apply button", async ({
  page,
}) => {
  await loginViaUi(page);
  await clickNav(page, "nav-extensions-overview");
  await page.getByRole("tab", { name: "Обновления" }).click();
  const panel = page.getByRole("tabpanel");
  // Either the configured preflight (READY/BLOCKED + rollback policy) or the
  // honest "not configured" hint must be visible — never a fake success.
  await expect(
    panel.getByText(/Целевой релиз не настроен|Текущая версия|cms update check/).first(),
  ).toBeVisible();
  expect(await panel.getByRole("button", { name: "Применить обновление" }).count()).toBe(0);
});
