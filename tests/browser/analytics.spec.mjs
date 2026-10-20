// Analytics & Tagging browser acceptance (Analytics spec §13/§14/§16;
// brief §31/§34). Runs against the REAL composition spawned in
// analytics-server.mts (api fixture + site render + saved analytics
// settings): mock-DNI call tracking, form lifecycle + Webvisor privacy
// markers, consent-deferred GTM activation, blocked-provider resilience.
import { spawn } from "node:child_process";
import { expect, test } from "@playwright/test";

const FIXTURE_HOST = process.env.PCMS_ANALYTICS_FIXTURE_URL ?? null;
let childProcess = null;
let baseUrl = FIXTURE_HOST;

if (baseUrl === null) {
  // Spawned lazily in beforeAll for local runs; CI sets PCMS_ANALYTICS_FIXTURE_URL.
  test.beforeAll(async () => {
    childProcess = spawn("node", ["--import", "tsx", "tests/browser/analytics-server.mts"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    baseUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("analytics fixture server timeout")),
        120_000,
      );
      let buffer = "";
      childProcess.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const match = /READY (\d+)/.exec(buffer);
        if (match !== null) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      });
      childProcess.stderr.on("data", (chunk) => process.stderr.write(chunk));
    });
  });
  test.afterAll(async () => {
    childProcess?.kill("SIGTERM");
  });
}

/** External analytics must never hit the real network in tests; GTM requests
 * are counted so the consent-deferred activation is observable. */
async function sandbox(page, options = {}) {
  const gtmRequests = { count: 0 };
  await page.route("**mc.yandex.ru/**", (route) => route.abort());
  await page.route("**googletagmanager.com/**", (route) => {
    gtmRequests.count += 1;
    return route.abort();
  });
  await page.route("**vendor.example/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: options.dniScript ?? "window.__dniLoaded = true;",
    }),
  );
  return { gtmRequests };
}

