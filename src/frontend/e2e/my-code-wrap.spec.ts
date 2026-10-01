import { SESSION_ADMIN, serveApi, signIn, test, expect, memberCodeRoutes } from "./fixtures";

/**
 * F4-16 (review round 2, VIS-L) — the code's groups wrap BALANCED. At 390 and 768 the flex-wrap
 * row filled its first line and left the last two groups ("661 592") alone on the second. Measured
 * as the width of each line of groups: when the code takes two lines, neither is more than one
 * group's width longer than the other.
 */
const TZ = "Africa/Johannesburg";

for (const width of [390, 768]) {
  test(`the code's groups wrap balanced at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await serveApi(page, [
      { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: false } },
      { path: "/api/v1/me/profile", body: { full_name: "Lerato Mokoena", email: "lerato@sample.local", photo_url: null, membership_number: "M-0001" } },
      { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
      ...memberCodeRoutes(),
      {
        path: "/api/v1/me/door",
        body: {
          doors: true, doors_shut: "none", timezone: TZ, policy: "booking_window",
          membership: "active", membership_detail: "active", is_club_admin: false, next_booking: null,
          early_entry_minutes: 30, roster_max_entries: 48,
          contact: { phone: "021 555 0134", email: "info@crusaders.co.za" },
          door_log_retention_days: 90, last_decision: null,
        },
      },
      { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null, retention_days: 90, timezone: TZ } },
    ]);
    await page.goto("/my-code");
    const code = page.locator("[data-member-code]");
    await expect(code).toBeVisible();

    const lines = await code.evaluate((el) => {
      const byTop = new Map<number, number>();
      let widest = 0;
      for (const g of el.querySelectorAll<HTMLElement>(":scope > span > span")) {
        const r = g.getBoundingClientRect();
        const top = Math.round(r.top);
        byTop.set(top, (byTop.get(top) ?? 0) + r.width);
        widest = Math.max(widest, r.width);
      }
      return { widths: [...byTop.values()], widest };
    });
    // The pass is narrow enough on both widths that the code takes two lines — the case at issue.
    expect(lines.widths.length, `line widths ${lines.widths.join(" / ")}`).toBe(2);
    {
      const spread = Math.max(...lines.widths) - Math.min(...lines.widths);
      expect(spread, `line widths ${lines.widths.join(" / ")}`).toBeLessThanOrEqual(lines.widest);
    }
  });
}
