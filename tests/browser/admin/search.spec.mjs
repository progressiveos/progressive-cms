// Admin search screen (owner UX pass 0.1.28 §11-§13): a draft created through
// the content workspace is found by title; the operator panel shows real index
// state. Published-index hits need the worker's outbox consumer, which the
// e2e composition intentionally does not run — draft search covers the screen
// wiring end to end (drafts are searched live, not via the index).
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const unique = Date.now().toString(36);
const TITLE = `Поисковый черновик ${unique}`;

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

async function login(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

test("search finds a draft by title and shows the index panel", async ({ page }) => {
  await login(page);

  // Create a draft with a unique title.
  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();
  await page.getByLabel("Тип материала").selectOption("page");
  await page.getByLabel("Заголовок").fill(TITLE);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();

  // Search for it.
  await clickNav(page, "nav-search");
  const screen = page.getByTestId("search-screen");
  await expect(screen).toBeVisible();
  await screen.getByLabel("Запрос").fill(TITLE);
  await screen.getByRole("button", { name: "Найти" }).click();

  const drafts = screen.getByTestId("search-results-drafts");
  await expect(drafts.getByText(TITLE)).toBeVisible({ timeout: 10_000 });

  // Click opens the material editor.
  await drafts.getByText(TITLE).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();

  // Operator panel reflects the real index state (empty in e2e, but honest).
  await clickNav(page, "nav-search");
  await expect(screen.getByTestId("search-ops")).toBeVisible();
  await expect(screen.getByTestId("search-ops").getByText(/Документов/)).toBeVisible();
});
