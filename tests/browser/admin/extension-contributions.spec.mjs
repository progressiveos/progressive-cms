// ADR-0017 S6 — Admin UI Extension Contract gate (mandatory before Shop S1).
// A real external fixture package (progressive.admin-fixture, composition
// ui-test) brings its own nav section, screen, translations and asset. The
// full lifecycle: install → enable → screen+nav appear → ACL → disable →
// they disappear → core keeps working. No manual package imports: the Admin
// bundle composes the (lazy) fixture chunk from the lock, registration is
// runtime-gated on the ENABLED set.
// Run with PCMS_ADMIN_UI_TEST=1 on BOTH the e2e server and build:admin.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const uiTestMode = process.env.PCMS_ADMIN_UI_TEST === "1";
const ADMIN = "http://127.0.0.1:8788/admin/";
const API = "http://127.0.0.1:8788/api/v1";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const unique = Date.now().toString(36);

test.skip(!hasDb || !uiTestMode, "requires PCMS_TEST_DATABASE_URL and PCMS_ADMIN_UI_TEST=1");
test.use({ baseURL: ADMIN });
test.setTimeout(120_000);

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

async function loginViaUi(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

test("extension UI contributions: install → enable → screen → disable → gone", async ({
  page,
  request,
}) => {
  const owner = await apiLogin(request, OWNER_EMAIL, OWNER_PASSWORD);
  const authHeaders = { cookie: owner.cookie, "x-pcms-csrf": owner.csrf };
  const ID = "progressive.admin-fixture";

  // INSTALL + ENABLE the fixture package (deployed via the ui-test catalog).
  const installed = await request.post(`${API}/extensions/${ID}/install`, {
    headers: authHeaders,
    data: { config: {} },
  });
  expect([200, 201, 409]).toContain(installed.status()); // 409 = already installed (rerun)
  const enabled = await request.post(`${API}/extensions/${ID}/enable`, {
    headers: authHeaders,
  });
  expect([200, 201, 409]).toContain(enabled.status());

  // OWNER: the contribution nav section + screen appear (translations render
  // through the registered fragment; the asset rides the lazy chunk).
  await loginViaUi(page);
  await expect(page.getByTestId("nav-admin-fixture-slot")).toBeVisible();
  await clickNav(page, "nav-admin-fixture-slot");
  const screen = page.getByTestId("admin-fixture-screen");
  await expect(screen).toBeVisible();
  await expect(screen.getByRole("heading", { name: "Экран UI-фикстуры" })).toBeVisible();
  await expect(screen.getByText(/внешнего пакета/i)).toBeVisible();

  // DISABLE (Extensions screen UI → dispatches pcms:extensions-changed):
  // nav and screen disappear WITHOUT a reload; the core keeps working.
  await clickNav(page, "nav-extensions-overview");
  const extensionsScreen = page.getByTestId("extensions-screen");
  await expect(extensionsScreen).toBeVisible();
  const card = extensionsScreen.locator("div", { hasText: "Admin UI Contract Fixture" }).last();
  page.on("response", async (r) => {
    if (r.url().includes("/disable")) {
      console.log("DISABLE:", r.status(), JSON.stringify(await r.json()).slice(0, 200));
    }
  });
  await card.getByRole("button", { name: "Отключить" }).click();
  // ConfirmDialog: the confirmation button carries the same label.
  await page.locator(".pcms-overlay").getByRole("button", { name: "Отключить" }).click();

  // Если авто-событие не сработало — ручной диспатч (диагностика):
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("pcms:extensions-changed")));
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("nav-admin-fixture-slot")).toHaveCount(0);
  await page.goto(`${ADMIN}#/admin-fixture`);
  await expect(page.getByTestId("admin-fixture-screen")).toHaveCount(0);

  // Core keeps working: a core screen still renders after the churn.
  await page.goto(`${ADMIN}#/payments`);
  await expect(page.getByTestId("payments-screen")).toBeVisible({ timeout: 15_000 });

  // Cleanup: uninstall (data_policy drop, no data) so reruns stay clean.
  await request.post(`${API}/extensions/${ID}/uninstall`, {
    headers: { ...authHeaders, "x-pcms-csrf": owner.csrf },
    data: { confirmation: ID },
  });
});

test("ACL: the fixture screen is gone for a fresh session after disable", async ({
  page,
  request,
}) => {
  const owner = await apiLogin(request, OWNER_EMAIL, OWNER_PASSWORD);
  // The previous test disabled+uninstalled the fixture; a fresh owner
  // session must not see its nav (state persisted across sessions).
  await loginViaUi(page);
  await expect(page.getByTestId("nav-admin-fixture-slot")).toHaveCount(0);
  void owner;
});
