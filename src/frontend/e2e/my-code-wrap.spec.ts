import { SESSION_ADMIN, serveApi, signIn, test, expect, memberCodeRoutes } from "./fixtures";

/**
 * The code's digits are not drawn (Dean, 2026-10-06): a scanner reads the symbol and nobody types
 * the code. Retires F4-16's balanced-wrap check, which measured digits that are no longer shown.
 * The code stays in the accessible text, and the symbol is what fills the pass.
 */
const TZ = "Africa/Johannesburg";

for (const width of [390, 768]) {
  test(`only the symbol is drawn at ${width} px`, async ({ page }) => {
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
    await expect(code).toBeAttached();
    expect(await code.getAttribute("aria-label")).toBeTruthy();
    const box = await code.boundingBox();
    expect(box === null || (box.width <= 1 && box.height <= 1), JSON.stringify(box)).toBe(true);
    await expect(page.locator("[data-qr-panel]")).toBeVisible();
  });
}
