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

/**
 * The zone the BROWSER runs in — deliberately neither the club's nor this machine's.
 *
 * <p>
 * Every fixture club is `Africa/Johannesburg`, and the developer's machine is too. So a screen
 * that wrote a court time in the reader's zone instead of the club's rendered the right hour on
 * every local run and went red only on CI, whose runner is UTC (run 36532040584: "16:00–16:45"
 * for an 18:00 game). Pinning the browser here makes local and CI one run.
 * </p>
 *
 * <p>
 * <b>Why New York and not UTC.</b> UTC is where a second class of bug hides: a formatter that
 * reads `getUTCHours()` or slices `toISOString()` for a date agrees with a UTC browser by
 * construction, so under UTC it looks like "the reader's zone" and passes any fixture written in
 * UTC. New York is west of UTC, six hours from the club (seven in its winter) and has DST, so the
 * club's day, UTC's day and the reader's day all differ, and a court time that is not in the
 * club's zone cannot coincide with the right answer at any hour.
 * </p>
 *
 * <p>
 * The Node side (fixture maths in the specs themselves) is pinned to UTC, CI's own zone, so a
 * spec that builds a date with local-time methods computes the same thing here as on the runner.
 * Set before any worker is spawned; workers inherit it.
 * </p>
 */
const BROWSER_ZONE = "America/New_York";
process.env.TZ = "UTC";

const PORT = process.env.PW_PORT ?? "4173";
const LOCAL_URL = `http://localhost:${PORT}`;

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
    baseURL: process.env.E2E_BASE_URL ?? LOCAL_URL,
    timezoneId: BROWSER_ZONE,
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
        env: { VITE_DEV_PORT: PORT },
        url: LOCAL_URL,
        // Never reuse by default. Another clone of this repo holding the port is a server that
        // answers, and a lane once ran its whole suite against that clone's build and read the
        // result as its own. A busy port is now a loud failure; PW_PORT moves off it, and
        // PW_REUSE_SERVER=1 is for somebody who started the server themselves, on purpose.
        reuseExistingServer: process.env.PW_REUSE_SERVER === "1",
        timeout: 60_000,
      },
});
