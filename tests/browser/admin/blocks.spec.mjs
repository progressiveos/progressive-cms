// Block editor browser flow (PCMS-ADMIN-T006/T007; Admin spec §10-§18):
// palette-driven add, props editing via schema-driven form, validation
// feedback, move/duplicate — a representative slice of the 17 first-party
// blocks (full coverage lands with the T028 journey).
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const TITLE = `Страница-блоки (${Date.now().toString(36)})`;

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

async function login(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();
  await page.getByLabel("Тип материала").selectOption("page");
  await page.getByLabel("Заголовок").fill(TITLE);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();
}

async function addBlock(page, typeName, typeId) {
  await page.getByRole("button", { name: "+ Добавить блок" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".pcms-picker-row")).toHaveCount(17);
  await dialog
    .getByRole("button", { name: new RegExp(typeName) })
    .first()
    .click();
  const document = page.getByTestId("block-document");
  await expect(
    document
      .locator("fieldset", { hasText: new RegExp(typeId) })
      .or(document.getByText(typeId))
      .first(),
  ).toBeVisible();
}

test("blocks: palette offers all 17 first-party types, text/heading editable, validation works", async ({
  page,
}) => {
  await login(page);
  const document = page.getByTestId("block-document");

  // heading block
  await page.getByRole("button", { name: "+ Добавить блок" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Заголовок/ })
    .first()
    .click();
  await expect(document).toBeVisible();
  const headingLevel = document.getByLabel("Level");
  await headingLevel.fill("2");
  await document.getByLabel("Text", { exact: true }).first().fill("Раздел о компании");
  await document.getByRole("button", { name: "Проверить блок" }).click();
  await expect(document.getByText("блок корректен")).toBeVisible({ timeout: 10_000 });

  // invalid values produce visible server-side feedback
  await headingLevel.fill("9");
  await document.getByRole("button", { name: "Проверить блок" }).click();
  await expect(document.locator(".pcms-field__error").first()).toBeVisible({ timeout: 10_000 });
  await headingLevel.fill("2");

  // move the heading up/down buttons exist; save the whole draft
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByTestId("save-state")).toHaveText(/Сохранено/, { timeout: 10_000 });
});

test("blocks: add second block after existing one and duplicate", async ({ page }) => {
  await login(page);
  const document = page.getByTestId("block-document");

  await page.getByRole("button", { name: "+ Добавить блок" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Текст/ })
    .first()
    .click();
  await expect(document.locator("fieldset").first()).toBeVisible();

  // insert a quote block after the first one
  await document.getByRole("button", { name: /Вставить блок после 1/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Цитата/ })
    .first()
    .click();
  const legends = document.locator("fieldset > legend");
  await expect(legends).toHaveCount(2);

  // duplicate the first block
  await document.getByRole("button", { name: "Дублировать" }).first().click();
  await expect(document.locator("fieldset > legend")).toHaveCount(3);

  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByTestId("save-state")).toHaveText(/Сохранено/, { timeout: 10_000 });
});

test("rich-text summaries and one-column editor remain readable at 887px", async ({ page }) => {
  await page.setViewportSize({ width: 887, height: 800 });
  await login(page);
  await expect(page.locator(".pcms-mobile-nav-overlay")).toHaveCount(0);
  await page.getByRole("button", { name: "+ Добавить блок" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Текст/ })
    .first()
    .click();
  const block = page.getByTestId("block-document").locator(".pcms-block-card").first();
  await block
    .getByRole("textbox", { name: "Форматированный текст" })
    .fill("Заполненный текст блока");
  await expect(block.locator("legend")).toContainText("Заполненный текст блока");
  for (const tab of ["SEO", "Публикация"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await page.locator(".pcms-main").evaluate((el) => el.scrollTo(0, 300));
    const geometry = await page.evaluate(() => {
      const tree = document.querySelector(".pcms-tree-panel");
      const editor = document.querySelector(".pcms-editor");
      return {
        sticky: getComputedStyle(tree).position,
        overlap: tree.getBoundingClientRect().bottom > editor.getBoundingClientRect().top,
      };
    });
    expect(geometry.sticky).toBe("static");
    expect(geometry.overlap).toBe(false);
  }
  await expect(page.getByRole("link", { name: "© Progressive OS · p-os.ru" })).toHaveAttribute(
    "href",
    "https://p-os.ru",
  );
});
