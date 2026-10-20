// Media library browser flow (PCMS-ADMIN-T014/T015; Admin spec §32/§33):
// upload → grid → details → metadata save → usage; document replace keeps
// the asset id stable (T015).
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const unique = Date.now().toString(36);

// 1×1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

async function login(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
  await clickNav(page, "nav-media-library");
  await expect(page.getByTestId("media-screen")).toBeVisible();
}

test("upload image, edit metadata, see usage and versions", async ({ page }) => {
  await login(page);
  const filename = `pixel-${unique}.png`;
  await page.setInputFiles('input[aria-label="Загрузить файл"]', {
    name: filename,
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(page.getByText("Файл загружен")).toBeVisible({ timeout: 10_000 });
  const card = page.getByTestId("media-grid").locator(".pcms-media-card", { hasText: filename });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();

  const details = page.getByTestId("media-details");
  await expect(details).toBeVisible();
  await details.getByLabel("Название").fill(`Пиксель ${unique}`);
  await details.getByLabel("Alt (по умолчанию)").fill("Однопиксельная картинка");
  await details.getByRole("button", { name: "Сохранить метаданные" }).click();
  await expect(page.getByText("Метаданные сохранены")).toBeVisible({ timeout: 10_000 });
  await expect(details.getByText(/Использование/)).toBeVisible();
  await expect(details.getByText(/Версии/)).toBeVisible();
});

// Focal reset regression (p-cms.com 0.1.162 acceptance): after an in-card
// focal save, "Сбросить в центр" + save must PATCH explicit focal_x:null /
// focal_y:null — the stale load-time snapshot used to make the dirty-check
// treat the reset as a no-op while the server kept the old crop.
test("focal pick then reset-to-center PATCHes explicit nulls", async ({ page }) => {
  await login(page);
  const filename = `focal-${unique}.png`;
  const sharp = (await import("sharp")).default;
  const preview = await sharp({
    create: { width: 160, height: 120, channels: 3, background: { r: 90, g: 140, b: 200 } },
  })
    .png()
    .toBuffer();
  await page.setInputFiles('input[aria-label="Загрузить файл"]', {
    name: filename,
    mimeType: "image/png",
    buffer: preview,
  });
  await expect(page.getByText("Файл загружен")).toBeVisible({ timeout: 10_000 });
  const card = page.getByTestId("media-grid").locator(".pcms-media-card", { hasText: filename });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  const details = page.getByTestId("media-details");

  const patches = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && /\/api\/v1\/media\/[^/]+$/.test(request.url())) {
      patches.push({ id: request.url().split("/").pop(), body: request.postDataJSON() });
    }
  });

  const area = details.getByTestId("media-focal-area");
  await expect(area).toBeVisible();
  const box = await area.boundingBox();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.8);
  await expect(details.getByTestId("media-focal-marker")).toBeVisible();
  await details.getByRole("button", { name: "Сохранить метаданные" }).click();
  await expect(details.getByTestId("media-focal-value")).not.toHaveText(/центр/);
  expect(patches[0]?.body?.focal_x).toBeCloseTo(0.3, 1);
  expect(patches[0]?.body?.focal_y).toBeCloseTo(0.8, 1);

  await details.getByRole("button", { name: "Сбросить в центр" }).click();
  await details.getByRole("button", { name: "Сохранить метаданные" }).click();
  await expect(details.getByTestId("media-focal-value")).toHaveText(/центр \(по умолчанию\)/);
  const reset = patches[patches.length - 1];
  expect(reset?.body).toMatchObject({ focal_x: null, focal_y: null });
  // Server state converges to the explicit nulls (the acceptance GET check).
  await expect
    .poll(async () => {
      const detail = await page.evaluate(async (assetId) => {
        const response = await fetch(`/api/v1/media/${assetId}`);
        return response.json();
      }, reset.id);
      return [detail.asset.focalX, detail.asset.focalY];
    })
    .toEqual([null, null]);
});

test("document upload and replace keep one asset (stable reference)", async ({ page }) => {
  await login(page);
  const docName = `doc-${unique}.pdf`;
  const minimalPdf = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF",
    "ascii",
  );
  await page.setInputFiles('input[aria-label="Загрузить файл"]', {
    name: docName,
    mimeType: "application/pdf",
    buffer: minimalPdf,
  });
  const card = page.getByTestId("media-grid").locator(".pcms-media-card", { hasText: docName });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  const details = page.getByTestId("media-details");

  // replace with v2 content; the asset (and any references) stays stable
  await details.getByRole("button", { name: "Загрузить новую версию" }).click();
  // file input is visually hidden but actionable
  const versionInput = details.locator('input[aria-label="Новая версия документа"]');
  await versionInput.setInputFiles({
    name: `doc-${unique}-v2.pdf`,
    mimeType: "application/pdf",
    buffer: Buffer.concat([minimalPdf, Buffer.from("\n% v2", "ascii")]),
  });
  await expect(
    page.getByText("Документ заменён новой версией; ссылки остались на тот же ассет"),
  ).toBeVisible({ timeout: 10_000 });
  await expect(details.getByRole("listitem").filter({ hasText: /^v2 ·/ })).toBeVisible({
    timeout: 10_000,
  });
});

// Owner UX pass 0.1.28 (§1): folder rows use compact icon actions — pencil
// renames (dialog), trash asks a danger confirmation; no bare "✕"/text spam.
test("folder icon actions: rename via pencil, delete via confirmed trash", async ({ page }) => {
  await login(page);
  const folders = page.getByTestId("media-folders");
  const folderName = `Папка-иконки ${unique}`;

  await folders.getByRole("button", { name: /Папка$/ }).click();
  await page.getByLabel("Название", { exact: true }).fill(folderName);
  await page.getByRole("dialog").getByRole("button", { name: "Создать" }).click();
  const row = folders.locator(".pcms-tree__line", { hasText: folderName });
  await expect(row).toBeVisible({ timeout: 10_000 });

  // rename via the pencil icon (accessible name, not visible text)
  await row.getByRole("button", { name: "Переименовать" }).click();
  const renameDialog = page.getByRole("dialog");
  await renameDialog.getByLabel("Название").fill(`${folderName} — 2`);
  await renameDialog.getByRole("button", { name: "Переименовать" }).click();
  const renamedRow = folders.locator(".pcms-tree__line", { hasText: `${folderName} — 2` });
  await expect(renamedRow).toBeVisible({ timeout: 10_000 });

  // delete via the trash icon requires an explicit danger confirmation
  await renamedRow.getByRole("button", { name: "Удалить папку" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText(/только если она пуста/)).toBeVisible();
  await confirm.getByRole("button", { name: "Удалить папку" }).click();
  await expect(folders.locator(".pcms-tree__line", { hasText: `${folderName} — 2` })).toBeHidden({
    timeout: 10_000,
  });
});
