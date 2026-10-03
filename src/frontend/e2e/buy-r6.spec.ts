import type { Page } from "@playwright/test";
import { signIn, test, expect } from "./fixtures";
import { bigText, box, fontsReady, sideways, widthUsed } from "./layoutKit";

/**
 * Review round 6, lane FD2 — buying minutes, in a real browser.
 *
 * <ul>
 *   <li>L6-2 — the purchase status page at 320 px and 200 % text: "Check again" and "Cancel this
 *   purchase" ran past the card's edge and the page scrolled 92 px sideways.</li>
 *   <li>L6-3 — the same page on a desktop was a 36rem column (40 % of a 1280 screen), and it never
 *   said when a purchase left waiting closes by itself.</li>
 *   <li>J6-7 — at a 100 % discount every package read R0.00 and looked buyable; Continue was refused
 *   only after the press.</li>
 *   <li>X6-4 — offline, `/wallet/buy` lost its heading and never said buying needs a connection.</li>
 * </ul>
 */

const SESSION_MEMBER = {
  tenant_slug: "crusaders",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  user_id: "00000000-0000-0000-0000-000000000002",
  is_authenticated: true,
  is_admin: false,
};

const ID = "aaaa1111-0000-0000-0000-00000000006c";
const PENDING = {
  id: ID, status: "Pending", package_id: "p-5", package_name: "5 hours", minutes: 300, list_price_zar: 550, discount_bps: 0,
  amount_zar: 550, failure_code: null, created_at: "2026-10-01T12:05:00Z", expires_at: "2026-10-01T13:05:00Z",
};

async function stubApi(page: Page, routes: Record<string, unknown>) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    for (const [prefix, body] of Object.entries(routes).sort((a, b) => b[0].length - a[0].length)) {
      if (path.startsWith(prefix)) return json(body);
    }
    if (path.startsWith("/api/v1/whoami")) return json(SESSION_MEMBER);
    if (path.startsWith("/api/v1/wallet")) return json({ balance_minutes: 120, entries: [], total_entries: 0, offset: 0, limit: 50 });
    if (path.startsWith("/api/v1/me/profile")) {
      return json({ full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null, membership_number: "P-1" });
    }
    return route.fulfill({ status: 501, contentType: "application/json", body: "{}" });
  });
}

test.describe("the purchase status page (L6-2, L6-3)", () => {
  test.beforeEach(({ page: _page }, info) => { test.skip(info.project.name !== "desktop", "sized explicitly; one project is enough"); });

  test("at 320 px and 200 % text, nothing runs past the card or scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await signIn(page);
    await stubApi(page, { [`/api/v1/minutes/purchase/${ID}`]: PENDING });
    await page.goto(`/wallet/buy/${ID}`);
    await expect(page.getByRole("button", { name: "Cancel this purchase" })).toBeVisible();
    await fontsReady(page);
    await bigText(page);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
    const card = await box(page, "[data-status-card]");
    expect(card).not.toBeNull();
    for (const name of ["Check again", "Cancel this purchase"]) {
      const b = await page.getByRole("button", { name }).boundingBox();
      expect(b, name).not.toBeNull();
      expect(b!.x + b!.width, `${name} inside the card`).toBeLessThanOrEqual(card!.right + 0.5);
    }
  });

  test("on a desktop it uses the width, and says when a waiting purchase closes by itself", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page);
    await stubApi(page, { [`/api/v1/minutes/purchase/${ID}`]: PENDING });
    await page.goto(`/wallet/buy/${ID}`);
    await expect(page.getByText("Waiting for confirmation from PayFast…")).toBeVisible();
    await fontsReady(page);
    // The time it closes by itself, said where the member reads the status — and in the details.
    await expect(page.locator("[data-status-card]")).toContainText(/Closes by itself at \d\d:\d\d/);
    const aside = page.getByRole("complementary", { name: "About this purchase" });
    await expect(aside).toBeVisible();
    await expect(aside).toContainText("5 hours");
    const card = await box(page, "[data-status-card]");
    const rail = await aside.boundingBox();
    expect(rail!.x, "the details stand beside the status, not under it").toBeGreaterThanOrEqual(card!.right);
    expect(await widthUsed(page)).toBeGreaterThanOrEqual(0.6);
  });
});
