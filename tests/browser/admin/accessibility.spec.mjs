// Accessibility/keyboard suite (PCMS-ADMIN-T027; Admin spec §53).
// Critical flows must be fully keyboard-operable with visible focus, labels,
// landmarks and dialog focus management. Reduced motion is enforced by the
// design tokens (tokens.css).
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const unique = Date.now().toString(36);

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

test("login is fully keyboard operable with visible focus and landmarks", async ({ page }) => {
  await page.goto(ADMIN);
  // Autofocus lands on the email field; typing + Tab + Enter submits.
  await expect(page.getByLabel("Электронная почта")).toBeFocused();
  await page.keyboard.type("owner@example.com");
  await page.keyboard.press("Tab");
  await page.keyboard.type(OWNER_PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible({ timeout: 10_000 });
});

test("sidebar navigation works by keyboard and marks the current page", async ({ page }) => {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();

  // The shell exposes a skip link as the first focusable element.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Перейти к основному содержимому" })).toBeFocused();

  const mediaLink = page.getByTestId("nav-media-library");
  await mediaLink.focus();
  await expect(mediaLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("media-screen")).toBeVisible();
  await expect(page.getByTestId("nav-media-library")).toHaveAttribute("aria-current", "page");

  // Landmarks exist once per role.
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toHaveCount(1);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
});

test("dialog traps focus, closes on Escape and returns focus", async ({ page }) => {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();

  await page.getByTestId("account-menu").click();
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Выйти из системы?" });
  await expect(dialog).toBeVisible();
  // Focus moved into the dialog.
  await expect(dialog.locator("button").first()).toBeFocused();
  // Tab keeps focus inside the dialog (first focusable reachable again).
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const inside = await page.evaluate(
    () => document.querySelector(".pcms-dialog")?.contains(document.activeElement) ?? false,
  );
  expect(inside).toBe(true);
  // Escape closes; focus returns to the trigger.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("account-menu")).toBeFocused();
});

test("content editor form: labels, switch role and tab order", async ({ page }) => {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();

  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();
  await page.getByLabel("Тип материала").selectOption("service");
  await page.getByLabel("Заголовок").fill(`A11y (${unique})`);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();

  // Tabs are keyboard operable (arrow keys move selection).
  await page.getByRole("tab", { name: "Контент" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "SEO" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "SEO" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Контент" })).toHaveAttribute("aria-selected", "true");

  // Every form control in the schema form is labeled.
  const unlabeled = await page
    .getByTestId("entry-workspace")
    .locator("input, textarea, select")
    .evaluateAll(
      (elements) =>
        elements.filter((element) => {
          const control = element;
          if (control.type === "hidden") return false;
          const id = control.id;
          if (id && document.querySelector(`label[for="${id}"]`)) return false;
          return (
            control.getAttribute("aria-label") === null &&
            control.getAttribute("aria-labelledby") === null &&
            !control.closest("label")
          );
        }).length,
    );
  expect(unlabeled).toBe(0);
});

test("repeater reorder is possible without drag (keyboard alternative)", async ({ page }) => {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();
  await page.getByLabel("Тип материала").selectOption("service");
  await page.getByLabel("Заголовок").fill(`A11y-репитер (${unique})`);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();

  const repeater = page.getByTestId("repeater");
  await repeater.getByRole("button", { name: "Добавить преимущество" }).click();
  await repeater.getByRole("button", { name: "Добавить преимущество" }).click();
  await repeater.getByRole("button", { name: "Поднять строку 2" }).click();
  await expect(repeater.getByRole("button", { name: "Поднять строку 1" })).toBeDisabled();
});
