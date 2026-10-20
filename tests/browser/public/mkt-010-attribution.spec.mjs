// MKT-010: first-touch capture survives same-tab navigation and sends only
// allowlisted fields from the reference theme to the existing public APIs.
// @ts-check
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const THEME_SCRIPT = resolve("themes/reference-theme-v1/assets/js/theme.js");

test.describe(() => {
  test.skip(({ viewport }) => (viewport?.width ?? 1280) < 1024, "desktop theme smoke");

  test("form and quiz retain first-touch UTM after navigation without sending query noise", async ({
    page,
  }) => {
    await page.goto(
      "/preview?utm_source=VK&utm_campaign=launch&email=private%40example.com&gclid=click-123",
    );
    await page.addScriptTag({ path: THEME_SCRIPT });
    await page.evaluate(() => document.dispatchEvent(new Event("DOMContentLoaded")));

    // A full navigation in the same tab drops the landing query. The session
    // snapshot must survive and keep the first tagged path and values.
    await page.goto("/?other=private-query");
    await page.evaluate(() => {
      document.body.innerHTML = `
        <form data-pcms-form action="/form-submit">
          <input name="name" value="Тест">
          <p data-form-status hidden></p>
          <button type="submit">Отправить</button>
        </form>
        <section data-pcms-quiz data-quiz-start="/quiz-start"
          data-quiz-answer="/quiz-answer" data-quiz-complete="/quiz-complete"
          data-start-label="Начать квиз">
          <div data-quiz-body></div>
          <p data-quiz-status role="status" hidden></p>
        </section>`;
    });
    const requests = [];
    await page.route("**/form-submit", async (route) => {
      requests.push({ kind: "form", body: route.request().postDataJSON() });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: { message: "Принято" } }),
      });
    });
    await page.route("**/quiz-start", async (route) => {
      requests.push({ kind: "quiz", body: route.request().postDataJSON() });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          quiz_run_id: "run",
          resume_token: "token",
          step: { questions: [] },
        }),
      });
    });
    await page.addScriptTag({ path: THEME_SCRIPT });
    await page.evaluate(() => document.dispatchEvent(new Event("DOMContentLoaded")));

    await page
      .locator("form[data-pcms-form]")
      .evaluate((form) =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
    await page.getByRole("button", { name: "Начать квиз" }).click();
    await expect.poll(() => requests.length).toBe(2);

    for (const { body } of requests) {
      expect(body.attribution).toMatchObject({
        utm_source: "VK",
        utm_campaign: "launch",
        landing_path: "/preview",
      });
      expect(JSON.stringify(body.attribution)).not.toMatch(/email|private|gclid|click-123|other/);
    }
  });
});
