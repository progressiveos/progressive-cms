// Users & Access browser flow (PCMS-ADMIN-T020/T021/T022): invite (secret
// once), role matrix, service account + token wizard (secret once), audit.
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

async function login(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
  await clickNav(page, "nav-users");
  await expect(page.getByTestId("users-screen")).toBeVisible();
}

test("invite a user — token shown once; disable/enable from the table", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "+ Пригласить сотрудника" }).click();
  await page.getByLabel("Имя").fill(`Редактор ${unique}`);
  await page.getByLabel("Электронная почта").fill(`editor-${unique}@example.com`);
  await page.getByRole("button", { name: "Создать приглашение" }).click();
  const tokenDialog = page.getByRole("dialog");
  await expect(tokenDialog.getByTestId("invite-token")).toBeVisible();
  const inviteCode = await tokenDialog.getByTestId("invite-token").innerText();
  expect(inviteCode).toContain("/invite/");
  await tokenDialog.getByRole("button", { name: "Я сохранил ссылку" }).click();

  const row = page.getByTestId("users-table").locator("tr", { hasText: `Редактор ${unique}` });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Отключить" }).click();
  await expect(row.getByText("отключён")).toBeVisible({ timeout: 10_000 });
  await row.getByRole("button", { name: "Включить" }).click();
  await expect(row.getByText("активен")).toBeVisible({ timeout: 10_000 });
});

test("create a user with an initial password from Admin", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "+ Создать пользователя" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Имя").fill(`Создан ${unique}`);
  await dialog.getByLabel("Электронная почта").fill(`direct-${unique}@example.com`);
  await dialog.getByLabel("Новый пароль").fill("Admin-initial-passphrase-2026!");
  await dialog.getByLabel("Повторите пароль").fill("Admin-initial-passphrase-2026!");
  await dialog.getByRole("button", { name: "Создать пользователя" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("users-table").getByText(`Создан ${unique}`)).toBeVisible({
    timeout: 10_000,
  });
});

test("roles matrix shows builtin roles and permission grid", async ({ page }) => {
  await login(page);
  await page.getByRole("tab", { name: "Роли" }).click();
  const matrix = page.getByTestId("roles-matrix");
  await expect(matrix.getByText("OWNER")).toBeVisible();
  await expect(matrix.getByText("EDITOR")).toBeVisible();
  await matrix
    .getByRole("button", { name: /Права \(1?\d+\)/ })
    .last()
    .click();
  await expect(matrix.getByText(/publication\.publish/).first()).toBeVisible();
});

test("service account + token wizard shows secret exactly once", async ({ page }) => {
  await login(page);
  await page.getByRole("tab", { name: "Сервисные аккаунты" }).click();
  await page.getByRole("button", { name: "+ Сервисный аккаунт" }).click();
  await page.getByLabel("Имя").fill(`agent-${unique}`);
  await page.getByLabel("Назначение").fill("e2e wizard");
  await page.getByRole("dialog").getByRole("button", { name: "Создать" }).click();
  await expect(page.getByText(`agent-${unique}`)).toBeVisible({ timeout: 10_000 });

  const row = page.getByTestId("accounts-tab").locator("tr", { hasText: `agent-${unique}` });
  await row.getByRole("button", { name: "Новый токен" }).click();
  const wizard = page.getByRole("dialog");
  await wizard.getByLabel("Описание").fill("e2e");
  const checkboxes = wizard.getByRole("checkbox");
  await checkboxes.first().click();
  await wizard.getByRole("button", { name: "Создать токен" }).click();
  const secretDialog = page.getByRole("dialog");
  await expect(secretDialog.getByTestId("token-secret")).toBeVisible();
  const secret = await secretDialog.getByTestId("token-secret").innerText();
  expect(secret).toMatch(/^pcms_[0-9a-f]{8}_/);
  await secretDialog.getByRole("button", { name: "Я сохранил токен" }).click();
  // secret never appears again
  await expect(page.getByText(secret)).toHaveCount(0);
});

test("audit screen lists events with actor filter", async ({ page }) => {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await clickNav(page, "nav-audit");
  const screen = page.getByTestId("audit-screen");
  await expect(screen).toBeVisible();
  await expect(screen.getByTestId("audit-table").locator("tbody tr").first()).toBeVisible();
  await screen.getByLabel("Тип актора").selectOption("USER");
  await expect(screen.getByText("LOGIN_SUCCESS").first()).toBeVisible({ timeout: 10_000 });
});
