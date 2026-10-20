import { defineConfig } from "@playwright/test";

// Standalone managed-tag network proof; no CMS server, DB or vendor requests.
export default defineConfig({
  testDir: ".",
  testMatch: "analytics-consent.spec.mjs",
  workers: 1,
  timeout: 20_000,
  retries: 0,
  reporter: "list",
  use: { browserName: "chromium" },
});
