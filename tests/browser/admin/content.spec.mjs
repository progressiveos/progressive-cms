// Content workspace browser flow (PCMS-ADMIN-T003; Admin spec §4/§5).
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const unique = Date.now().toString(36);
const TITLE = `О компании (${unique})`;

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

async function login(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

test("content manager creates a page, edits and saves the draft", async ({ page }) => {
  await login(page);
  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();

  await page.getByLabel("Тип материала").selectOption("page");
  await page.getByLabel("Заголовок").fill(TITLE);
  await page.getByRole("button", { name: "Создать", exact: true }).click();

  const workspace = page.getByTestId("entry-workspace");
  await expect(workspace).toBeVisible();
  const titleField = workspace.getByLabel("Заголовок", { exact: true });
  await expect(titleField).toHaveValue(TITLE);

  await titleField.fill(`${TITLE} — ред.2`);
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByTestId("save-state")).toHaveText(/Сохранено/, { timeout: 10_000 });

  // The tree shows the renamed entry with the draft indicator after reload.
  await expect(page.getByTestId("content-tree").getByText(`${TITLE} — ред.2`)).toBeVisible();
});

test("duplicate action creates a copy with the same title", async ({ page }) => {
  await login(page);
  await clickNav(page, "nav-content-tree");
  const tree = page.getByTestId("content-tree");
  // Row actions live in the per-row overflow menu (redesign concept §12.2).
  const row = tree.locator(".pcms-tree__line", { hasText: `${TITLE} — ред.2` }).first();
  await row.click();
  await row.getByTestId("tree-row-menu").click();
  await page.getByRole("menuitem", { name: "Дублировать" }).click();
  const copies = tree.getByText(`${TITLE} — ред.2`);
  await expect(copies).toHaveCount(2, { timeout: 10_000 });
});
