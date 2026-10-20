// Admin shell smoke (PCMS-ADMIN-T001): login → shell navigation → logout.
// Skips honestly when no test database is configured (same contract as the
// node integration suites).
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");

test.use({ baseURL: ADMIN });

async function login(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

test("login shows the workspace shell with primary navigation", async ({ page }) => {
  await login(page);
  await expect(page.getByTestId("nav-content-tree")).toBeVisible();
  await expect(page.getByTestId("nav-media-library")).toBeVisible();
  await expect(page.getByTestId("nav-nav-sets")).toBeVisible();
  await expect(page.getByTestId("nav-search")).toBeVisible();
  await expect(page.getByRole("link", { name: "© Progressive OS · p-os.ru" })).toHaveAttribute(
    "href",
    "https://p-os.ru",
  );
});

test("overview widgets load each data source once", async ({ page }) => {
  const counts = new Map([
    ["/api/v1/discovery/content/tree", 0],
    ["/api/v1/publication/calendar", 0],
    ["/api/v1/media", 0],
  ]);
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (counts.has(path)) counts.set(path, counts.get(path) + 1);
  });

  await login(page);
  await page.waitForTimeout(500);
  expect(Object.fromEntries(counts)).toEqual({
    "/api/v1/discovery/content/tree": 1,
    "/api/v1/publication/calendar": 1,
    "/api/v1/media": 1,
  });
});

test("shell navigates between sections via the sidebar", async ({ page }) => {
  await login(page);
  await clickNav(page, "nav-search");
  await expect(page.getByTestId("search-screen")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Поиск", exact: true })).toBeVisible();
  await clickNav(page, "nav-content-tree");
  // Breadcrumbs are a desktop affordance; hidden at ≤900px where the burger
  // drawer owns navigation.
  if ((page.viewportSize()?.width ?? 1280) > 900) {
    const crumbs = page.getByRole("navigation", { name: "Хлебные крошки" });
    await expect(crumbs.getByText("Материалы")).toBeVisible();
  }
});

test("logout returns to the login screen", async ({ page }) => {
  await login(page);
  await page.getByTestId("account-menu").click();
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page.getByRole("heading", { name: "Вход в Progressive CMS" })).toBeVisible();
  await expect(page.getByRole("link", { name: "© Progressive OS · p-os.ru" })).toBeVisible();
});

test("wrong password shows a human-readable error without leaking details", async ({ page }) => {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill("definitely-wrong-password");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByText("Неверная почта или пароль")).toBeVisible();
  await expect(page.getByText(/postgres|stack|SQL/i)).toHaveCount(0);
});
