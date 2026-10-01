import type { Page } from "@playwright/test";
import { signIn, serveApi, test, expect } from "./fixtures";
import { BOOKING, detailFixture, memberShellRoutes } from "./playersKit";
import { DETAIL_COPY, DETAIL_NO_SHOW, DETAIL_PLAYER } from "../src/lib/playersCopy";
import { HEIGHT, bigText, fontsReady, sideways, textOffScreen } from "./layoutKit";

/**
 * Review round 5, lane D1, measured in Chromium: the invitee's answer docked in thumb reach on a
 * phone (F5), and no figure on the booking page broken across two lines at 390 with 200 % text
 * (V5-7) — on a no-show's own money view (M5-3), the busiest of them.
 */

const ME = "p0000000-0000-0000-0000-000000000003";

async function open(page: Page, body: Record<string, unknown>) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: HEIGHT[390] });
  await signIn(page);
  await serveApi(page, [{ path: `/api/v1/bookings/${BOOKING}`, body }, ...memberShellRoutes()]);
  await page.goto(`/bookings/${BOOKING}`);
  await fontsReady(page);
  await expect(page.locator("[data-players-section]")).toBeVisible();
}

/** Every money figure (`dd`) and every line holding one sits on ONE line. */
async function brokenFigures(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const dd of document.querySelectorAll<HTMLElement>("[data-money-panel] dd, main dd")) {
      const rects = Array.from(dd.getClientRects());
      const range = document.createRange();
      range.selectNodeContents(dd);
      const lines = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top)));
      if (lines.size > 1 || rects.length === 0) out.push(dd.textContent ?? "");
    }
    return out;
  });
}

const inviteeView = () => detailFixture({
  viewer: { role: "player", participant_id: ME },
  permissions: {
    can_invite: false, can_change_split: false, can_cancel: false, can_accept: true, can_decline: true,
    can_withdraw: false, withdraw_closes_at: new Date(Date.now() + 3_600_000).toISOString(),
  },
});

test("F5: an invitee's Review and Decline are docked in thumb reach on a phone, once each", async ({ page }) => {
  await open(page, inviteeView());
  const bar = page.getByRole("region", { name: DETAIL_COPY.answerLabel });
  await expect(bar).toBeVisible();
  const review = bar.getByRole("link", { name: DETAIL_PLAYER.review });
  const b = (await review.boundingBox())!;
  expect(b.y + b.height, "in thumb reach").toBeGreaterThan(HEIGHT[390] * 0.75);
  expect(b.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("button", { name: DETAIL_PLAYER.decline })).toHaveCount(1);
});

test("V5-7 / M5-3: a no-show at 390 with 200 % text: every figure on one line, nothing off screen", async ({ page }) => {
  const d = detailFixture() as Record<string, unknown> & { players: Record<string, unknown>[] };
  const partner = (n: number) => ({ ...d.players[1], seat: n, participant_id: `p0000000-0000-0000-0000-00000000000${n}`,
    share_minutes: 16, consented_minutes: 16, paid_minutes: 4.8, target_minutes: 4.8, returned_minutes: 11.2, unpaid_minutes: 0, status: "accepted" });
  await open(page, {
    ...d, status: "no_show",
    players: [d.players[0], partner(2), { ...partner(3), team: "B" }],
    money: { price_minutes: 100, organiser_owed_minutes: 30, shares_received_minutes: 9.6, organiser_net_minutes: 20.4, unpaid_minutes: 0, share_deadline: d.starts_at, is_split: true },
    permissions: { ...(d.permissions as object), can_invite: false, can_change_split: false, can_cancel: false },
  });
  await expect(page.getByText(DETAIL_NO_SHOW.moneyNote(true))).toBeVisible();
  await bigText(page);
  expect(await sideways(page), "nothing scrolls sideways").toBeLessThanOrEqual(0);
  expect(await textOffScreen(page), "no text paints off screen").toEqual([]);
  expect(await brokenFigures(page), "no figure broken across lines").toEqual([]);
});
