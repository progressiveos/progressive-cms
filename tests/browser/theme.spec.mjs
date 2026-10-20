// Reference theme browser smoke (PCMS-THEME-T023): routes render, assets
// load, no JS errors, responsive navigation, interactive behaviors.
import { expect, test } from "@playwright/test";

test("preview index lists fixtures", async ({ page }) => {
  await page.goto("/preview");
  await expect(page.getByRole("heading", { name: "Preview" })).toBeVisible();
  await expect(page.locator("a[href='/preview/home']")).toBeVisible();
});

for (const fixture of [
  "home",
  "service-full",
  "case-full",
  "article-long",
  "news-short",
  "error-404",
  "edge-long-title",
  "edge-no-hero",
  "edge-multiple-cta",
]) {
  test(`route /preview/${fixture} renders without JS errors`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const response = await page.goto(`/preview/${fixture}`);
    expect(response.status()).toBe(200);
    await expect(page.locator("main#main")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("theme assets load", async ({ page }) => {
  const responses = [];
  page.on("response", (r) => {
    if (r.url().includes("/assets/")) responses.push(r.status());
  });
  await page.goto("/preview/home");
  await expect(page.locator("link[rel='stylesheet']")).toHaveCount(1);
  await expect.poll(() => responses.length).toBeGreaterThanOrEqual(1);
  for (const status of responses) expect(status).toBe(200);
});

test("desktop: primary navigation visible, menu toggle hidden", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/preview/home");
  await expect(page.locator(".site-nav--primary")).toBeVisible();
  await expect(page.locator(".menu-toggle")).toBeHidden();
});

test("tablet: compact navigation visible", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/preview/home");
  await expect(page.locator(".site-nav--compact")).toBeVisible();
});

test("mobile: menu toggle opens the mobile navigation", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/preview/home");
  const toggle = page.locator(".menu-toggle");
  const nav = page.locator("#mobile-nav");
  await expect(toggle).toBeVisible();
  await expect(nav).toBeHidden();
  await toggle.click();
  await expect(nav).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(nav).toBeHidden();
});

test("calculator evaluates the fixture formula", async ({ page }) => {
  await page.goto("/preview/service-full");
  const area = page.locator("input[name='area']");
  await area.fill("100");
  await page.locator("select[name='kind']").selectOption({ label: "Warehouse" });
  const output = page.locator(".calc-output");
  await expect(output).toHaveText(/150\.00/); // 100 * 1.5 = 150.00 ₽
  await area.fill("200");
  await expect(output).toHaveText(/300\.00/);
});

test("gallery lightbox opens and closes with Escape", async ({ page }) => {
  await page.goto("/preview/service-full");
  const lightbox = page.locator(".lightbox");
  await expect(lightbox).toBeHidden();
  await page.locator("[data-lightbox] a[data-full]").first().click();
  await expect(lightbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
});
