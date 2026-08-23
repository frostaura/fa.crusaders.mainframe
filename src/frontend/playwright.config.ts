import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests, against the real frontend build.
 *
 * <p>
 * `make test-e2e` has existed since the pipeline was written and ran Playwright,
 * which was not installed and had no config and no spec — so it failed with a
 * command-not-found that read as a broken machine rather than as a missing suite.
 * This is what it should have been pointing at.
 * </p>
 *
 * <p>
 * <b>Mobile viewport first.</b> The product is a mobile-first PWA that members use
 * standing in a corridor; a desktop-only E2E suite would miss the layout everybody
 * actually sees. A desktop project runs the same specs afterwards.
 * </p>
 *
 * <p>
 * The dev server is started by Playwright rather than assumed, so a run needs one
 * command and cannot half-work against a stale one somebody left up.
 * </p>
 */
/**
 * Where the browser is.
 *
 * <p>
 * Playwright pins a browser revision per release and refuses to launch a different
 * one, which is normally right. It is wrong on a runner that ships a browser already:
 * `npx playwright install` re-downloads a few hundred megabytes on every CI run to
 * get a build that differs from the present one by a revision number.
 * </p>
 *
 * <p>
 * `PLAYWRIGHT_CHROMIUM_PATH` points at the one that is already there when a runner
 * provides it. Unset, this is empty and Playwright uses its own — so a developer
 * machine needs no special setup and CI needs no download.
 * </p>
 */
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
  : {};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,

  // A test that only passes on a retry is a flaky test, and a flaky money test is
  // worse than no test. CI gets one retry to distinguish infrastructure from logic
  // and the result is reported either way.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4173",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },

  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"], launchOptions } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions } },
  ],

  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:4173",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
