// Rich text editor browser flow (PCMS-ADMIN-T005; Admin spec §19): the editor
// uses canonical AST v2 through WYSIWYG; typed HTML remains inert text.
// @ts-check
import { expect, test } from "@playwright/test";
import { clickNav } from "./nav.mjs";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const TITLE = `Кейс-richtext (${Date.now().toString(36)})`;

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });

async function login(page) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  const authenticated = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/auth/login") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Войти" }).click();
  const { csrf_token } = await (await authenticated).json();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
  await clickNav(page, "nav-content-tree");
  await page.getByRole("button", { name: "+ Создать" }).click();
  await page.getByLabel("Тип материала").selectOption("case");
  await page.getByLabel("Заголовок").fill(TITLE);
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/entries") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("entry-workspace")).toBeVisible();
  return { ...(await (await created).json()), csrf: csrf_token };
}

test("rich text: WYSIWYG formatting round-trips without making saved content dirty", async ({
  page,
}) => {
  await login(page);
  const editor = page.getByTestId("richtext-editor");
  const area = editor.getByRole("textbox", { name: "Форматированный текст" });

  await area.fill("Текст с выделением");
  await area.press("Control+End");
  await area.press("Control+Shift+ArrowLeft");
  const bold = editor.getByRole("button", { name: "Полужирный", exact: true });
  // The toolbar is icon-driven (CORE-RC19 C): the accessible name is the only
  // text — the button renders a glyph, never the label.
  await expect(bold).toHaveText("");
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  await bold.click();
  await expect(area.locator("strong")).toHaveText("выделением");
  // Active state is reflected for assistive tech, not only visually.
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  // The label doubles as the tooltip: hovering names the button.
  await bold.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Полужирный", { timeout: 5_000 });
  // Keyboard operability: the toolbar buttons are real buttons in tab order.
  await bold.focus();
  await expect(bold).toBeFocused();
  await expect(page.getByTestId("save-state")).toHaveText(/Есть несохранённые изменения/, {
    timeout: 10_000,
  });
  await expect(editor.getByRole("alert")).toHaveCount(0);

  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByTestId("save-state")).toHaveText(/Сохранено/, { timeout: 10_000 });

  // Reload must not emit a synthetic document edit.
  await page.reload();
  const reloaded = page.getByTestId("richtext-editor");
  const area2 = reloaded.getByRole("textbox", { name: "Форматированный текст" });
  await expect(area2).toBeVisible({ timeout: 10_000 });
  await expect(area2).toContainText("Текст с выделением");
  await expect(area2.locator("strong")).toHaveText("выделением");
  await expect(page.getByTestId("save-state")).toHaveText("");

  // Typed source text never becomes executable HTML in a visual editor.
  await area2.fill("<b>привет</b>");
  await expect(area2).toHaveText("<b>привет</b>");
  await expect(area2.locator("b")).toHaveCount(0);
});

test("opening a document leaves its persisted payload and edit generation unchanged", async ({
  page,
}) => {
  const { revision_id, csrf } = await login(page);
  // Canonical AST v2 (Core 1.0 is v2-only). The point of the test is that
  // merely opening and reloading the editor neither rewrites the payload nor
  // bumps the edit generation — so a v2 fixture with a mark exercises exactly
  // the same round-trip the editor used to be given in v1.
  const v2 = {
    schema_version: 2,
    type: "document",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Legacy unchanged", marks: ["strong"] }],
      },
    ],
  };
  const before = await page.evaluate(
    async ({ id, csrf, body }) => {
      const current = await (await fetch(`/api/v1/revisions/${id}`)).json();
      const result = await fetch(`/api/v1/revisions/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-pcms-csrf": csrf },
        body: JSON.stringify({
          expected_edit_generation: current.edit_generation,
          payload: { ...current.payload, fields: { ...current.payload.fields, body } },
        }),
      });
      if (!result.ok) throw new Error(`v2 fixture: ${result.status}`);
      return (await fetch(`/api/v1/revisions/${id}`)).json();
    },
    { id: revision_id, csrf, body: v2 },
  );
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Форматированный текст" })).toContainText(
    "Legacy unchanged",
  );
  await expect(page.getByTestId("save-state")).toHaveText("");
  const after = await page.evaluate(
    async (id) => (await fetch(`/api/v1/revisions/${id}`)).json(),
    revision_id,
  );
  expect(after.payload).toEqual(before.payload);
  expect(after.edit_generation).toBe(before.edit_generation);
});
