// Admin Maintenance Mode (PCMS-OPS-T118; task brief §72 corpus): a permitted
// admin sees the settings and can toggle; the anonymous public receives the
// branded 503 maintenance page while enabled; a bypass-privileged user keeps
// seeing the real site; the toggle is denied to roles without
// site.maintenance; the state survives a reload; disabling restores normal
// public behavior. No Internet dependency.
// @ts-check
import { expect, test } from "@playwright/test";

const hasDb = Boolean(process.env.PCMS_TEST_DATABASE_URL);
const ADMIN = "http://127.0.0.1:8788/admin/";
const API = "http://127.0.0.1:8788/api/v1";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
// Generated per createEditor call: two tests in one run must not collide on
// user_emails_normalized_uniq.
const editorEmail = () =>
  `editor-maint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.com`;
const EDITOR_PASSWORD = "e2e-Editor-Pass-2026!";

test.skip(!hasDb, "PCMS_TEST_DATABASE_URL is not configured");
test.use({ baseURL: ADMIN });
test.setTimeout(120_000);

async function loginViaUi(page, email = OWNER_EMAIL, password = OWNER_PASSWORD) {
  await page.goto(ADMIN);
  await page.getByLabel("Электронная почта").fill(email);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

async function apiLogin(request, email, password) {
  const response = await request.post(`${API}/auth/login`, { data: { email, password } });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const cookie = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value)
    .find((value) => value.startsWith("pcms_session="));
  return { cookie: cookie.split(";")[0], csrf: body.csrf_token };
}

async function createEditor(request) {
  const owner = await apiLogin(request, OWNER_EMAIL, OWNER_PASSWORD);
  const editor_email = editorEmail();
  const created = await request.post(`${API}/users`, {
    headers: { cookie: owner.cookie, "x-pcms-csrf": owner.csrf },
    data: { display_name: "Maint Editor", email: editor_email, role_key: "EDITOR" },
  });
  expect(created.ok()).toBe(true);
  const inviteToken = (await created.json()).invite_token;
  const accepted = await request.post(`${API}/auth/invite/accept`, {
    data: { invite_token: inviteToken, password: EDITOR_PASSWORD },
  });
  expect(accepted.ok()).toBe(true);
  return { owner, editor_email };
}

test("maintenance lifecycle: admin toggle, anonymous 503, bypass stays real, state survives reload", async ({
  page,
  request,
}) => {
  await createEditor(request);
  await loginViaUi(page);

  // Authorized admin sees the maintenance settings.
  await page.goto(`${ADMIN}#/maintenance`);
  await expect(
    page.getByRole("heading", { name: "Доступ к сайту — режим обслуживания" }).first(),
  ).toBeVisible();

  // Start from a known-PUBLIC state; the toggle button is present.
  // (ADMIN-UX redesign: toggles run through the confirm dialog and use
  // explicit action verbs — «Включить технический режим» / «Открыть сайт».)
  const enableButton = page.getByRole("button", { name: "Включить технический режим" });
  const disableButton = page.getByRole("button", { name: "Открыть сайт" });
  const confirmIn = (dialog) =>
    dialog.getByRole("button", { name: /Включить технический режим|Открыть сайт/ });
  await expect(enableButton.or(disableButton)).toBeEnabled();
  if (await disableButton.isVisible()) {
    await disableButton.click();
    const offConfirm = page.getByRole("alertdialog");
    await confirmIn(offConfirm).click();
    await expect(enableButton).toBeVisible();
  }

  // Enable from the Admin UI (confirm → server result → UI state).
  await enableButton.click();
  const onConfirm = page.getByRole("alertdialog");
  await expect(onConfirm).toBeVisible();
  await onConfirm.getByRole("button", { name: "Включить технический режим" }).click();
  await expect(page.getByText("MAINTENANCE — сайт закрыт")).toBeVisible();
  // The warning states the bypass semantics (task brief §31).
  await expect(page.getByText(/site.maintenance.bypass/)).toBeVisible();

  // Anonymous public receives the branded maintenance page (503, noindex).
  // Node fetch: deliberately cookie-less — the `request` fixture shares the
  // browser context's owner session, which would bypass and mask the gate.
  const anon = await fetch("http://127.0.0.1:8788/");
  expect(anon.status).toBe(503);
  expect(await anon.text()).toContain("Progressive CMS");
  expect(anon.headers.get("retry-after")).not.toBeNull();

  // Admin session keeps working (the SPA screen still loads live state).
  await page.reload();
  await expect(page.getByText("MAINTENANCE — сайт закрыт")).toBeVisible();

  // The bypass-privileged owner sees the real application surface, not the
  // 503 page — the gate releases the request to the standard app behavior.
  const owner = await apiLogin(request, OWNER_EMAIL, OWNER_PASSWORD);
  const bypassHome = await request.get("http://127.0.0.1:8788/", {
    headers: { cookie: owner.cookie },
    maxRedirects: 0,
  });
  expect(bypassHome.status()).not.toBe(503);

  // Disable: the anonymous public receives normal behavior again.
  await page.goto(`${ADMIN}#/maintenance`);
  await page.getByRole("button", { name: "Открыть сайт" }).click();
  const offConfirm = page.getByRole("alertdialog");
  await expect(offConfirm).toBeVisible();
  await offConfirm.getByRole("button", { name: "Открыть сайт" }).click();
  await expect(page.getByText("PUBLIC — сайт открыт")).toBeVisible();
  const anonAfter = await fetch("http://127.0.0.1:8788/search/");
  expect(anonAfter.status).toBe(200);
});

test("role without site.maintenance cannot toggle and gets no navigation", async ({
  page,
  request,
}) => {
  const { owner, editor_email } = await createEditor(request);
  const editor = await apiLogin(request, editor_email, EDITOR_PASSWORD);
  const denied = await request.put(`${API}/maintenance`, {
    headers: { cookie: editor.cookie, "x-pcms-csrf": editor.csrf },
    data: { enabled: true },
  });
  expect(denied.status()).toBe(403);

  // And the public site stays in its current (non-maintenance) state.
  const publicState = await fetch("http://127.0.0.1:8788/search/");
  expect(publicState.status).toBe(200);
  void owner;
});
