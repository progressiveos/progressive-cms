// Module surfaces after the owner productization pass (0.1.28): search is a
// real Admin screen over the shipped subsystem (the old "module not
// installed" slot is gone), while payments remains an honest slot.
// Deep coverage of the interactions/integrations workspaces lives in
// integrations-payments.spec.mjs.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

test("search is a real screen; payments stays a slot; interactions/integrations real", async ({
  page,
}) => {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();

  // Search: real query screen with the operator index panel for the owner.
  await clickNav(page, "nav-search");
  const searchScreen = page.getByTestId("search-screen");
  await expect(searchScreen).toBeVisible();
  await expect(page.getByRole("heading", { name: "Поиск" })).toBeVisible();
  await expect(searchScreen.getByTestId("search-ops")).toBeVisible();

  // The interactions slot flipped to a real workspace (M12).
  await clickNav(page, "nav-interactions-forms");
  await expect(page.getByTestId("interactions-forms-screen")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Формы" })).toBeVisible();

  // The integrations slot flipped to a real workspace (M13).
  await clickNav(page, "nav-integrations-slot");
  await expect(page.getByTestId("integrations-screen")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Интеграции" })).toBeVisible();

  await clickNav(page, "nav-payments-slot");
  await expect(page.getByTestId("payments-screen")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Платежи" })).toBeVisible();
});
