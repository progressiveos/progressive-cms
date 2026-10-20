import { expect, test } from "@playwright/test";
import {
  buildSystemDocumentInjection,
  createAnalyticsRegistry,
  defaultAnalyticsSettings,
  FIRST_PARTY_PROVIDERS,
} from "../../packages/analytics/src/index.ts";

const registry = createAnalyticsRegistry();
for (const provider of FIRST_PARTY_PROVIDERS) registry.registerProvider(provider);
const defaults = defaultAnalyticsSettings();
const injection = buildSystemDocumentInjection(
  {
    ...defaults,
    providers: {
      ...defaults.providers,
      google_analytics_4: {
        enabled: true,
        measurementId: "G-TEST123456",
        activationPolicy: "analytics_consent",
      },
      google_tag_manager: {
        enabled: true,
        containerId: "GTM-ABC1234",
        debugMode: false,
        activationPolicy: "marketing_consent",
      },
    },
  },
  registry,
  {
    siteKey: "test",
    pageId: "page",
    pageType: "page",
    locale: "en",
    isSearch: false,
    isNotFound: false,
  },
);
const policy = [
  "default-src 'none'",
  `script-src 'self' https://www.googletagmanager.com ${injection.scriptHashes.join(" ")}`,
  "connect-src 'self'",
].join("; ");

test("strict-CSP: category grant, independent bootstrap, revoke and return visit produce only allowed network requests", async ({
  page,
  context,
}) => {
  const requests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "https://consent.example") {
      if (url.pathname === "/pulse") {
        requests.push(url.searchParams.get("provider"));
        return route.fulfill({ body: "ok" });
      }
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        headers: { "content-security-policy": policy },
        body: `<!doctype html><html><head>${injection.headEarlyHtml}</head><body>Consent test</body></html>`,
      });
    }
    if (url.origin === "https://www.googletagmanager.com") {
      const provider = url.pathname.includes("/gtag/") ? "analytics" : "marketing";
      requests.push(`${provider}-loader`);
      return route.fulfill({
        contentType: "application/javascript",
        body: `
        window.__${provider}Loaded = true;
        window.__${provider}Timer = setInterval(() => fetch('/pulse?provider=${provider}'), 40);
      `,
      });
    }
    throw new Error(`Unexpected network request: ${url.origin}`);
  });
  await page.goto("https://consent.example/");
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
  await page.evaluate(() => window.pcmsConsent.grant("marketing"));
  await expect.poll(() => requests.includes("marketing")).toBe(true);
  expect(requests).not.toContain("analytics-loader");
  expect(await page.evaluate(() => JSON.stringify(window.dataLayer))).not.toContain("G-TEST123456");
  await page.evaluate(() => window.pcmsConsent.grant("analytics"));
  await expect.poll(() => requests.includes("analytics")).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(window.dataLayer))).toContain("G-TEST123456");
  await Promise.all([
    page.waitForEvent("load"),
    page.evaluate(() => window.pcmsConsent.revoke("analytics")),
  ]);
  expect(await page.evaluate(() => window.pcmsConsent.getState())).toEqual({
    analytics: false,
    marketing: true,
  });
  expect(await page.evaluate(() => window.__analyticsLoaded)).toBeUndefined();
  const analyticsAfterReset = requests.filter((value) => value.startsWith("analytics")).length;
  const marketingAfterReset = requests.filter((value) => value === "marketing").length;
  await expect
    .poll(() => requests.filter((value) => value === "marketing").length)
    .toBeGreaterThan(marketingAfterReset);
  expect(requests.filter((value) => value.startsWith("analytics"))).toHaveLength(
    analyticsAfterReset,
  );
  await page.reload();
  expect(await page.evaluate(() => window.pcmsConsent.getState())).toEqual({
    analytics: false,
    marketing: true,
  });
  expect(await page.evaluate(() => window.__analyticsLoaded)).toBeUndefined();
  expect(requests.filter((value) => value === "analytics-loader")).toHaveLength(1);
  expect(errors).toEqual([]);
});
