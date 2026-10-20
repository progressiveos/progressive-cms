// Accessibility automated smoke (PCMS-THEME-T024; Theme Contract spec §53).
// Critical violations fail the gate: landmarks, one h1, alt handling, form
// labels, menu toggle semantics, keyboard behavior, reduced-motion support.
import { expect, test } from "@playwright/test";

const FIXTURES = [
  "home",
  "service-full",
  "case-full",
  "article-long",
  "news-short",
  "error-404",
  "edge-long-title",
  "edge-no-hero",
  "edge-multiple-cta",
];

test("every page exposes exactly one banner, main and contentinfo landmark", async ({ page }) => {
  for (const fixture of FIXTURES) {
    await page.goto(`/preview/${fixture}`);
    await expect(page.locator("header.site-header")).toHaveCount(1);
    await expect(page.locator("main#main")).toHaveCount(1);
    await expect(page.locator("footer.site-footer")).toHaveCount(1);
  }
});

test("every page has exactly one h1 and no skipped heading levels beyond h1", async ({ page }) => {
  for (const fixture of FIXTURES) {
    await page.goto(`/preview/${fixture}`);
    await expect(page.locator("h1")).toHaveCount(1);
    // h4-h6 may only appear after a higher-level heading exists.
    const levels = await page.evaluate(() =>
      [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName[1])),
    );
    let seen = levels[0] ?? 0;
    let ok = true;
    for (const level of levels.slice(1)) {
      if (level > seen + 1) ok = false;
      seen = level;
    }
    expect(ok, `heading hierarchy broken on ${fixture}: ${levels.join(",")}`).toBe(true);
  }
});

test("all images have an alt attribute", async ({ page }) => {
  for (const fixture of FIXTURES) {
    await page.goto(`/preview/${fixture}`);
    const missing = await page.evaluate(() =>
      [...document.querySelectorAll("img")]
        .filter((img) => !img.hasAttribute("alt"))
        .map((img) => img.getAttribute("src")),
    );
    expect(missing, `images without alt on ${fixture}`).toEqual([]);
  }
});

test("calculator inputs are labelled", async ({ page }) => {
  await page.goto("/preview/service-full");
  const unlabelled = await page.evaluate(() =>
    [...document.querySelectorAll(".block-calculator input, .block-calculator select")]
      .filter((input) => {
        const label = input.closest("label");
        return label === null || (label.textContent ?? "").trim() === "";
      })
      .map((input) => input.getAttribute("name")),
  );
  expect(unlabelled).toEqual([]);
});

test("menu toggle exposes expanded state and controls the nav", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/preview/home");
  const toggle = page.locator(".menu-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const controls = await toggle.getAttribute("aria-controls");
  expect(controls).toBe("mobile-nav");
  expect(await page.locator(`#${controls}`).count()).toBe(1);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("keyboard: menu toggle is reachable by Tab and focus is visible", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/preview/home");
  await page.keyboard.press("Tab"); // logo link
  await page.keyboard.press("Tab"); // site search link (header, 456a680)
  await page.keyboard.press("Tab"); // menu toggle
  const tag = await page.evaluate(() => document.activeElement?.className ?? "");
  expect(tag).toContain("menu-toggle");
  const focusVisible = await page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return { matches: false, style: "" };
    return {
      matches: el.matches(":focus-visible"),
      style: getComputedStyle(el).outlineStyle,
    };
  });
  expect(focusVisible.matches).toBe(true);
  expect(focusVisible.style).not.toBe("none");
});

test("lightbox closes with Escape (keyboard behavior)", async ({ page }) => {
  await page.goto("/preview/service-full");
  await page.locator("[data-lightbox] a[data-full]").first().click();
  const lightbox = page.locator(".lightbox");
  await expect(lightbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
});

test("navigation links are real crawlable anchors; groups are not links", async ({ page }) => {
  await page.goto("/preview/home");
  const groupAsLink = await page.evaluate(
    () => [...document.querySelectorAll(".site-nav .group > a")].length,
  );
  expect(groupAsLink).toBe(0);
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll(".site-nav--primary a")].map((a) => a.getAttribute("href")),
  );
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) expect(href, "nav anchor without href").not.toBeNull();
});

test("reduced-motion support is declared in theme CSS", async ({ page }) => {
  await page.goto("/preview/home", { waitUntil: "networkidle" });
  await expect(page.locator("link[rel='stylesheet']")).toHaveCount(1);
  const hasReducedMotion = await page.evaluate(() => {
    const link = document.querySelector("link[rel='stylesheet']");
    if (link === null) return Promise.resolve(false);
    return fetch(link.href)
      .then((r) => r.text())
      .then((css) => css.includes("prefers-reduced-motion"));
  });
  expect(hasReducedMotion).toBe(true);
});
