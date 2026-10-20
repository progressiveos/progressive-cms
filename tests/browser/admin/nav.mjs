// Shared viewport-aware navigation for the Admin browser corpus.
// @ts-check

// At ≤900px the sidebar is off-canvas (shell.css breakpoint): a nav link is
// outside the viewport until the burger opens it. Clicking a link closes the
// drawer again, so every nav click goes through here, mirroring a real user.
export async function clickNav(page, testId) {
  if ((page.viewportSize()?.width ?? 1280) <= 900) {
    await page.getByTestId("mobile-nav").click();
  }
  await page.getByTestId(testId).click();
}