test("mock DNI provider mutates phone links; clicks still tracked; no console errors", async ({
  page,
}) => {
  const { gtmRequests } = { gtmRequests: { count: 0 } };
  await page.route("**mc.yandex.ru/**", (route) => route.abort());
  await page.route("**googletagmanager.com/**", (route) => {
    gtmRequests.count += 1;
    return route.abort();
  });
  // The DNI fixture: loads as an external async tag, rewrites every tel:
  // link (text + href) AFTER load — exactly what call tracking does.
  await page.route("**vendor.example/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        document.querySelectorAll('a[href^="tel:"]').forEach((a) => {
          a.textContent = "+7 495 111-22-33";
          a.setAttribute("href", "tel:+74951112233");
        });
        window.__dniLoaded = true;
      `,
    }),
  );
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto(`${baseUrl}/`);
  // The runtime pushed the page view before any provider loaded.
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.dataLayer?.some((row) => row?.event === "pcms_page_view") === true,
      ),
    )
    .toBe(true);
  // The mock DNI tag loads as an external async script (like Calltouch).
  await page.addScriptTag({ url: "https://vendor.example/dni.js" });
  await page.waitForFunction(() => window.__dniLoaded === true, null, { timeout: 10_000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('a[href^="tel:"]')].some(
        (a) => a.getAttribute("href") === "tel:+74951112233",
      ),
    null,
    { timeout: 10_000 },
  );
  // Click tracking after mutation: delegation reads the CURRENT href.
  await page.locator('a[href^="tel:"]').first().click();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        window.dataLayer.some(
          (row) => row?.event === "pcms_phone_click" && row.link_href === "tel:+74951112233",
        ),
      ),
    )
    .toBe(true);
  expect(gtmRequests.count, "consent-deferred GTM stays silent before grant").toBe(0);
  // Blocked-by-design external requests (mc.yandex abort) surface as resource
  // load failures — they are the scenario, not page errors.
  expect(
    consoleErrors.filter((message) => !message.includes("net::ERR_FAILED")),
    "no console/page errors beyond the blocked provider",
  ).toEqual([]);
});

test("form lifecycle: start/submit/success via public intake; Webvisor privacy markers", async ({
  page,
}) => {
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await page.route("**mc.yandex.ru/**", (route) => route.abort());
  await page.route("**googletagmanager.com/**", (route) => route.abort());
  await page.route("**/api/v1/public/intake", (route) =>
    route.fulfill({ status: 200, body: "{}" }),
  );
  // A first-party-shaped form present at DOMContentLoaded (init script runs
  // before the analytics runtime, so privacy marking sees it).
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const form = document.createElement("form");
      form.setAttribute("data-pcms-form-id", "lead-form");
      form.innerHTML = '<input name="name"/><button type="submit">Send</button>';
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void fetch("/api/v1/public/intake", { method: "POST", body: "{}" });
      });
      document.querySelector("main")?.append(form);
    });
  });
  await page.goto(`${baseUrl}/`);
  await page.fill('form[input], form input[name="name"]', "Иван");
  // Webvisor privacy marker is on the field; the VALUE is never in dataLayer.
  await expect(page.locator('form input[name="name"]')).toHaveClass(/ym-disable-keys/);
  await expect
    .poll(async () =>
      page.evaluate(() => window.dataLayer.some((row) => row?.event === "pcms_form_start")),
    )
    .toBe(true);
  await page.click('form button[type="submit"]');
  await expect
    .poll(async () =>
      page.evaluate(() =>
        window.dataLayer.some(
          (row) => row?.event === "pcms_form_submit" && row.form_id === "lead-form",
        ),
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(() => window.dataLayer.some((row) => row?.event === "pcms_form_success")),
    )
    .toBe(true);
  const leaked = await page.evaluate(() =>
    window.dataLayer.some((row) => JSON.stringify(row).includes("Иван")),
  );
  expect(leaked, "form values never enter the dataLayer").toBe(false);
  expect(consoleErrors, "no page errors").toEqual([]);
});

test("form error path: failed intake answers pcms_form_error", async ({ page }) => {
  await page.route("**mc.yandex.ru/**", (route) => route.abort());
  await page.route("**googletagmanager.com/**", (route) => route.abort());
  await page.route("**/api/v1/public/intake", (route) =>
    route.fulfill({ status: 500, body: "{}" }),
  );
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const form = document.createElement("form");
      form.setAttribute("data-pcms-form-id", "failing");
      form.innerHTML = '<input name="name"/><button type="submit">Send</button>';
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void fetch("/api/v1/public/intake", { method: "POST", body: "{}" }).catch(() => {});
      });
      document.querySelector("main")?.append(form);
    });
  });
  await page.goto(`${baseUrl}/`);
  await page.click('form button[type="submit"]');
  await expect
    .poll(async () =>
      page.evaluate(() => window.dataLayer.some((row) => row?.event === "pcms_form_error")),
    )
    .toBe(true);
});

test("consent-deferred GTM activates on grant; strict CSP carries scoped blob", async ({
  page,
}) => {
  const { gtmRequests } = await sandbox(page);
  const response = await page.goto(`${baseUrl}/`);
  const csp = response.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("blob:");
  expect(/frame-src[^;]*blob:/.test(csp)).toBe(true);
  expect(/script-src[^;]*blob:/.test(csp)).toBe(false);
  expect(gtmRequests.count).toBe(0);
  await page.evaluate(() => window.pcmsConsent.grant("marketing"));
  await page.waitForTimeout(300);
  expect(gtmRequests.count, "GTM loads only after the marketing consent").toBeGreaterThanOrEqual(1);
});

test("blocked Metrica never breaks the page; 404 still carries analytics", async ({ page }) => {
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await sandbox(page);
  await page.goto(`${baseUrl}/`);
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.dataLayer?.some((row) => row?.event === "pcms_page_view") === true,
      ),
    )
    .toBe(true);
  const notFound = await page.goto(`${baseUrl}/definitely-missing/`);
  expect(notFound.status()).toBe(404);
  await expect
    .poll(async () => page.evaluate(() => Boolean(window.__PCMS_ANALYTICS_CONFIG__)))
    .toBe(true);
  expect(consoleErrors, "provider failures are not page errors").toEqual([]);
});
