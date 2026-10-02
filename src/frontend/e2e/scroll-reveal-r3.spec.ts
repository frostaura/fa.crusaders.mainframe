import { serveApi, signIn, test, expect } from "./fixtures";
import { memberShellRoutes } from "./playersKit";

/**
 * X-8 (review round 3) — a control focused by the keyboard inside a sideways-scrolling row is
 * scrolled into view.
 *
 * <p>
 * Found on a 390 px phone: Tab onto the Wallet Activity table's "Refunds (net)" sort header left
 * it past the table's right edge — the focus ring off-screen, the name unread. The header is
 * `position: sticky` (it stays at the top of a tall table), and Chromium does not scroll a sticky
 * box into view on focus. `DataTable`'s headers now reveal themselves in their scroller.
 * </p>
 */

const DAYS = Array.from({ length: 6 }, (_, i) => ({
  date: `2026-09-${String(20 + i).padStart(2, "0")}`,
  top_ups_minutes: 100, spent_minutes: 40, refunds_minutes: 10, bookings: 1, attended: 1, minutes_on_court: 45, balance_minutes: 500 + i,
}));

const WALLET_REPORT = {
  from: "2026-09-01", to: "2026-09-30", top_ups_minutes: 600, spent_minutes: 240, refunds_minutes: 60, penalties_minutes: 0,
  adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: 420, penalty_count: 0, attended_bookings: 6, minutes_on_court: 270, count: 18,
};

test("a sort header reached by Tab is scrolled into its table's view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/reports/me/wallet", body: WALLET_REPORT },
    { path: "/api/v1/reports/me/daily", body: DAYS },
    ...memberShellRoutes(),
  ]);
  await page.goto("/wallet/activity");
  const first = page.getByRole("button", { name: /^Date/ });
  await expect(first).toBeVisible();
  const scroller = page.locator("[data-slot='table-container']").filter({ has: first });
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth), "the table is wider than the phone").toBe(true);

  await first.focus();
  for (const name of [/^Bought/, /^Spent/, /^Refunds \(net\)/, /^Bookings/, /^Balance/]) {
    await page.keyboard.press("Tab");
    const header = page.getByRole("button", { name });
    await expect(header).toBeFocused();
    await page.waitForTimeout(100);
    const m = await header.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const s = el.closest("[data-slot='table-container']")!.getBoundingClientRect();
      return { left: box.left, right: box.right, sLeft: s.left, sRight: s.right };
    });
    expect(m.left, `${name} starts inside the table`).toBeGreaterThanOrEqual(m.sLeft - 1);
    expect(m.right, `${name} ends inside the table`).toBeLessThanOrEqual(m.sRight + 1);
  }
  // And back again: Shift+Tab to the first header brings the table's start back into view.
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+Tab");
  await expect(first).toBeFocused();
  await page.waitForTimeout(100);
  const back = await first.evaluate((el) => el.getBoundingClientRect().left - el.closest("[data-slot='table-container']")!.getBoundingClientRect().left);
  expect(back, "Date starts inside the table").toBeGreaterThanOrEqual(-1);
});
