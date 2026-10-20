// Human publication workflow (owner UX pass 0.1.28 §6/§7/§9): a draft shows
// up under «Готово к публикации», is published WITHOUT ever creating a
// changeset by hand, and the operation appears in «История» with a human
// title, actor and result — revision UUIDs stay out of the primary view.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const unique = Date.now().toString(36);
const TITLE = `Публикация без набора ${unique}`;

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

async function login(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

test("draft publishes from the ready tab and lands in history", async ({ page }) => {
  await login(page);

  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();
  await page.getByLabel("Тип материала").selectOption("page");
  await page.getByLabel("Заголовок").fill(TITLE);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();

  // The pending view lists the draft; no changeset was created by the editor.
  await clickNav(page, "nav-pub-changesets");
  const ready = page.getByTestId("ready-screen");
  await expect(page.getByRole("tab", { name: "Готово к публикации" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const row = page.getByTestId("pending-table").getByRole("row", { name: new RegExp(TITLE) });
  await expect(row).toBeVisible({ timeout: 10_000 });
  // status is an icon group with tooltips: the draft is marked "not published yet"
  const statusCell = row.locator("[data-testid^='pending-status-']");
  await expect(statusCell.getByLabel("Ещё не опубликовано")).toBeVisible();
  await expect(statusCell.getByLabel("Ещё не опубликовано")).toHaveAttribute(
    "title",
    "Ещё не опубликовано",
  );

  // Publish straight from the pending list (icon action, confirmation, done).
  await row.getByRole("button", { name: "Опубликовать" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Опубликовать" }).click();
  await expect(page.getByText("Материал опубликован")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId("pending-table").getByRole("row", { name: new RegExp(TITLE) }),
  ).toBeHidden();

  // History shows a human operation, not revision ids.
  await page.getByRole("tab", { name: "История" }).click();
  const history = page.getByTestId("history-table");
  await expect(history.getByText(new RegExp(`Entry publication.*${TITLE}`))).toBeVisible({
    timeout: 10_000,
  });
});

/** API setup inside the authenticated page (house pattern): entry lifecycle
 * helpers used by the preview/schedule regression tests below. */
async function apiSetup(page) {
  const rotatedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/auth/session/rotate") && response.request().method() === "POST",
  );
  await page.reload();
  const rotate = await (await rotatedResponse).json();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
  const headers = { "x-pcms-csrf": rotate.csrf_token, "content-type": "application/json" };

  const call = (method, path, body) =>
    page.evaluate(
      async ({ method, path, body, headers }) => {
        const response = await fetch(`/api/v1${path}`, {
          method,
          credentials: "same-origin",
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        return { status: response.status, body: text === "" ? null : JSON.parse(text) };
      },
      { method, path, body, headers },
    );

  const createDraftEntry = async (title) => {
    const created = await call("POST", "/entries", {
      content_type: "page",
      payload: { fields: { title }, blocks: { schema_version: 1, blocks: [] } },
    });
    expect(created.status).toBe(201);
    return { entryId: created.body.entry_id, revisionId: created.body.revision_id };
  };
  const seal = async (revisionId) => {
    const sealed = await call("POST", `/revisions/${revisionId}/seal`, {});
    expect(sealed.status).toBe(200);
  };
  const publish = async (entryId, revisionId) => {
    const published = await call("POST", "/publications/publish", {
      entity_type: "entry",
      entity_id: entryId,
      target_revision_id: revisionId,
      expected_generation: 0,
    });
    expect([200, 201]).toContain(published.status);
  };
  const forkDraft = async (entryId, fromRevisionId) => {
    const draft = await call("POST", `/entries/${entryId}/draft`, {
      from_revision_id: fromRevisionId,
    });
    expect(draft.status).toBe(201);
  };
  return { call, createDraftEntry, seal, publish, forkDraft };
}

test("preview observes a working revision without sealing or forking", async ({ page }) => {
  await login(page);
  const api = await apiSetup(page);

  // published baseline + a working revision on top (the exact owner case)
  const published = `Prev pub ${unique}`;
  const entry = await api.createDraftEntry(published);
  await api.seal(entry.revisionId);
  await api.publish(entry.entryId, entry.revisionId);
  await api.forkDraft(entry.entryId, entry.revisionId);
  const beforePreview = await api.call("GET", `/entries/${entry.entryId}/revisions`);
  expect(beforePreview.status).toBe(200);
  expect(beforePreview.body.items.some((revision) => revision.state === "WORKING")).toBe(true);

  await clickNav(page, "nav-pub-changesets");
  const row = page.getByTestId("pending-table").getByRole("row", { name: new RegExp(published) });
  await expect(row).toBeVisible({ timeout: 10_000 });
  // published baseline is visible as its own dimension
  const statusCell = row.locator("[data-testid^='pending-status-']");
  await expect(statusCell.getByLabel("Опубликовано")).toBeVisible();
  await expect(statusCell.getByLabel("Есть неопубликованные изменения")).toBeVisible();

  const popupPromise = page.waitForEvent("popup");
  await row.getByRole("button", { name: "Предпросмотр" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  expect(popup.url()).toContain("/preview/page?token=");
  const body = await popup.textContent("body");
  expect(body ?? "").not.toContain("REVISION_NOT_SEALED");
  expect(body).toContain(published);
  await popup.close();
  const afterPreview = await api.call("GET", `/entries/${entry.entryId}/revisions`);
  expect(afterPreview).toEqual(beforePreview);
});

test("draft-only entry preview opens observationally", async ({ page }) => {
  await login(page);
  const api = await apiSetup(page);

  const title = `Prev draft ${unique}`;
  const entry = await api.createDraftEntry(title);
  const beforePreview = await api.call("GET", `/entries/${entry.entryId}/revisions`);
  expect(beforePreview.status).toBe(200);
  expect(beforePreview.body.items.some((revision) => revision.state === "WORKING")).toBe(true);

  await clickNav(page, "nav-pub-changesets");
  const row = page.getByTestId("pending-table").getByRole("row", { name: new RegExp(title) });
  await expect(row).toBeVisible({ timeout: 10_000 });

  const popupPromise = page.waitForEvent("popup");
  await row.getByRole("button", { name: "Предпросмотр" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  expect(popup.url()).toContain("/preview/page?token=");
  const body = await popup.textContent("body");
  expect(body ?? "").not.toContain("REVISION_NOT_SEALED");
  expect(body).toContain(title);
  await popup.close();
  const afterPreview = await api.call("GET", `/entries/${entry.entryId}/revisions`);
  expect(afterPreview).toEqual(beforePreview);
});

test("schedule from the pending list: dialog, success, clock icon, calendar", async ({ page }) => {
  await login(page);
  const api = await apiSetup(page);

  const title = `По расписанию ${unique}`;
  await api.createDraftEntry(title);

  await clickNav(page, "nav-pub-changesets");
  const row = page.getByTestId("pending-table").getByRole("row", { name: new RegExp(title) });
  await expect(row).toBeVisible({ timeout: 10_000 });

  await row.getByRole("button", { name: "Запланировать" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/часовой пояс/i)).toBeVisible();
  // never schedule into the past (default 09:00 may already be gone)
  await dialog.getByLabel("Время старта").fill("23:59");
  await dialog.getByRole("button", { name: "Запланировать", exact: true }).click();
  await expect(page.getByText("Расписание зафиксировано")).toBeVisible({ timeout: 15_000 });

  // the row carries the scheduled clock icon with an exact-date tooltip
  const statusCell = row.locator("[data-testid^='pending-status-']");
  await expect(statusCell.getByLabel(/Запланировано на/)).toBeVisible({ timeout: 10_000 });

  // the calendar shows the scheduled entry
  await page.getByRole("tab", { name: "Календарь" }).click();
  await expect(page.getByTestId("calendar-screen").getByText(new RegExp(title))).toBeVisible({
    timeout: 10_000,
  });
});
