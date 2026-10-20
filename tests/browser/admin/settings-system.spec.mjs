// Settings/System browser flow (PCMS-ADMIN-T025; Admin spec §48-§51).
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });
// desktop-only project guard (Admin spec §52)
test.skip(
  ({ viewport }) => (viewport?.width ?? 1280) < 1024,
  "heavy authoring flow is desktop-gated",
);

test("site identity save + system status without secrets", async ({ page }) => {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();

  await clickNav(page, "nav-settings");
  const identity = page.getByTestId("identity-form");
  await expect(identity).toBeVisible();
  await page.getByLabel("Название сайта").fill("Корпорация «Пример»");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Идентификация сайта сохранена")).toBeVisible({ timeout: 10_000 });

  // System screen: doctor snapshot, no SQL/secrets.
  await clickNav(page, "nav-system");
  const system = page.getByTestId("system-screen");
  await expect(system).toBeVisible();
  await expect(system.getByTestId("system-health")).toBeVisible();
  await expect(system.getByText(/Глава миграций/)).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/postgres(ql)?:\/\/|PCMS_SECRET_|password/i);
});
