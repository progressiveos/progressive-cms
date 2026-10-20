// No API or database: verify the shared column geometry using shipped Admin CSS.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const css = ["tokens.css", "components.css"]
  .map((name) => readFileSync(`apps/admin/src/design/${name}`, "utf8"))
  .join("\n");

test("placement selects share columns across different technical key lengths", async ({ page }) => {
  const keys = [
    "header.primary",
    "header.mobile",
    "footer.primary",
    "footer.services",
    "footer.legal",
  ];
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div class="pcms-placement-list">${keys
      .map(
        (key) =>
          `<div class="pcms-placement-row"><span class="pcms-placement-row__mark">✓</span><div class="pcms-placement-row__body"><strong>Меню</strong><div>глубина ≤ 3</div></div><select class="pcms-select pcms-placement-row__binding"><option>Основное меню</option></select><code class="pcms-placement-row__key">${key}</code></div>`,
      )
      .join("")}</div></body></html>`,
  );
  for (const width of [1280, 1000, 820, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const boxes = await page.locator(".pcms-placement-row__binding").evaluateAll((items) =>
      items.map((item) => {
        const box = item.getBoundingClientRect();
        return { x: box.x, right: box.right, width: box.width };
      }),
    );
    for (const box of boxes) {
      expect(box.x).toBeCloseTo(boxes[0].x, 5);
      expect(box.width).toBeCloseTo(boxes[0].width, 5);
      expect(box.right).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
});
