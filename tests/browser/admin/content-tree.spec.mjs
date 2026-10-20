// Content Tree hierarchy browser flow (Admin spec §4/§5): indentation via
// aria-level, create-child from the row menu, explicit location path in the
// editor, compact status icons (published/draft accessible names), HTML5
// drag&drop reparenting and drop-to-root. The route-invariance proof on a
// ROUTED entry lives in tests/api/entry-move-route-invariance.test.ts.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const unique = Date.now().toString(36);
const PARENT = `Отдел (${unique})`;
const CHILD = `Сотрудник (${unique})`;
const OTHER = `Филиал (${unique})`;

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

async function login(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

async function createRootEntry(page, type, title) {
  await page.getByRole("button", { name: "+ Создать" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Тип материала").selectOption(type);
  // Scoped: the entry workspace behind the dialog has its own title field.
  await dialog.getByRole("textbox", { name: "Заголовок", exact: true }).fill(title);
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();
}

/** Dispatch an HTML5 drag sequence with a real DataTransfer — deterministic
 * where synthesized mouse drags are not (rows are draggable divs). dragstart
 * goes first so drag-conditional targets (the root drop zone) can render
 * before the destination handle is resolved. */
async function dragRowTo(page, source, target) {
  const srcHandle = await source.elementHandle();
  await srcHandle.evaluate((src) => {
    src.dispatchEvent(
      new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      }),
    );
  });
  const dstHandle = await target.elementHandle();
  await dstHandle.evaluate((dst, src) => {
    const options = { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() };
    dst.dispatchEvent(new DragEvent("dragover", options));
    dst.dispatchEvent(new DragEvent("drop", options));
    src.dispatchEvent(new DragEvent("dragend", options));
  }, srcHandle);
}

const row = (page, title) => page.locator(".pcms-tree__line", { hasText: title }).first();

test("tree hierarchy: child rows indent, move via drag&drop, route survives", async ({ page }) => {
  await login(page);
  await clickNav(page, "nav-content-tree");

  // Parent and a second root to receive the moved child later.
  await createRootEntry(page, "page", PARENT);
  await createRootEntry(page, "page", OTHER);

  // Create child from the parent's row menu (Admin spec §5).
  const parentRow = row(page, PARENT);
  await expect(parentRow).toHaveAttribute("aria-level", "1");
  await parentRow.getByTestId("tree-row-menu").click();
  await page.getByRole("menuitem", { name: "Создать дочерний" }).click();
  const childDialog = page.getByRole("dialog");
  await expect(childDialog).toContainText(PARENT);
  await childDialog.getByLabel("Тип материала").selectOption("page");
  await childDialog.getByRole("textbox", { name: "Заголовок", exact: true }).fill(CHILD);
  await childDialog.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();

  // The tree shows the hierarchy: child indented under its parent (level 2),
  // and the editor names the explicit location path.
  const childRow = row(page, CHILD);
  await expect(childRow).toHaveAttribute("aria-level", "2");
  const location = page.getByTestId("editor-location");
  await expect(location).toContainText(PARENT);
  await expect(location).toContainText("Корень дерева");

  // Publish the child so it has a canonical route, then remember it.
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByTestId("save-state")).toHaveText(/Сохранено/, { timeout: 10_000 });
  await page.getByRole("tab", { name: "Публикация" }).click();
  const pub = page.getByTestId("publication-tab");
  await pub.getByRole("button", { name: "Проверить" }).click();
  await pub.getByRole("button", { name: "Запечатать" }).click({ timeout: 10_000 });
  await pub.getByRole("button", { name: "Опубликовать" }).click({ timeout: 10_000 });
  // Publish runs through a ConfirmDialog (no native dialogs in the redesign).
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Опубликовать" })
    .click({ timeout: 10_000 });
  await expect(pub.getByText(/Публикация актуальна/)).toBeVisible({ timeout: 10_000 });
  // Compact statuses (owner UX gap B): the published row shows icon(s) with
  // an accessible name; textual chips are gone from tree rows entirely.
  const publishedRow = row(page, CHILD);
  await expect(publishedRow.locator(".pcms-tree__status-icon--published")).toBeVisible();
  await expect(publishedRow.getByRole("img", { name: "Опубликовано" })).toHaveCount(1);
  await expect(publishedRow).not.toContainText("опубликовано");
  await expect(publishedRow).not.toContainText("черновик");
  // Published + working draft = both icons side by side.
  await publishedRow.click();
  // Published revision is sealed — start a new working draft from it.
  await page.getByRole("tab", { name: "Ревизии" }).click();
  await page
    .getByTestId("entry-workspace")
    .getByRole("button", { name: "Действия" })
    .first()
    .click();
  let resumeRevisionLoad;
  const revisionLoadGate = new Promise((resolve) => {
    resumeRevisionLoad = resolve;
  });
  const revisionRoute = /\/api\/v1\/revisions\/[^/]+$/;
  await page.route(revisionRoute, async (route) => {
    if (route.request().method() === "GET") await revisionLoadGate;
    await route.continue();
  });
  try {
    await page.getByRole("menuitem", { name: "Создать черновик из этой версии" }).click();
    await expect(page.getByTestId("entry-draft-loading")).toBeVisible();
  } finally {
    resumeRevisionLoad();
  }
  await expect(page.getByTestId("entry-draft-loading")).toHaveCount(0);
  await page.unroute(revisionRoute);
  await page.getByRole("tab", { name: "Контент" }).click();
  const titleField = page.getByTestId("entry-workspace").getByLabel("Заголовок", { exact: true });
  await titleField.fill(`${CHILD} — ред.2`);
  // Autosave (debounced) persists the working draft over the publication.
  await expect(page.getByTestId("save-state")).toHaveText(/Сохранено/, { timeout: 10_000 });
  await expect(
    publishedRow.getByRole("img", { name: "Есть неопубликованные изменения" }),
  ).toHaveCount(1);
  await expect(publishedRow.getByRole("img", { name: "Опубликовано" })).toHaveCount(1);

  // Drag the child onto the other root: reparent, same depth semantics.
  await dragRowTo(page, childRow, row(page, OTHER));
  const movedRow = row(page, CHILD);
  await expect(movedRow).toHaveAttribute("aria-level", "2", { timeout: 10_000 });
  await expect(page.getByTestId("editor-location")).toContainText(OTHER);

  // (Route invariance on a routed entry is proven in
  // tests/api/entry-move-route-invariance.test.ts with a real canonical route.)

  // Drop onto the root zone moves the entry back to the top level.
  await dragRowTo(page, movedRow, page.getByTestId("tree-drop-root"));
  await expect(row(page, CHILD)).toHaveAttribute("aria-level", "1", { timeout: 10_000 });
});

