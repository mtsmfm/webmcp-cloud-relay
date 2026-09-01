import { defineConfig } from "@playwright/test";

/**
 * End-to-end test against the real stack: the extension loaded into
 * Chromium with native WebMCP enabled (--enable-features=WebMCP), and the
 * relay running in workerd via `wrangler dev`.
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  // One worker: the tests share one relay and one browser profile.
  workers: 1,
  globalSetup: "./global-setup",
  webServer: {
    command: "pnpm exec wrangler dev --port 18789",
    cwd: "../relay",
    url: "http://127.0.0.1:18789",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
