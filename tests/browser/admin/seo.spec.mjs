// SEO tab browser flow (PCMS-ADMIN-T010; Admin spec §26): explicit overrides,
// search preview, fallback provenance, social image as a Media Asset.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const TITLE = `SEO-новость (${Date.now().toString(36)})`;

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });
// desktop-only project guard (Admin spec §52)
test.skip(
  ({ viewport }) => (viewport?.width ?? 1280) < 1024,
  "heavy authoring flow is desktop-gated",
);

test("seo tab: overrides saved, provenance visible, search preview rendered", async ({ page }) => {
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

  await page.getByRole("tab", { name: "SEO" }).click();
  const tab = page.getByTestId("seo-tab");
  await expect(tab).toBeVisible();

  // Search preview renders the fallback title (from the entry title field).
  await expect(tab.getByTestId("search-preview")).toContainText(TITLE);
  await expect(tab.getByTestId("provenance-title")).toContainText("источник:");

  // Explicit override wins in the preview after save.
  await tab.getByLabel("SEO title").fill(`${TITLE} — SEO`);
  await tab.getByLabel("Индексация").selectOption("noindex");
  await tab.getByRole("button", { name: "Сохранить SEO" }).click();
  await expect(page.getByText("SEO-данные сохранены")).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await clickNav(page, "nav-content-tree");
  await page.getByTestId("content-tree").getByText(TITLE).first().click();
  await page.getByRole("tab", { name: "SEO" }).click();
  await expect(page.getByTestId("seo-tab").getByLabel("SEO title")).toHaveValue(`${TITLE} — SEO`);
  await expect(page.getByTestId("seo-tab").getByLabel("Индексация")).toHaveValue("noindex");
});