test("structural folder: workspace, rename, create child, no publication chrome", async ({
  page,
}) => {
  await login(page);
  await clickNav(page, "nav-content-tree");

  const folderName = `Раздел (${unique})`;
  await page.getByRole("button", { name: "+ Создать" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Тип материала").selectOption("folder");
  await dialog.getByRole("textbox", { name: "Заголовок", exact: true }).fill(folderName);
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();

  // Folder opens the structural workspace — no editor tabs, no save bar.
  const workspace = page.getByTestId("folder-workspace");
  await expect(workspace).toBeVisible();
  await expect(page.getByTestId("editor-workspace")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Адрес" })).toHaveCount(0);
  await expect(page.getByTestId("folder-child-count")).toHaveText(/0/);

  // Rename through the workspace dialog.
  await workspace.getByRole("button", { name: "Переименовать" }).click();
  const renameDialog = page.getByRole("dialog");
  await renameDialog.getByRole("textbox", { name: "Название" }).fill(`${folderName} — 2`);
  await renameDialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByTestId("folder-title")).toContainText(`${folderName} — 2`, {
    timeout: 10_000,
  });

  // Content-manager flow: create child inside the folder, parent is automatic.
  await workspace.getByRole("button", { name: "Создать дочерний" }).click();
  const childDialog = page.getByRole("dialog");
  await expect(childDialog).toContainText(`${folderName} — 2`);
  await childDialog.getByLabel("Тип материала").selectOption("page");
  const childTitle = `Материал папки (${unique})`;
  await childDialog.getByRole("textbox", { name: "Заголовок", exact: true }).fill(childTitle);
  await childDialog.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();
  await expect(row(page, childTitle)).toHaveAttribute("aria-level", "2", { timeout: 10_000 });
  // Regression: a child renders once (nested), never duplicated at root level.
  await expect(page.locator(".pcms-tree__line", { hasText: childTitle })).toHaveCount(1);

  // The folder row carries no lifecycle badges (no draft chip of its own).
  const folderRow = row(page, `${folderName} — 2`);
  await expect(folderRow).toHaveAttribute("aria-level", "1");
  await expect(folderRow).not.toContainText("черновик");
  await expect(folderRow).not.toContainText("опубликовано");

  // Selecting the folder again shows the structural workspace with the count.
  await folderRow.click();
  await expect(page.getByTestId("folder-workspace")).toBeVisible();
  await expect(page.getByTestId("folder-child-count")).toHaveText(/1/);
});
