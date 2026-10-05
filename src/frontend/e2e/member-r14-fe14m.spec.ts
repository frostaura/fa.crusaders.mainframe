import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect } from "./fixtures";
import { ME, PEOPLE, memberShellRoutes } from "./playersKit";
import { showOlderLabel } from "../src/lib/walletCopy";
import { CONNECTION_COPY } from "../src/lib/shellCopy";

/**
 * Review round 14, lane FE14m — in a real engine, on both projects (Pixel 7 and desktop Chrome):
 * X14-1: the wallet's last "Show older" hands focus to the first movement it brought, never <body>.
 * X14-3: a page that keeps nothing on the phone, opened cold with the phone offline, says
 *        "You're offline" — not "Can't reach the club".
 */

test.describe.configure({ timeout: 120_000 });

function row(i: number) {
  return {
    id: `w${i}`, at: new Date(Date.UTC(2026, 9, 4, 18, 0) - i * 3_600_000).toISOString(),
    from: "The club", to: PEOPLE.me.name, amountMinutes: 30, signedAmountMinutes: 30, type: "AdminAdjustment",
    comment: `Desk adjustment ${i}`, subjectUserId: ME, subjectName: PEOPLE.me.name,
    actorUserId: ME, actorName: PEOPLE.me.name, relatedBookingId: null,
  };
}

/** The wallet as the club pages it: `limit` rows of `total`, newest first. */
async function pagedWallet(page: Page, total: number) {
  const rows = Array.from({ length: total }, (_, i) => row(i));
  await page.route("**/api/v1/wallet?**", async (route) => {
    const limit = Number(new URL(route.request().url()).searchParams.get("limit") ?? "100");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ balance_minutes: 120, held_minutes: 0, spendable_minutes: 120, held_until: null, entries: rows.slice(0, limit), total_entries: total, offset: 0, limit, share_bookings: {} }),
    });
  });
}

for (const older of [1, 2]) {
  test(`X14-1 — the last Show older (${older} more) focuses the first movement it brought`, async ({ page }) => {
    await signIn(page);
    await page.addInitScript(() => { try { localStorage.setItem("crusaders.tour.dismissed", "1"); } catch { /* none */ } });
    await serveApi(page, memberShellRoutes());
    await pagedWallet(page, 100 + older);
    await page.goto("/wallet");
    const button = page.getByRole("button", { name: showOlderLabel(older) });
    await button.scrollIntoViewIfNeeded();
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-ledger-row") ?? document.activeElement?.tagName)).toBe("w100");
    // Keyboard order carries on from there: Shift+Tab reaches the ledger above the row, not <body>
    // and not the skip link (the last row is the page's end on a wide screen, so Tab may wrap).
    await page.keyboard.press("Shift+Tab");
    const back = await page.evaluate(() => {
      const a = document.activeElement;
      return { body: a === document.body, inLedger: Boolean(a?.closest("[data-ledger-box]")), text: a?.textContent ?? "" };
    });
    expect(back.body).toBe(false);
    expect(back.text).not.toMatch(/Skip to/i);
    expect(back.inLedger).toBe(true);
  });
}

for (const path of ["/profile/results", "/wallet/buy/p0000000-0000-0000-0000-000000000001"]) {
  test(`X14-3 — ${path} opened cold with the phone offline says "You're offline"`, async ({ page }) => {
    await signIn(page);
    await page.addInitScript((me) => {
      localStorage.setItem("crusaders.mainframe.last-identity", me);
      Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => false });
    }, ME);
    // The club cannot be reached: every API call fails at the network.
    await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
    await page.goto(path);
    await expect(page.getByRole("heading", { name: CONNECTION_COPY.offlineTitle })).toBeVisible();
    await expect(page.getByText(CONNECTION_COPY.offlineBody)).toBeVisible();
    await expect(page.getByText(CONNECTION_COPY.unreachableTitle)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), "sideways scroll").toBe(false);
  });
}
