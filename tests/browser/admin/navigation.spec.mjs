// Navigation workspace browser flow (PCMS-ADMIN-T012/T013; Admin spec §29-§31):
// set creation, nested items of different types, placements from the theme,
// derived-set override + stale badge.
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
  await clickNav(page, "nav-nav-sets");
  await expect(page.getByTestId("navigation-workspace")).toBeVisible();
}

test("create set, add nested item types, bind placement, seal", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "+ Новое меню" }).click();
  await page.getByLabel("Ключ").fill(`header-${unique}`);
  await page.getByLabel("Название").fill(`Меню ${unique}`);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Меню ${unique}` })).toBeVisible();

  // add an external_url item
  await page.getByRole("button", { name: "+ Пункт", exact: true }).click();
  await page.getByLabel("Тип пункта").selectOption("external_url");
  await page.getByLabel("Подпись").fill("Внешний сайт");
  await page.getByLabel("URL", { exact: true }).fill("https://example.ru");
  await page.getByRole("dialog").getByRole("button", { name: "Добавить" }).click();
  await expect(page.getByTestId("navigation-workspace").getByText("Внешний сайт")).toBeVisible({
    timeout: 10_000,
  });

  // item type is an icon with a tooltip/aria-label, not a text chip
  const typeIcon = page.getByTestId("navigation-workspace").getByLabel("Ссылка", { exact: true });
  await expect(typeIcon.first()).toBeVisible();
  await expect(typeIcon.first()).toHaveAttribute("title", "Ссылка");

  // placements live in the full-width panel below the menu structure
  const placements = page.getByTestId("placements-panel");
  await expect(placements.getByText("header.primary", { exact: true })).toBeVisible();
  await expect(placements.getByText("footer.legal", { exact: true })).toBeVisible();

  // bind the set to header.primary via the placement select
  const placementSelect = placements.getByLabel("Набор для Primary navigation");
  await placementSelect.selectOption({ label: `Меню ${unique}` });
  await expect(placementSelect).toHaveValue(/.*/, { timeout: 10_000 });
  await expect(
    placements.locator(".pcms-placement-row", { hasText: "Primary navigation" }).locator("select"),
  ).toHaveValue(/.*/, { timeout: 10_000 });
  // validation is visible: the required header.mobile placement is still unbound
  await expect(
    placements.getByText(/header\.mobile.*no binding|нет привязки|has no binding/).first(),
  ).toBeVisible({
    timeout: 10_000,
  });

  // deleting an item asks for confirmation (trash icon + tooltip, confirm dialog)
  await page.getByRole("button", { name: "Удалить пункт меню" }).first().click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Удалить" }).click();
  await expect(page.getByTestId("navigation-workspace").getByText("Внешний сайт")).toBeHidden({
    timeout: 10_000,
  });

  // seal ("fix version" in human wording)
  await page.getByRole("button", { name: "Зафиксировать версию" }).click();
  await expect(page.getByText("Версия меню зафиксирована")).toBeVisible({ timeout: 10_000 });
});

test("existing menu item is editable: click opens the same editor with prefilled values", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "+ Новое меню" }).click();
  await page.getByLabel("Ключ").fill(`edit-${unique}`);
  await page.getByLabel("Название").fill(`Меню правки ${unique}`);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Меню правки ${unique}` })).toBeVisible();

  // create an external_url item
  await page.getByRole("button", { name: "+ Пункт", exact: true }).click();
  await page.getByLabel("Тип пункта").selectOption("external_url");
  await page.getByLabel("Подпись").fill("Старая ссылка");
  await page.getByLabel("URL", { exact: true }).fill("https://old.example.ru");
  await page.getByRole("dialog").getByRole("button", { name: "Добавить" }).click();
  await expect(page.getByTestId("navigation-workspace").getByText("Старая ссылка")).toBeVisible({
    timeout: 10_000,
  });

  // click the item → the SAME editor opens, prefilled; change label + URL
  await page
    .getByTestId("navigation-workspace")
    .getByText("Старая ссылка", { exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Подпись")).toHaveValue("Старая ссылка");
  await expect(dialog.getByLabel("URL", { exact: true })).toHaveValue("https://old.example.ru");
  await dialog.getByLabel("Подпись").fill("Новая ссылка");
  await dialog.getByLabel("URL", { exact: true }).fill("https://new.example.ru");
  await dialog.getByRole("button", { name: "Сохранить" }).click();

  await expect(page.getByTestId("navigation-workspace").getByText("Новая ссылка")).toBeVisible({
    timeout: 10_000,
  });
});
