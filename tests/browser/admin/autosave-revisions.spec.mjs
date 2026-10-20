// Autosave + revisions browser flow (PCMS-ADMIN-T008; Admin spec §20/§24/§25).
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const TITLE = `Автосохранение (${Date.now().toString(36)})`;

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
  await page.getByLabel("Тип материала").selectOption("news");
  await page.getByLabel("Заголовок").fill(TITLE);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();
}

test("autosave persists edits without clicking save and reports state", async ({ page }) => {
  await login(page);
  const titleField = page.getByTestId("entry-workspace").getByLabel("Заголовок", { exact: true });
  await titleField.fill(`${TITLE} — автосохранение`);
  await expect(page.getByTestId("save-state")).toHaveText(/Сохранение…|Сохранено/, {
    timeout: 10_000,
  });
  await expect(page.getByTestId("save-state")).toHaveText(/Сохранено/, { timeout: 10_000 });

  // Reload proves the autosave hit the server.
  await page.reload();
  const reloaded = page.getByTestId("entry-workspace").getByLabel("Заголовок", { exact: true });
  await expect(reloaded).toHaveValue(`${TITLE} — автосохранение`, { timeout: 10_000 });
});

test("revisions tab lists revisions and shows a semantic diff", async ({ page }) => {
  await login(page);
  const titleField = page.getByTestId("entry-workspace").getByLabel("Заголовок", { exact: true });
  await titleField.fill(`${TITLE} — ред.1`);
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByTestId("save-state")).toHaveText(/Сохранено/, { timeout: 10_000 });

  // Setup: seal the working revision via the API (seal UI lands with T009),
  // then branch a second revision through the UI ("Черновик из ревизии").
  await page.evaluate(async () => {
    const rotated = await fetch("/api/v1/auth/session/rotate", { method: "POST" }).then((r) =>
      r.json(),
    );
    const entryId = window.location.hash.split("/")[2];
    const list = await fetch(`/api/v1/entries/${entryId}/revisions`).then((r) => r.json());
    const working = list.items.find((item) => item.state === "WORKING");
    await fetch(`/api/v1/revisions/${working.id}/seal`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pcms-csrf": rotated.csrf_token },
      body: "{}",
    });
  });

  // Rotate invalidated the app's in-memory CSRF token; a reload re-acquires
  // it via the session-rotation bootstrap. After the seal there is no working
  // revision, so the workspace shows the "needs draft" state — branch from
  // the sealed revision right in the Revisions tab.
  await page.reload();
  await expect(page.getByTestId("content-tree")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("content-tree").getByText(`${TITLE} — ред.1`).first().click();

  // No working revision after the seal: the workspace offers the recovery
  // path — create a fresh draft branched from the sealed revision.
  await page.getByRole("button", { name: "Создать черновик" }).click();
  const workspace = page.getByTestId("entry-workspace");
  await expect(workspace).toBeVisible({ timeout: 10_000 });

  // Change the branched draft so the semantic diff has something to show.
  await workspace.getByLabel("Заголовок", { exact: true }).fill(`${TITLE} — ред.2`);
  await expect(page.getByTestId("save-state")).toHaveText(/Сохранено/, { timeout: 10_000 });
  await page.getByRole("tab", { name: "Ревизии" }).click();
  const table = page.getByTestId("revisions-table");
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(2, { timeout: 10_000 });

  const diffButton = table.getByRole("button", { name: "Сравнить с предыдущей" }).last();
  await diffButton.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/ред\.2/).first()).toBeVisible();
});
