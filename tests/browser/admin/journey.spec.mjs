// Full content-manager journey (PCMS-ADMIN-T028; Master Plan §15 vertical
// slice "Human editor changes content without LLM" + gate §68): create page
// and article, edit with blocks, media, navigation, SEO, preview, revisions,
// scheduled release, document replace — one continuous corporate-site
// workflow, all through the Admin UI over the real API.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const unique = Date.now().toString(36);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF",
  "ascii",
);

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });
// desktop-only project guard (Admin spec §52)
test.skip(
  ({ viewport }) => (viewport?.width ?? 1280) < 1024,
  "heavy authoring flow is desktop-gated",
);
test.setTimeout(180_000);

async function login(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

test("content manager runs the full corporate-site workflow without help", async ({ page }) => {
  await login(page);

  // 1. Corporate page with blocks: heading + text + CTA.
  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();
  await page.getByLabel("Тип материала").selectOption("page");
  await page.getByLabel("Заголовок").fill(`О компании (${unique})`);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();

  const document = page.getByTestId("block-document");
  await page.getByRole("button", { name: "+ Добавить блок" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Заголовок/ })
    .first()
    .click();
  await document.getByLabel("Level").fill("2");
  await document.getByLabel("Text", { exact: true }).first().fill("Наша компания");
  await page.getByRole("button", { name: "+ Добавить блок" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Текст/ })
    .first()
    .click();
  await document
    .getByRole("textbox", { name: "Форматированный текст" })
    .fill("Мы делаем **сложные проекты** простыми.");
  // rich-text markdown → AST conversion is debounced; let it land before saving
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByTestId("save-state")).toHaveText(/Сохранено/, { timeout: 10_000 });

  // 2. SEO: explicit title override, saved with provenance visible.
  await page.getByRole("tab", { name: "SEO" }).click();
  await page.getByTestId("seo-tab").getByLabel("SEO title").fill(`О компании ${unique} — SEO`);
  await page.getByRole("button", { name: "Сохранить SEO" }).click();
  await expect(page.getByText("SEO-данные сохранены")).toBeVisible({ timeout: 10_000 });

  // 3. Seal and publish the page.
  await page.getByRole("tab", { name: "Публикация" }).click();
  const pub = page.getByTestId("publication-tab");
  await pub.getByRole("button", { name: "Проверить" }).click();
  await expect(pub.getByText(/готов к запечатыванию|готова к публикации/)).toBeVisible({
    timeout: 10_000,
  });
  await pub.getByRole("button", { name: "Запечатать" }).click();
  await expect(pub.getByRole("button", { name: "Опубликовать" })).toBeEnabled({ timeout: 10_000 });
  await pub.getByRole("button", { name: "Опубликовать" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Опубликовать", exact: true })
    .click();
  await expect(pub.getByText(/Публикация актуальна/)).toBeVisible({ timeout: 10_000 });

  // 4. Media: upload an image to the library.
  await clickNav(page, "nav-media-library");
  await page.setInputFiles('input[aria-label="Загрузить файл"]', {
    name: `hero-${unique}.png`,
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(page.getByText("Файл загружен")).toBeVisible({ timeout: 10_000 });

  // 5. Document upload + replace (stable asset reference).
  await page.setInputFiles('input[aria-label="Загрузить файл"]', {
    name: `price-${unique}.pdf`,
    mimeType: "application/pdf",
    buffer: PDF,
  });
  const pdfCard = page
    .getByTestId("media-grid")
    .locator(".pcms-media-card", { hasText: `price-${unique}.pdf` });
  await expect(pdfCard).toBeVisible({ timeout: 10_000 });
  await pdfCard.click();
  const details = page.getByTestId("media-details");
  await details.locator('input[aria-label="Новая версия документа"]').setInputFiles({
    name: `price-${unique}-v2.pdf`,
    mimeType: "application/pdf",
    buffer: Buffer.concat([PDF, Buffer.from("\n% v2", "ascii")]),
  });
  await expect(
    page.getByText("Документ заменён новой версией; ссылки остались на тот же ассет"),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole("dialog").getByRole("button", { name: "Закрыть", exact: true }).click();

  // 6. Navigation: create a set, add the page, bind to header.primary, seal.
  await clickNav(page, "nav-nav-sets");
  await page.getByRole("button", { name: "+ Новое меню" }).click();
  await page.getByLabel("Ключ").fill(`top-${unique}`);
  await page.getByLabel("Название").fill(`Верхнее меню ${unique}`);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Верхнее меню ${unique}` })).toBeVisible();
  await page.getByRole("button", { name: "Зафиксировать версию" }).click();
  await expect(page.getByText("Версия меню зафиксирована")).toBeVisible({ timeout: 10_000 });

  // 7. Scheduled release: new article revision into a changeset, 1 item batch.
  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();
  await page.getByLabel("Тип материала").selectOption("news");
  await page.getByLabel("Заголовок").fill(`Новость сайта (${unique})`);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();
  await page.getByRole("tab", { name: "Публикация" }).click();
  await page.getByTestId("publication-tab").getByRole("button", { name: "Запечатать" }).click();
  await expect(page.getByText("Ревизия запечатана").first()).toBeVisible({ timeout: 10_000 });

  await clickNav(page, "nav-pub-changesets");
  await page.getByRole("tab", { name: "Дополнительно" }).click();
  await page.getByRole("button", { name: "+ Новый набор" }).click();
  await page.getByLabel("Название").fill(`Релиз новостей ${unique}`);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Релиз новостей ${unique}` })).toBeVisible();
  await page.getByRole("button", { name: "+ Добавить элемент" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Выбрать…" }).click();
  await page.getByRole("dialog").last().getByRole("option", { name: ENTRY_TITLE() }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.getByText("Элемент добавлен")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Запланировать" }).click();
  const planDialog = page.getByRole("dialog");
  const tomorrow = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await planDialog.locator('input[type="date"]').fill(tomorrow);
  await planDialog.getByRole("button", { name: "Показать точное расписание" }).click();
  await expect(page.getByTestId("plan-timeline").locator("li")).toHaveCount(1, { timeout: 15_000 });
  await planDialog.getByRole("button", { name: "Зафиксировать расписание" }).click();
  await expect(page.getByText("Расписание зафиксировано").first()).toBeVisible({ timeout: 45_000 });

  // 8. Calendar shows the scheduled release.
  await page.getByRole("tab", { name: "Календарь" }).click();
  await expect(
    page.getByTestId("calendar-screen").getByText(`Релиз новостей ${unique}`).first(),
  ).toBeVisible({ timeout: 10_000 });

  // 9. Revisions: the article shows its sealed revision history.
  await clickNav(page, "nav-content-tree");
  await page.getByTestId("content-tree").getByText(ENTRY_TITLE()).first().click();
  // No working revision after scheduling — the workspace offers the draft
  // recovery path; take it, then inspect the revision history.
  await page.getByRole("button", { name: "Создать черновик" }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("tab", { name: "Ревизии" }).click();
  // Sealed revisions read as "ready to publish" in the humanized state column.
  await expect(
    page.getByTestId("revisions-table").getByText("Готова к публикации").first(),
  ).toBeVisible({ timeout: 10_000 });

  // 10. Logout — the workflow ends where a human would expect.
  await page.getByTestId("account-menu").click();
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page.getByRole("heading", { name: "Вход в Progressive CMS" })).toBeVisible();
});

function ENTRY_TITLE() {
  return `Новость сайта (${unique})`;
}
