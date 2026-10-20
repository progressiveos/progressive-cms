// Publication calendar browser flow (PCMS-ADMIN-T017; Admin spec §35):
// scheduled item appears in the calendar, reschedule modal and cancel work.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const TITLE = `Календарь-${Date.now().toString(36)}`;
const ENTRY_TITLE = `Новость в календаре (${Date.now().toString(36)})`;

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });
// desktop-only project guard (Admin spec §52)
test.skip(
  ({ viewport }) => (viewport?.width ?? 1280) < 1024,
  "heavy authoring flow is desktop-gated",
);

test("calendar: scheduled item renders, reschedule modal, cancel", async ({ page }) => {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();

  // Setup via UI: create + seal + changeset + schedule (single item, now+2h).
  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();
  await page.getByLabel("Тип материала").selectOption("news");
  await page.getByLabel("Заголовок").fill(ENTRY_TITLE);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();
  await page.getByRole("tab", { name: "Публикация" }).click();
  await page.getByTestId("publication-tab").getByRole("button", { name: "Запечатать" }).click();
  await expect(page.getByText("Ревизия запечатана").first()).toBeVisible({ timeout: 10_000 });

  await clickNav(page, "nav-pub-changesets");
  await page.getByRole("tab", { name: "Дополнительно" }).click();
  await page.getByRole("button", { name: "+ Новый набор" }).click();
  await page.getByLabel("Название").fill(TITLE);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
  await page.getByRole("button", { name: "+ Добавить элемент" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Выбрать…" }).click();
  await page.getByRole("dialog").last().getByRole("option", { name: ENTRY_TITLE }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.getByText("Элемент добавлен")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Запланировать" }).click();
  const planDialog = page.getByRole("dialog");
  const tomorrow = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await planDialog.locator('input[type="date"]').fill(tomorrow);
  await planDialog.getByRole("button", { name: "Показать точное расписание" }).click();
  await expect(page.getByTestId("plan-timeline")).toBeVisible({ timeout: 15_000 });
  await planDialog.getByRole("button", { name: "Зафиксировать расписание" }).click();
  await expect(page.getByText("Расписание зафиксировано").first()).toBeVisible({ timeout: 45_000 });

  // Calendar tab shows the scheduled entry.
  await page.getByRole("tab", { name: "Календарь" }).click();
  const calendar = page.getByTestId("calendar-screen");
  await page.getByRole("tab", { name: "Календарь" }).click();
  await expect(calendar.getByText(TITLE).first()).toBeVisible({ timeout: 10_000 });

  // Reschedule via the exact-datetime modal.
  await calendar.getByText(TITLE).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const input = dialog.locator('input[type="datetime-local"]');
  await input.fill("2027-01-15T10:30");
  await dialog.getByRole("button", { name: "Перенести" }).click();
  await expect(page.getByText("Публикация перенесена")).toBeVisible({ timeout: 10_000 });

  // The item moved out of the current month; switch month + list mode and cancel it.
  await calendar.getByLabel("Месяц").fill("2027-01");
  await expect(calendar.getByText(TITLE).first()).toBeVisible({ timeout: 10_000 });
  await calendar.getByRole("button", { name: "Списком" }).click();
  await calendar.getByRole("button", { name: "Отменить" }).first().click();
  await expect(page.getByText("Публикация отменена")).toBeVisible({ timeout: 10_000 });
});
