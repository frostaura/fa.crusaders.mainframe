import { defineConfig, devices } from "@playwright/test";

/**
 * The REAL-STACK suite: a browser against the running compose stack, not against Vite with the
 * API intercepted.
 *
 * <p>
 * `playwright.config.ts` (testDir `./e2e`) is the CI suite and answers every `/api` call from a
 * route table, which proves the screens and nothing about the server. This one proves the
 * journey: the production build behind nginx, the real API, real Postgres, real mail landing in
 * MailHog. It is for the local walk and is never run by CI — CI has no stack to point it at.
 * </p>
 *
 * <p>
 * <b>No `webServer`.</b> Starting a stack is `make up`'s job, and a runner that started one
 * would also tear it down, taking the walker's data with it. `globalSetup` checks the gateway
 * answers and fails in one sentence when it does not.
 * </p>
 *
 * <p>
 * <b>One worker, in order.</b> The specs share one database and one mailbox. Parallel specs
 * would race each other's approvals and the anonymous auth rate limit (10 a minute per IP).
 * </p>
 */
const headed = !!process.env.HEADED;

export default defineConfig({
  testDir: "./e2e-real",
  outputDir: "./test-results/real",
  globalSetup: "./e2e-real/support/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_REAL_BASE_URL ?? "http://localhost:8088",
    headless: !headed,
    launchOptions: {
      slowMo: Number(process.env.SLOWMO ?? (headed ? 250 : 0)),
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    },
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
});
