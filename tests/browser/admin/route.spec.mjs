// Route tab browser flow (PCMS-ADMIN-T011; Admin spec §27).
// Unrouted entries: proposal shown, no change action. The routed
// change-with-redirect flow is covered by API contract tests; the full
// publish→route journey lands with the changeset workspace (T016/T028).
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const TITLE = `Маршрут (${Date.now().toString(36)})`;

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

test("route tab: proposal and unrouted state before first publication", async ({ page }) => {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();

  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();
  await page.getByLabel("Тип материала").selectOption("news");
  await page.getByLabel("Заголовок").fill(TITLE);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();

  await page.getByRole("tab", { name: "Адрес" }).click();
  const tab = page.getByTestId("route-tab");
  await expect(tab).toBeVisible();
  await expect(tab.getByText(/канонический адрес появится при первой публикации/)).toBeVisible();
  // The proposal is the slug-normalized title, offered in the hint.
  const input = tab.getByRole("textbox", { name: "Адрес (path)" });
  await expect(input).toBeVisible();
  const proposal = await input.inputValue();
  expect(proposal).toMatch(/^\//);
});
