import type { Page } from "@playwright/test";
import { signIn, test, expect } from "./fixtures";
import { fontsReady } from "./layoutKit";

/**
 * Review round 7, lane FD2 — the purchase status page at 1920 (J7-1 / L7-12).
 *
 * <p>
 * It was a 64rem column: 48 % of a 1920 window, its title 496 px in while every other member page's
 * stood on the 120rem frame — and "Closes by itself" was said twice, once under the status and
 * again in the details beside it.
 * </p>
 */

const SESSION_MEMBER = {
  tenant_slug: "crusaders",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  user_id: "00000000-0000-0000-0000-000000000002",
  is_authenticated: true,
  is_admin: false,
};

const ID = "aaaa1111-0000-0000-0000-00000000007c";
const PENDING = {
  id: ID, status: "Pending", package_id: "p-5", package_name: "5 hours", minutes: 300, list_price_zar: 550, discount_bps: 0,
  amount_zar: 550, failure_code: null, created_at: "2026-10-01T12:05:00Z", expires_at: "2026-10-01T13:05:00Z",
};

async function stubApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path.startsWith(`/api/v1/minutes/purchase/${ID}`)) return json(PENDING);
    if (path.startsWith("/api/v1/whoami")) return json(SESSION_MEMBER);
    if (path.startsWith("/api/v1/wallet")) return json({ balance_minutes: 120, entries: [], total_entries: 0, offset: 0, limit: 50 });
    if (path.startsWith("/api/v1/me/profile")) {
      return json({ full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null, membership_number: "P-1" });
    }
    return route.fulfill({ status: 501, contentType: "application/json", body: "{}" });
  });
}

test.describe("the purchase status page at 1920 (J7-1 / L7-12)", () => {
  test.beforeEach(({ page: _page }, info) => { test.skip(info.project.name !== "desktop", "sized explicitly; one project is enough"); });

  test("stands on the 120rem frame like the other member pages, and says when it closes once", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await signIn(page);
    await stubApi(page);
    await page.goto(`/wallet/buy/${ID}`);
    await expect(page.getByText("Waiting for confirmation from PayFast…")).toBeVisible();
    await fontsReady(page);
    const shell = (await page.locator("[data-page-shell]").first().boundingBox())!;
    expect(shell.width / 1920, "a 64rem column in a 1920 window").toBeGreaterThanOrEqual(0.9);
    expect(await page.locator("[data-page-frame=full]").count(), "the app bar follows the full frame").toBeGreaterThan(0);
    await expect(page.getByText(/Closes by itself/)).toHaveCount(1);
  });
});
