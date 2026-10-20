// Theme workspace browser flow (PCMS-ADMIN-T019; Admin spec §38-§40):
// settings form from the manifest schema, CAS save, activation, developer info.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

test("theme workspace: settings save, activation, developer info, no source editor", async ({
  page,
}) => {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
  await clickNav(page, "nav-theme");
  const screen = page.getByTestId("theme-screen");
  await expect(screen).toBeVisible();

  // Activation of the configured reference theme (idempotent: a previously
  // activated state only asserts the badge).
  if ((await screen.getByRole("button", { name: /Активировать/ }).count()) > 0) {
    await screen.getByRole("button", { name: /Активировать/ }).click();
  }
  await expect(screen.getByText(/активна: reference-theme-v1/)).toBeVisible({ timeout: 10_000 });

  // Developer info section: contract version and templates from the manifest.
  await expect(screen.getByText("Theme Contract")).toBeVisible();
  await expect(screen.getByText(/исходников темы не входит/)).toBeVisible();

  // Settings: change a boolean setting if present, save, and see it persist.
  const switches = screen.getByRole("checkbox");
  const count = await switches.count();
  if (count > 0) {
    await switches.first().click();
    await screen.getByRole("button", { name: "Сохранить изменения" }).click();
    await expect(page.getByText("Настройки темы сохранены")).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await clickNav(page, "nav-theme");
    await expect(page.getByTestId("theme-screen").getByRole("checkbox").first()).toBeChecked();
  }
});
