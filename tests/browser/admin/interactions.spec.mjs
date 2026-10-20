// Interactions workspace browser acceptance (PCMS-FORM-T022; Forms spec §32):
// owner creates a form definition, submits it through the public endpoint,
// sees the submission history, and works a lead through its lifecycle.
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

test.describe(() => {
  test.skip(({ viewport }) => (viewport?.width ?? 1280) < 1024, "workspace flow is desktop-gated");

  test("forms → public submit → submissions → leads lifecycle", async ({ page }) => {
    await page.goto(ADMIN);
    await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
    await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();

    // Rotate the session to obtain a CSRF token for in-page API calls
    // (house pattern from autosave-revisions.spec.mjs).
    const rotatedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/auth/session/rotate") && response.request().method() === "POST",
    );
    await page.reload();
    const rotate = await (await rotatedResponse).json();
    await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
    const headers = { "x-pcms-csrf": rotate.csrf_token, "content-type": "application/json" };

    // Create a lead-generating form definition through the API.
    const key = `e2e_form_${unique}`;
    const created = await page.evaluate(
      async ({ key, headers }) => {
        const response = await fetch("/api/v1/forms", {
          method: "POST",
          credentials: "same-origin",
          headers,
          body: JSON.stringify({
            key,
            title: "E2E форма",
            fields: [
              { key: "email", type: "email", label: "E-mail", required: true },
              { key: "message", type: "text", label: "Сообщение", required: true, max_length: 300 },
            ],
            settings: {
              lead_policy: { create_lead: true, email_from: "email", summary_from: "message" },
            },
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      { key, headers },
    );
    expect(created.status).toBe(201);
    const formId = created.body.id;

    // Workspace: the definition is listed.
    await clickNav(page, "nav-interactions-forms");
    await expect(page.getByTestId("interactions-forms-screen")).toBeVisible();
    await expect(page.getByTestId("interactions-forms-screen").getByText(key)).toBeVisible();

    // Public submission from the same browser (same-origin POST is allowed).
    const submitted = await page.evaluate(
      async ({ formId, headers }) => {
        const response = await fetch(`/api/v1/public/forms/${formId}/submit`, {
          method: "POST",
          credentials: "same-origin",
          headers,
          body: JSON.stringify({
            values: {
              email: "e2e-lead@example.com",
              message: `Хочу услугу (${formId.slice(0, 8)})`,
            },
            submission_token: `e2e-tok-${formId.slice(0, 8)}`,
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      { formId, headers },
    );
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe("ACCEPTED");
    expect(submitted.body.lead_id).not.toBeNull();

    // Duplicate retry does not create a second record.
    const retry = await page.evaluate(
      async ({ formId, headers }) => {
        const response = await fetch(`/api/v1/public/forms/${formId}/submit`, {
          method: "POST",
          credentials: "same-origin",
          headers,
          body: JSON.stringify({
            values: { email: "e2e-lead@example.com", message: "дубликат" },
            submission_token: `e2e-tok-${formId.slice(0, 8)}`,
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      { formId, headers },
    );
    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.submission_id).toBe(submitted.body.submission_id);

    // Reload: the manual rotation above invalidated the SPA's in-memory CSRF
    // token; a reload re-bootstraps the app (fresh rotate) before we drive
    // SPA-initiated mutations.
    await page.reload();
    await clickNav(page, "nav-interactions-submissions");
    await expect(page.getByTestId("interactions-submissions-screen")).toBeVisible();
    const table = page.getByTestId("submissions-table");
    await expect(table.getByText("ACCEPTED").first()).toBeVisible();

    // Leads: lifecycle NEW → PROCESSED.
    await clickNav(page, "nav-interactions-leads");
    await expect(page.getByTestId("interactions-leads-screen")).toBeVisible();
    const leadTable = page.getByTestId("leads-table");
    await expect(leadTable.getByText("e2e-lead@example.com")).toBeVisible();
    const row = leadTable.getByRole("row").filter({ hasText: "e2e-lead@example.com" });
    await row.getByRole("button", { name: "Обработан" }).click();
    await expect(row.getByText("PROCESSED")).toBeVisible();

    // Lead detail drawer (owner task §62): fields plus the READ delivery
    // projection — with nothing configured it honestly says "none yet".
    page.on("pageerror", (error) => console.log("PAGEERROR:", error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) console.log("HTTP", response.status(), response.url());
    });
    await row.getByText("e2e-lead@example.com").click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("e2e-lead@example.com")).toBeVisible();
    await expect(drawer.getByTestId("lead-deliveries")).toBeVisible();
    await expect(drawer.getByText("Внешняя доставка пока не выполнялась.")).toBeVisible();
    await drawer.getByRole("button", { name: "Закрыть" }).click();
    await expect(drawer).toBeHidden();
  });

  test("quiz flow is visible in the runs workspace", async ({ page }) => {
    await page.goto(ADMIN);
    await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
    await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();

    const rotatedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/auth/session/rotate") && response.request().method() === "POST",
    );
    await page.reload();
    const rotate = await (await rotatedResponse).json();
    await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
    const headers = { "x-pcms-csrf": rotate.csrf_token, "content-type": "application/json" };

    const quizKey = `e2e_quiz_${unique}`;
    const created = await page.evaluate(
      async ({ quizKey, headers }) => {
        const response = await fetch("/api/v1/quizzes", {
          method: "POST",
          credentials: "same-origin",
          headers,
          body: JSON.stringify({
            key: quizKey,
            title: "E2E квиз",
            steps: [
              {
                id: "s1",
                questions: [{ id: "q1", type: "boolean", label: "Вы с нами?", required: true }],
              },
            ],
            outcomes: [{ id: "ok", title: "Отлично" }],
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      { quizKey, headers },
    );
    expect(created.status).toBe(201);

    await clickNav(page, "nav-interactions-quizzes");
    await expect(page.getByTestId("interactions-quizzes-screen").getByText(quizKey)).toBeVisible();
  });
});

test("form editor route opens the visual builder from the list", async ({ page }) => {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(OWNER_EMAIL);
  await page.getByLabel("Пароль").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();

  // Create via the UI: the builder opens automatically after creation.
  await clickNav(page, "nav-interactions-forms");
  await page.getByRole("button", { name: "Новое определение" }).first().click();
  await page.getByLabel("Ключ").fill(`e2e_builder_${unique}`);
  await page.getByLabel("Заголовок").fill("Билдер e2e");
  await page.getByRole("button", { name: "Создать", exact: true }).last().click();
  await expect(page.getByTestId("form-editor")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "+ Добавить поле" })).toBeVisible();
  await expect(page.getByText("Дополнительно").first()).toBeVisible();

  // Back to the list: rows open the editor too.
  await clickNav(page, "nav-interactions-forms");
  const table = page.getByTestId("interactions-forms-table");
  await expect(table).toBeVisible({ timeout: 10_000 });
  await table.getByRole("row").nth(1).getByRole("button", { name: "Редактировать" }).click();
  await expect(page.getByTestId("form-editor")).toBeVisible({ timeout: 10_000 });
});
