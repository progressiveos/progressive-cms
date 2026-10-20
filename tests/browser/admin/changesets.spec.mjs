// ChangeSet + batch plan browser flow (PCMS-ADMIN-T016/T018; Admin spec
// §36/§37): create changeset, add a sealed entry, preflight, exact timeline
// preview (3/12h scenario), schedule; stale/conflict feedback via preflight.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const unique = Date.now().toString(36);
const TITLE = `Релиз-${unique}`;
const ENTRY_TITLE = `Новость в релизе (${unique})`;

// 1×1 PNG for media-free minimal news payload? news has no media field — fine.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
void PNG;

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });
// Full seal→changeset→plan chain with Argon2 logins; 3 projects share one
// e2e server, so allow generous time.
test.setTimeout(90_000);
// desktop-only project guard (Admin spec §52)
test.skip(
  ({ viewport }) => (viewport?.width ?? 1280) < 1024,
  "heavy authoring flow is desktop-gated",
);

async function login(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

test("changeset: create → add sealed entry → preflight → exact 3/12h timeline", async ({
  page,
}) => {
  await login(page);

  // Setup via UI: create a news entry, save, seal it (Publication tab).
  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();
  await page.getByLabel("Тип материала").selectOption("news");
  await page.getByLabel("Заголовок").fill(ENTRY_TITLE);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();
  await page.getByRole("tab", { name: "Публикация" }).click();
  const pub = page.getByTestId("publication-tab");
  await pub.getByRole("button", { name: "Запечатать" }).click();
  await expect(page.getByText("Ревизия запечатана").first()).toBeVisible({ timeout: 10_000 });

  // Changeset workspace (advanced machinery behind the human publication tabs).
  await clickNav(page, "nav-pub-changesets");
  await page.getByRole("tab", { name: "Дополнительно" }).click();
  await expect(page.getByTestId("changesets-screen")).toBeVisible();
  await page.getByRole("button", { name: "+ Новый набор" }).click();
  await page.getByLabel("Название").fill(TITLE);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "+ Добавить элемент" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Выбрать…" }).click();
  const picker = page.getByRole("dialog").last();
  await picker.getByRole("option", { name: ENTRY_TITLE }).click();
  await expect(picker.getByText(/нет запечатанных ревизий/)).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.getByText("Элемент добавлен")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Материалы").first()).toBeVisible();

  // Preflight over the real domain validators.
  await page.getByRole("button", { name: "Проверить", exact: true }).click();
  await expect(page.getByTestId("preflight-report")).toBeVisible({ timeout: 10_000 });

  // Batch plan: 3 per 12 hours with exact timeline preview before commit.
  await page.getByRole("button", { name: "Запланировать" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Start tomorrow: a past start instant would execute immediately.
  const tomorrow = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await dialog.locator('input[type="date"]').fill(tomorrow);
  await dialog.getByRole("button", { name: "Показать точное расписание" }).click();
  const timeline = page.getByTestId("plan-timeline");
  await expect(timeline).toBeVisible({ timeout: 15_000 });
  // The single-item release produces exactly one dated publish slot.
  await expect(timeline.locator("li")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Зафиксировать расписание" }).click();
  await expect(page.getByText("Расписание зафиксировано").first()).toBeVisible({ timeout: 45_000 });
});
