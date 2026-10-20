// Repeater editor browser flow (PCMS-ADMIN-T004; Admin spec §9): stable
// reorder with keyboard alternative, duplicate, collapse — on the `service`
// content type whose `features` field is a repeater.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const TITLE = `Услуга-репитер (${Date.now().toString(36)})`;

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

async function login(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();
  await page.getByLabel("Тип материала").selectOption("service");
  await page.getByLabel("Заголовок").fill(TITLE);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();
}

test("repeater rows keep identity across keyboard reorder and save", async ({ page }) => {
  await login(page);
  const repeater = page.getByTestId("repeater");

  // Two rows with distinguishable text values.
  await repeater.getByRole("button", { name: "Добавить преимущество" }).click();
  await repeater.getByRole("button", { name: "Добавить преимущество" }).click();
  await repeater.getByLabel("Заголовок").nth(0).fill("Первый");
  await repeater.getByLabel("Заголовок").nth(1).fill("Второй");

  // Keyboard-accessible reorder: move row 2 up.
  await repeater.getByRole("button", { name: "Поднять строку 2" }).click();
  await expect(repeater.getByLabel("Заголовок").nth(0)).toHaveValue("Второй");
  await expect(repeater.getByLabel("Заголовок").nth(1)).toHaveValue("Первый");

  // Save and reload: order + values persist (stable ids survive).
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByTestId("save-state")).toHaveText(/Сохранено/, { timeout: 10_000 });
  await page.reload();
  await expect(page.getByTestId("entry-workspace")).toBeVisible({ timeout: 10_000 });
  const reloaded = page.getByTestId("repeater");
  await expect(reloaded.getByLabel("Заголовок").nth(0)).toHaveValue("Второй");
  await expect(reloaded.getByLabel("Заголовок").nth(1)).toHaveValue("Первый");
});

test("repeater duplicate copies a row and collapse hides its fields", async ({ page }) => {
  await login(page);
  const repeater = page.getByTestId("repeater");
  await repeater.getByRole("button", { name: "Добавить преимущество" }).click();
  await repeater.getByLabel("Заголовок").nth(0).fill("Только один");

  await repeater.getByRole("button", { name: "Дублировать" }).click();
  await expect(repeater.getByLabel("Заголовок")).toHaveCount(2);
  await expect(repeater.getByLabel("Заголовок").nth(1)).toHaveValue("Только один");

  await repeater.getByRole("button", { name: "Свернуть" }).first().click();
  await expect(repeater.getByLabel("Заголовок")).toHaveCount(1);
});
