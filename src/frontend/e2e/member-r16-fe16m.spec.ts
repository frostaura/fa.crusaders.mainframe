import { type Page } from "@playwright/test";
import { expect, serveApi, signIn, test, type ApiRoute } from "./fixtures";
import { BOOKING, ME, PEOPLE, SAM, detailFixture, memberShellRoutes } from "./playersKit";

/**
 * Review round 16, lane FE16m — measured in Chromium.
 *
 * <ul>
 *   <li><b>X16-5</b> — the wallet's share-group toggle measured 240×40 at 390 (20px tall at 1280) —
 *   its text box. Its target is its row (stretched over it since R4 V4-10, deliberately with no
 *   floor of its own so its words sit on the row's baseline): measured where a tap lands.</li>
 * </ul>
 */

test.describe.configure({ timeout: 120_000 });

function ledgerRow(id: string, over: Record<string, unknown>) {
  return {
    id, at: new Date().toISOString(), from: "Club treasury", to: PEOPLE.me.name, amountMinutes: 25, signedAmountMinutes: 25,
    type: "ShareTransfer", comment: "Share of a split booking", subjectUserId: ME, subjectName: PEOPLE.me.name,
    actorUserId: SAM, actorName: PEOPLE.sam.name, relatedBookingId: BOOKING, ...over,
  };
}

function walletRoutes(): ApiRoute[] {
  const d = detailFixture();
  const organiser = d.organiser as { user_id: string; name: string; photo_url: string | null };
  const entries = [ledgerRow("s-sam", {})];
  return [
    { path: `/api/v1/bookings/${BOOKING}`, body: d },
    ...memberShellRoutes({ wallet: {
      entries, total_entries: entries.length,
      share_bookings: { [BOOKING]: { booking_id: d.booking_id, court_name: d.court_name, starts_at: d.starts_at, organiser, partners: [{ user_id: SAM, name: PEOPLE.sam.name, paid_minutes: 25 }] } },
    } }),
  ];
}

async function large(page: Page, root: number) {
  if (root !== 16) await page.addStyleTag({ content: `html { font-size: ${root}px; }` });
  await page.evaluate(() => document.fonts.ready);
}

for (const [width, root] of [[320, 16], [390, 16], [390, 32], [1280, 16]] as const) {
  test(`X16-5 — the share-group toggle is a 44px target at ${width} / ${root * 100 / 16} %`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await serveApi(page, walletRoutes());
    await page.goto("/wallet", { timeout: 90_000 });
    await large(page, root);
    const toggle = page.locator("[data-share-toggle]").first();
    await expect(toggle).toBeVisible();
    // The disclosure is stretched over its whole row (`after:absolute after:inset-0`, R4 V4-10), so
    // its TARGET is where a tap lands on it, not the button's text box. Measured as a finger finds
    // it: down a line through the row's middle, the longest run of points that hit the toggle.
    await toggle.scrollIntoViewIfNeeded();
    const m = await toggle.evaluate((button) => {
      const row = button.closest("tr")!.getBoundingClientRect();
      const x = row.left + row.width / 2;
      let run = 0;
      let best = 0;
      for (let y = Math.max(0, row.top); y < Math.min(window.innerHeight, row.bottom); y += 1) {
        const el = document.elementFromPoint(x, y);
        run = el !== null && (el === button || button.contains(el)) ? run + 1 : 0;
        best = Math.max(best, run);
      }
      return { row: row.height, text: button.getBoundingClientRect().height, best };
    });
    console.log(`X16-5 ${width}/${root}: row ${m.row.toFixed(0)}, text box ${m.text.toFixed(0)}, tap run ${m.best}`);
    expect(m.best, "a 44px run of the row taps the toggle").toBeGreaterThanOrEqual(44);
  });
}
