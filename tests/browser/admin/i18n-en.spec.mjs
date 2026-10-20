// Dedicated Admin i18n acceptance (work package #46): the whole agreed Admin
// route corpus in EN (browser locale en-US + Admin locale "en" pre-seeded)
// asserting no unintended Cyrillic, no raw translation keys, no missing
// values. The generic corpus (ru-RU pin) stays the deterministic RU baseline.
// @ts-check
import { expect, test } from "@playwright/test";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN, locale: "en-US" });

// Route families from the Admin navigation (work package §5): every screen
// the shell can reach is visited in EN.
const ROUTES = [
  ["overview", "/"],
  ["content", "/content"],
  ["media", "/media"],
  ["navigation", "/navigation"],
  ["publication", "/publication"],
  ["search", "/search"],
  ["forms", "/interactions/forms"],
  ["quizzes", "/interactions/quizzes"],
  ["submissions", "/interactions/submissions"],
  ["quiz-runs", "/interactions/quiz-runs"],
  ["leads", "/interactions/leads"],
  ["integrations", "/integrations"],
  ["payments", "/payments"],
  ["extensions", "/extensions"],
  ["users", "/users"],
  ["audit", "/audit"],
  ["theme", "/theme"],
  ["settings", "/settings"],
  ["maintenance", "/maintenance"],
  ["system", "/system"],
];

async function loginEn(page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("pcms.admin.locale", "en");
  });
  await page.goto(ADMIN);
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible({ timeout: 10_000 });
}

test("EN acceptance: login is English", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("pcms.admin.locale", "en");
  });
  await page.goto(ADMIN);
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to Progressive CMS" })).toBeVisible();
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[\u0400-\u04FF]/);
});

test("EN acceptance: the admin route corpus shows no Cyrillic and no raw keys", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "corpus walk runs on desktop only");
  await loginEn(page);

  const problems = [];
  for (const [name, path] of ROUTES) {
    await page.goto(`${ADMIN}#${path}`);
    await page.waitForTimeout(400);
    const text = await page.locator("body").innerText();
    // Authored content titles retain their original language; inspect all UI
    // copy while excluding those specific data cells, never entire screens.
    const uiText = await page.locator("body").evaluate((body) => {
      const clone = body.cloneNode(true);
      clone
        .querySelectorAll(".pcms-tree__label, [data-testid=pending-table] tbody td:first-child")
        .forEach((node) => {
          node.remove();
        });
      return clone.textContent ?? "";
    });
    // 1. No unintended Cyrillic in EN mode.
    if (/[\u0400-\u04FF]/.test(uiText))
      problems.push(
        `${name}: Cyrillic text: ${text
          .split("\n")
          .filter((line) => /[\u0400-\u04FF]/.test(line))
          .join(" | ")}`,
      );
    // 2. No raw translation keys surfacing as [namespace.key].
    if (/\[[a-z][a-z0-9_]*(\.[a-z0-9_]+)+\]/.test(text)) problems.push(`${name}: raw key`);
    // 3. No runtime placeholder junk.
    if (/\b(undefined|NaN)\b/.test(text)) problems.push(`${name}: undefined/NaN`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

test("EN acceptance: shell keeps the EN labels after the walk", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "corpus walk runs on desktop only");
  await loginEn(page);
  await expect(page.getByTestId("nav-content-tree")).toContainText("Content");
  await expect(page.getByTestId("nav-media-library")).toContainText("Media");
});
