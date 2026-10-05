import { type Page } from "@playwright/test";
import { expect, serveApi, signIn, test, type ApiRoute } from "./fixtures";
import { BOOKING, ME, PEOPLE, SAM, detailFixture, memberShellRoutes } from "./playersKit";

/**
 * Review round 16, lane FE16m — measured in Chromium.
 *
 * <ul>
 *   <li><b>X16-5</b> — the wallet's share-group toggle was 240×40 at 390: under the 44px target
 *   floor. Every share toggle is at least 44px tall, at every width.</li>
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
    const box = (await toggle.boundingBox())!;
    expect(box.height, "toggle height").toBeGreaterThanOrEqual(44);
    expect(box.width, "toggle width").toBeGreaterThanOrEqual(44);
  });
}
