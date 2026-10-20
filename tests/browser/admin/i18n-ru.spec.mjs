// Dedicated Admin i18n RU acceptance (work package #46): the same route
// corpus as the EN contour, asserting the RU catalog renders completely —
// the shell heading, per-screen RU anchors and no raw translation keys.
// The generic corpus runs on the pinned ru-RU browser baseline; this spec
// additionally pins the Admin locale to "ru" via localStorage so it is
// independent of host and browser settings.
// @ts-check
import { expect, test } from "@playwright/test";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN, locale: "ru-RU" });

// Route → RU anchor expected on that screen (the catalog's own vocabulary).
const ROUTES = [
  ["overview", "/", "Обзор"],
  ["content", "/content", "Материалы"],
  ["media", "/media", "Медиа"],
  ["navigation", "/navigation", "Навигация"],
  ["publication", "/publication", "Публикация"],
  ["integrations", "/integrations", "Интеграции"],
  ["payments", "/payments", "Платежи"],
  ["theme", "/theme", "Тема"],
  ["users", "/users", "Пользователи"],
  ["settings", "/settings", "Настройки"],
  ["audit", "/audit", "Аудит"],
  ["maintenance", "/maintenance", "Доступ к сайту"],
];

async function loginRu(page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("pcms.admin.locale", "ru");
  });
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible({ timeout: 10_000 });
}

test("RU acceptance: the admin route corpus shows RU anchors and no raw keys", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "corpus walk runs on desktop only");
  await loginRu(page);

  const problems = [];
  for (const [name, path, anchor] of ROUTES) {
    await page.goto(`${ADMIN}#${path}`);
    await page.waitForTimeout(400);
    const text = await page.locator("body").innerText();
    if (!text.includes(anchor)) problems.push(`${name}: missing RU anchor "${anchor}"`);
    if (/\[[a-z][a-z0-9_]*(\.[a-z0-9_]+)+\]/.test(text)) problems.push(`${name}: raw key`);
    if (/\b(undefined|NaN)\b/.test(text)) problems.push(`${name}: undefined/NaN`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
});
