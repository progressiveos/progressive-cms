// Publication controls browser flow (PCMS-ADMIN-T009; Admin spec §22/§23):
// validate → seal → preview → publish states stay distinct and permission
// labeled; publish uses the publication CAS generation.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const TITLE = `Публикация (${Date.now().toString(36)})`;

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
  await page.getByLabel("Тип материала").selectOption("news");
  await page.getByLabel("Заголовок").fill(TITLE);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();
}

test("validate → seal → preview → publish flow keeps states distinct", async ({ page }) => {
  await login(page);
  await page.getByRole("tab", { name: "Публикация" }).click();
  const tab = page.getByTestId("publication-tab");
  await expect(tab).toBeVisible();

  // Working revision: publish is disabled until sealed.
  await expect(tab.getByText("черновик сохранён")).toBeVisible();
  await expect(tab.getByRole("button", { name: "Опубликовать" })).toBeDisabled();
  await expect(tab.getByText("Материал ещё не публиковался")).toBeVisible();

  // Validate reports the news draft is ready; seal it.
  await tab.getByRole("button", { name: "Проверить" }).click();
  await expect(tab.getByText(/готов к запечатыванию|есть ошибки/)).toBeVisible({ timeout: 10_000 });
  await tab.getByRole("button", { name: "Запечатать" }).click();

  // After sealing, publish unlocks and the preview button opens a signed URL.
  await expect(tab.getByRole("button", { name: "Опубликовать" })).toBeEnabled({ timeout: 10_000 });
  const popupPromise = page.waitForEvent("popup", { timeout: 10_000 });
  await tab.getByRole("button", { name: "Предпросмотр" }).click();
  const popup = await popupPromise;
  expect(popup.url()).toContain("/preview/page?token=");
  await popup.close();

  // Publish is a public mutation: it goes through the confirm dialog
  // (ADMIN-UX redesign §24.3) and only mutates on the explicit verb.
  await tab.getByRole("button", { name: "Опубликовать" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Опубликовать" }).click();
  await expect(tab.getByText(/Публикация актуальна|Publication is current/)).toBeVisible({
    timeout: 10_000,
  });
  await expect(tab.getByRole("button", { name: "Снять с публикации" })).toBeEnabled();
});
