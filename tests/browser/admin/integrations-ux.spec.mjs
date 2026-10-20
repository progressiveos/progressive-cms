// Integrations owner acceptance (owner task §71 focused set): SMTP TLS→port
// auto-selection with manual override, human validation errors instead of
// raw API contract errors, connection creation through the UI (never
// REST/MCP), and the human binding flow.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const unique = Date.now().toString(36);

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

async function login(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

test("SMTP: TLS mode switches the default port until edited manually", async ({ page }) => {
  await login(page);
  await clickNav(page, "nav-integrations-slot");
  const card = page.getByRole("heading", { name: "Отправка почты (SMTP)" }).locator("..");
  await expect(card).toBeVisible();

  const port = card.getByLabel("Порт");
  const mode = card.getByLabel("Режим TLS");

  // STARTTLS default
  await mode.selectOption("starttls");
  await expect(port).toHaveValue("587");
  // implicit TLS default
  await mode.selectOption("smtps");
  await expect(port).toHaveValue("465");
  // plain default
  await mode.selectOption("plain");
  await expect(port).toHaveValue("25");
  // a manual port survives subsequent mode switches (owner rule)
  await port.fill("2525");
  await mode.selectOption("starttls");
  await expect(port).toHaveValue("2525");
});

test("SMTP: invalid save shows localized field errors, never a raw contract error", async ({
  page,
}) => {
  await login(page);
  await clickNav(page, "nav-integrations-slot");
  const card = page.getByRole("heading", { name: "Отправка почты (SMTP)" }).locator("..");

  await card.getByLabel("Сервер SMTP").fill("");
  await card.getByLabel("Адрес отправителя (From)").fill("");
  await card.getByRole("button", { name: "Сохранить" }).click();

  const alert = card.locator(".pcms-field__error");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Укажите сервер SMTP");
  await expect(alert).toContainText("Укажите адрес отправителя");
  // the raw envelope text must never surface (owner rule §29)
  await expect(page.getByText("request does not satisfy the API contract")).toHaveCount(0);
});

test("SMTP: a valid disabled save succeeds; test probes the typed values", async ({ page }) => {
  await login(page);
  await clickNav(page, "nav-integrations-slot");
  const card = page.getByRole("heading", { name: "Отправка почты (SMTP)" }).locator("..");

  // keep the transport disabled: a disabled save must not probe the network
  const enabledSwitch = card.getByRole("switch", { name: "Использовать эти настройки SMTP" });
  if ((await enabledSwitch.getAttribute("aria-checked")) === "true") {
    await enabledSwitch.uncheck();
  }
  await card.getByLabel("Адрес отправителя (From)").fill("no-reply@example.com");
  await card.getByLabel("Сервер SMTP").fill("smtp.example.com");
  await card.getByLabel("Режим TLS").selectOption("starttls");
  await expect(card.getByLabel("Порт")).toHaveValue("587");
  await card.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Настройки почты сохранены")).toBeVisible({ timeout: 10_000 });
});

test("connection is created through the UI and appears in the list", async ({ page }) => {
  await login(page);
  await clickNav(page, "nav-integrations-slot");

  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // webhook declares config fields and NO secrets — the deterministic choice
  // for a store-less e2e deployment; the URL is loopback (the SSRF guard
  // rejects it, so the trailing probe stays local).
  await dialog.getByLabel("Тип").selectOption("webhook-http");
  await dialog.getByLabel("Название").fill(`HW ${unique}`);
  await dialog.getByLabel("URL приёмника").fill(`http://127.0.0.1:8788/health/live`);
  await dialog.getByRole("button", { name: "Сохранить и проверить" }).click();

  await expect(page.getByTestId(`connection-HW ${unique}`)).toBeVisible({ timeout: 10_000 });
});

test("binding is created through the human WHEN→WHERE dialog", async ({ page }) => {
  await login(page);
  await clickNav(page, "nav-integrations-slot");

  await page.getByRole("tab", { name: "Привязки" }).click();
  await page.getByRole("button", { name: "+ Привязка" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Когда").selectOption("LeadCreated");
  await dialog.getByLabel("Куда").selectOption({ label: `HW ${unique} — Generic HTTP/Webhook` });
  await dialog.getByRole("button", { name: "Сохранить" }).click();

  await expect(page.getByText("Привязка создана")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Когда создан лид").first()).toBeVisible();
  // the technical event name stays as secondary metadata only
  await expect(page.getByText("LeadCreated").first()).toBeVisible();
});
