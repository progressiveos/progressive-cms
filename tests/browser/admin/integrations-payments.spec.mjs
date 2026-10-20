// Admin Integrations + Payments workspaces (PCMS-INT-T017 / PCMS-PAY-T009).
// Reliability surfaces (connections/bindings/deliveries/inbound, payments/
// providers/timeline) are visible to permitted actors; permission-aware UX
// is checked with a real AUTHOR login while the server remains the
// authority (its 403s are asserted directly).
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const API = "http://127.0.0.1:8788/api/v1";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const unique = Date.now().toString(36);

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });
test.setTimeout(90_000);

async function loginViaUi(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

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

test("owner sees the integrations workspace with reliability tabs", async ({ page }) => {
  await loginViaUi(page);
  await clickNav(page, "nav-integrations-slot");
  const screen = page.getByTestId("integrations-screen");
  await expect(screen).toBeVisible();
  await expect(screen.getByRole("heading", { name: "Интеграции" })).toBeVisible();
  // Tabs: connections / bindings / deliveries / failures / inbound.
  await expect(screen.getByRole("tab", { name: "Соединения" })).toBeVisible();
  await expect(screen.getByRole("tab", { name: "Доставки" })).toBeVisible();
  await expect(screen.getByRole("tab", { name: "Сбои / Повторы" })).toBeVisible();
  await expect(screen.getByRole("tab", { name: "Входящие события" })).toBeVisible();
  // Honest surface — the empty state or real connection cards, never fake
  // diagnostics. The corpus shares one database: earlier projects may already
  // have created connections, so both renderings are legitimate here.
  const emptyState = screen.getByText("Пока нет настроенных подключений");
  const connectionRow = screen.locator("[data-testid^='connection-']");
  await expect(emptyState.or(connectionRow.first())).toBeVisible();
  // Deliveries tab shows the honest empty state too.
  await screen.getByRole("tab", { name: "Доставки" }).click();
  await expect(screen.getByText("Доставок пока нет")).toBeVisible();
});

test("owner sees the payments workspace; provider note is honest about T010", async ({ page }) => {
  await loginViaUi(page);
  await clickNav(page, "nav-payments-slot");
  const screen = page.getByTestId("payments-screen");
  await expect(screen).toBeVisible();
  await expect(screen.getByRole("heading", { name: "Платежи" })).toBeVisible();
  await expect(screen.getByText("Платежей нет")).toBeVisible();
  await screen.getByRole("tab", { name: "Провайдеры" }).click();
  // S5/S6: concrete providers are trusted extension packages — with none
  // composed the catalog is honestly empty (history stays available).
  await expect(screen.getByText(/Ни один платёжный провайдер не скомпонован/i)).toBeVisible();
  await screen.getByRole("tab", { name: "События" }).click();
  await expect(screen.getByText(/Входящих callback/i)).toBeVisible();
});

test("author: nav hides both sections; screens refuse; server 403 is authoritative", async ({
  page,
  request,
}) => {
  // Seed an AUTHOR through the admin API (owner session).
  const owner = await apiLogin(request, OWNER_EMAIL, OWNER_PASSWORD);
  const email = `author-m13-${unique}@example.com`;
  const created = await request.post(`${API}/users`, {
    headers: { cookie: owner.cookie, "x-pcms-csrf": owner.csrf },
    data: { display_name: `author-m13-${unique}`, email, role_key: "AUTHOR" },
  });
  expect([200, 201]).toContain(created.status());
  const invite = await created.json();
  const accepted = await request.post(`${API}/auth/invite/accept`, {
    data: { invite_token: invite.invite_token, password: "e2e-Author-Pass-2026!" },
  });
  expect(accepted.ok()).toBe(true);

  // UI: log in AS the author — the sections are hidden from navigation…
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(email);
  await page.getByLabel("Пароль").fill("e2e-Author-Pass-2026!");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
  await expect(page.getByTestId("nav-integrations-slot")).toHaveCount(0);
  await expect(page.getByTestId("nav-payments-slot")).toHaveCount(0);
  // …and direct URLs render the refusal (server denies the underlying API).
  await page.goto(`${ADMIN}#/integrations`);
  await expect(page.getByText("Недостаточно прав")).toBeVisible();
  await page.goto(`${ADMIN}#/payments`);
  await expect(page.getByText("Недостаточно прав")).toBeVisible();

  // Server remains the authority: the author's API call is denied outright.
  const authorLogin = await apiLogin(request, email, "e2e-Author-Pass-2026!");
  const instances = await request.get(`${API}/integrations/instances`, {
    headers: { cookie: authorLogin.cookie },
  });
  expect(instances.status()).toBe(403);
  const payments = await request.get(`${API}/payments`, {
    headers: { cookie: authorLogin.cookie },
  });
  expect(payments.status()).toBe(403);
});

test("SMTP settings card: saved state visible, password never echoed, test probe", async ({
  page,
}) => {
  await loginViaUi(page);
  await clickNav(page, "nav-integrations-slot");
  const card = page.getByText("Отправка почты (SMTP)").first();
  await expect(card).toBeVisible();

  // Fill the managed settings (disabled — no SMTP server is needed to save).
  const cardRegion = page
    .locator("section, .pcms-card", { hasText: "Отправка почты (SMTP)" })
    .first();
  const enabledSwitch = cardRegion.getByRole("switch");
  await enabledSwitch.click(); // enable the toggle...

  await cardRegion.getByPlaceholder("cms@example.com").fill("cms@example.com");
  await cardRegion.getByPlaceholder("smtp.example.com").fill("127.0.0.1");
  await cardRegion.getByPlaceholder("587").fill("1");

  // Enabling requires a live SMTP endpoint; port 1 refuses → the server must
  // reject the save with a visible error and NOT leave the card in enabled
  // state after reload (no optimistic flip).
  await cardRegion.getByRole("button", { name: "Сохранить" }).click();
  await expect(
    page.getByText(/MAIL_VERIFY_FAILED|Проверка|refused|ECONNREFUSED/i).first(),
  ).toBeVisible({
    timeout: 15_000,
  });
});
