// Playwright configuration (PCMS-THEME-T023/T024; Admin spec §64, M10).
// Two surfaces: the theme preview server (M03 regression) and the Admin
// workspace e2e server (disposable PostgreSQL + production bundle).
// @ts-check
import { existsSync, readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// Mirror the npm scripts' `--env-file-if-exists=.env` so browser specs see the
// same test environment (PCMS_TEST_DATABASE_URL etc.). Existing env wins.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match !== null && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

export default defineConfig({
  testDir: "tests/browser",
  // Installed-runtime gates have their own external-URL configs and run separately.
  testIgnore: ["**/installed-rc12/**", "**/installed-richtext-v2/**", "**/installed-favicon/**"],
  timeout: 30_000,
  retries: 0,
  // Admin specs share one e2e server + database; parallel files interfere
  // through global lists (changesets auto-selects the newest release).
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8787",
    // Corpus-wide deterministic RU baseline (PCMS-OPS-T131): the Admin UI
    // locale is browser-resolvable (ru|en fallback chain) and the corpus
    // asserts the RU catalog — pin it regardless of the host OS. Dedicated
    // EN acceptance specs override per file with test.use({ locale: "en-US" }).
    locale: "ru-RU",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node --import tsx scripts/theme-preview-server.mts --port 8787",
      url: "http://127.0.0.1:8787/",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "node --import tsx scripts/admin-e2e-server.mts --port 8788",
      url: "http://127.0.0.1:8788/health/live",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    // Chromium-only: only the chromium build is provisioned; tablet/mobile are
    // viewport classes for responsive smoke, not cross-engine gates (spec §55).
    {
      name: "tablet",
      use: {
        ...devices["iPad (gen 7)"],
        browserName: "chromium",
        viewport: { width: 820, height: 1180 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 375, height: 812 },
      },
    },
  ],
});
