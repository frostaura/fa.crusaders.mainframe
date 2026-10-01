import { signIn, test, expect } from "./fixtures";

/**
 * Review round 5, M5-2 (HIGH), in a real browser: back from PayFast twice without paying, the
 * member's whole limit was "topped up" with R0 paid. The page lists the payments still waiting,
 * each with Cancel, and cancelling one frees its amount on the same screen. Measured at a phone
 * and a desktop width (the mobile and desktop projects): nothing scrolls sideways and every Cancel is a full touch target.
 */

const SESSION_MEMBER = {
  tenant_slug: "crusaders",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  user_id: "00000000-0000-0000-0000-000000000002",
  is_authenticated: true,
  is_admin: false,
};

const A = "aaaa0000-0000-0000-0000-0000000000a1";
const B = "bbbb0000-0000-0000-0000-0000000000b2";
const BASE = { block_zar: 100, min_zar: 100, max_zar: 1000, presets_zar: [100, 200, 500, 1000], conversion_rate: 1.6, rate_group: null };
const OPEN = [
  { id: B, amount_zar: 800, created_at: "2026-10-01T12:40:00Z", counts_until: "2026-10-01T13:40:00Z" },
  { id: A, amount_zar: 200, created_at: "2026-10-01T12:05:00Z", counts_until: "2026-10-01T13:05:00Z" },
];

test("open checkouts are listed and one Cancel frees the limit", async ({ page }, info) => {
    const width = page.viewportSize()?.width ?? 0;
    await signIn(page);
    const cancelled = new Set<string>();

    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      const cancel = /\/api\/v1\/credit\/topup\/([^/]+)\/cancel$/.exec(path);
      if (cancel && route.request().method() === "POST") {
        cancelled.add(cancel[1]);
        return json({ id: cancel[1], status: "Cancelled", amount_zar: 200, conversion_rate: 1.6, failure_code: "cancelled_at_return" });
      }
      if (path === "/api/v1/credit/topup/options") {
        const open = OPEN.filter((o) => !cancelled.has(o.id));
        const waiting = open.reduce((sum, o) => sum + o.amount_zar, 0);
        return json({ ...BASE, already_zar: waiting, paid_zar: 0, waiting_zar: waiting, remaining_zar: 1000 - waiting, open_checkouts: open });
      }
      if (path.startsWith("/api/v1/whoami")) return json(SESSION_MEMBER);
      if (path.startsWith("/api/v1/wallet")) return json({ balance_credits: 0, entries: [], total_entries: 0, offset: 0, limit: 50 });
      if (path.startsWith("/api/v1/me/profile")) {
        return json({ full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null, membership_number: "P-1" });
      }
      return route.fulfill({ status: 501, contentType: "application/json", body: "{}" });
    });

    await page.goto("/wallet/topup");
    await expect(page.getByRole("heading", { name: "Payments waiting on PayFast" })).toBeVisible();
    await expect(page.getByText("Your limit is held by payments you haven't finished").first()).toBeVisible();
    await expect(page.getByText(/You've topped up/)).toHaveCount(0);

    const cancels = page.getByRole("button", { name: /^Cancel the R/ });
    await expect(cancels).toHaveCount(2);
    for (const button of await cancels.all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath(`open-${width}.png`), fullPage: true });

    await page.getByRole("button", { name: /^Cancel the R200\.00 payment/ }).click();
    await expect(page.getByText(/Cancelled\. Nothing was charged, and R200\.00 of your limit is free again\./)).toBeVisible();
    await expect(cancels).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Continue to PayFast" })).toBeVisible();
    await expect(page.getByText(/R0\.00 paid, R800\.00 waiting on PayFast, of your R1000\.00/)).toBeVisible();
    await page.screenshot({ path: info.outputPath(`after-${width}.png`), fullPage: true });
});
