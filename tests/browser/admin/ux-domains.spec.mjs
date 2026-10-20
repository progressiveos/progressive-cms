// Owner UX gaps C+D browser acceptance (proportionate, spec §35):
// template selector in create/edit (single-template auto behavior) and
// media folder workflow (create folder → upload into it → picker filter).
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
}

test("template: multi-compatible type shows selector, single shows fixed value", async ({
  page,
}) => {
  await login(page);
  await clickNav(page, "nav-content-tree");

  // page has two compatible templates in the reference theme → selector.
  await page.getByRole("button", { name: "+ Создать" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Тип материала").selectOption("page");
  await expect(dialog.getByLabel("Шаблон")).toBeVisible();
  await dialog.getByLabel("Шаблон").selectOption("page-hero");
  const title = `Шаблонная (${unique})`;
  await dialog.getByRole("textbox", { name: "Заголовок", exact: true }).fill(title);
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();

  // The editor shows the assignment; changing it persists immediately.
  const select = page.getByTestId("template-select");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("page-hero");
  await select.selectOption("page-default");
  await expect(page.getByText("Шаблон изменён")).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await clickNav(page, "nav-content-tree");
  await page.locator(".pcms-tree__line", { hasText: title }).first().click();
  await expect(page.getByTestId("template-select")).toHaveValue("page-default", {
    timeout: 10_000,
  });
});

test("media folders: create, upload into, move asset, picker filter", async ({ page }) => {
  await login(page);
  await clickNav(page, "nav-media-library");
  const foldersPanel = page.getByTestId("media-folders");
  await foldersPanel.getByRole("button", { name: /Папка$/ }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Название", { exact: true })
    .fill(`Проекты (${unique})`);
  await page.getByRole("dialog").getByRole("button", { name: "Создать" }).click();
  await expect(foldersPanel.getByText(`Проекты (${unique})`)).toBeVisible({ timeout: 10_000 });

  // open the folder and upload straight into it
  await foldersPanel.getByText(`Проекты (${unique})`).click();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.setInputFiles('input[aria-label="Загрузить файл"]', {
    name: `into-folder-${unique}.png`,
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.getByText("Файл загружен")).toBeVisible({ timeout: 10_000 });

  // the grid (folder-scoped) shows the asset; root ("Без папки") does not
  await expect(
    page.locator(".pcms-media-card", { hasText: `into-folder-${unique}.png` }),
  ).toBeVisible();
  await foldersPanel.getByText("Без папки").click();
  await expect(
    page.locator(".pcms-media-card", { hasText: `into-folder-${unique}.png` }),
  ).toHaveCount(0);

  // move back via the details drawer folder select; identity unchanged
  await foldersPanel.getByText(`Проекты (${unique})`).click();
  await page.locator(".pcms-media-card", { hasText: `into-folder-${unique}.png` }).click();
  await page.getByTestId("media-folder-select").selectOption({ label: "Без папки" });
  await expect(page.getByText("Файл перемещён")).toBeVisible({ timeout: 10_000 });

  // the field picker exposes the same folder browsing
  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();
  const dialog = page.getByRole("dialog");
  // `case` carries a media field (hero_image) in the reference corpus.
  await dialog.getByLabel("Тип материала").selectOption("case");
  await dialog.getByRole("textbox", { name: "Заголовок", exact: true }).fill(`Пикер (${unique})`);
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();
  await page
    .getByTestId("entry-workspace")
    .getByRole("button", { name: "Выбрать изображение" })
    .first()
    .click();
  await expect(page.getByTestId("media-picker-folders")).toBeVisible();
  await page.getByTestId("media-picker-folders").selectOption({ label: `Проекты (${unique})` });
  // The asset was moved out of the folder, so the folder-scoped picker is empty.
  await expect(page.locator(".pcms-mediagrid .pcms-media-card")).toHaveCount(0, {
    timeout: 10_000,
  });
});
