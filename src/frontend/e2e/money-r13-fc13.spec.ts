import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKING, ME, PEOPLE, SAM, detailFixture, memberShellRoutes } from "./playersKit";
import { DETAIL_CANCELLED } from "../src/lib/playersCopy";
import { BOOKINGS_COPY, BOOKING_FOR } from "../src/lib/bookingsCopy";
import { SHARE_LEDGER_COPY } from "../src/lib/walletCopy";

/**
 * Review round 13, lane FC13 — in a real engine, at 320 and 390 px, 100 % and 200 % text:
 * J13-6: a cancelled game's banner says who cancelled it and the club's reason, wrapping inside.
 * J13-3: a share line for a game the member is no longer on has no "View booking".
 * J13-1: booking FOR a member below zero, the rail says "0 minutes" and how far under — no minus.
 */

test.describe.configure({ timeout: 120_000 });
test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "sizes are set per test"); });

async function open(page: Page, path: string, size: { width: number; height: number }, big: boolean, routes: ApiRoute[]) {
  await page.setViewportSize(size);
  await signIn(page);
  await serveApi(page, routes);
  if (big) {
    await page.addInitScript(() => {
      const add = () => { const s = document.createElement("style"); s.textContent = "html { font-size: 32px; }"; document.documentElement.appendChild(s); };
      if (document.documentElement) add(); else addEventListener("DOMContentLoaded", add);
    });
  }
  await page.goto(path);
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);

const CLOSED = {
  can_invite: false, can_change_split: false, can_cancel: false, can_accept: false, can_decline: false,
  can_withdraw: false, withdraw_closes_at: new Date().toISOString(),
};

for (const [width, big] of [[320, true], [390, true], [390, false]] as const) {
  const tag = `${width}${big ? " / 200 %" : ""}`;

  test(`J13-6 — ${tag}: the club's cancel says so, with its reason, inside the page`, async ({ page }, info) => {
    const reason = "Court resurfacing after the leak in the roof";
    await open(page, `/bookings/${BOOKING}`, { width, height: 760 }, big, [
      { path: `/api/v1/bookings/${BOOKING}/result`, status: 404, body: { error: "not_found" } },
      { path: `/api/v1/bookings/${BOOKING}`, body: detailFixture({
        status: "cancelled", permissions: CLOSED,
        viewer: { role: "player", participant_id: "p0000000-0000-0000-0000-000000000002" }, organiser: PEOPLE.sam,
        cancelled_by: "club", cancel_cause: null, cancel_reason: reason,
      }) },
      ...memberShellRoutes(),
    ]);
    const banner = page.locator("[data-cancelled]");
    await expect(banner).toContainText(DETAIL_CANCELLED.byClub);
    await expect(banner).toContainText(DETAIL_CANCELLED.reason(reason));
    await expect(banner).not.toContainText(DETAIL_CANCELLED.banner);
    const box = await banner.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
    expect(await sideways(page), "something scrolls sideways").toBe(false);
    await banner.screenshot({ path: info.outputPath(`cancelled-banner-${width}${big ? "x2" : ""}.png`) });
  });

  test(`J13-6 — ${tag}: a displaced game says why`, async ({ page }) => {
    await open(page, `/bookings/${BOOKING}`, { width, height: 760 }, big, [
      { path: `/api/v1/bookings/${BOOKING}/result`, status: 404, body: { error: "not_found" } },
      { path: `/api/v1/bookings/${BOOKING}`, body: detailFixture({ status: "cancelled", permissions: CLOSED, cancelled_by: "club", cancel_cause: "displaced", cancel_reason: null }) },
      ...memberShellRoutes(),
    ]);
    await expect(page.locator("[data-cancelled]")).toContainText(DETAIL_CANCELLED.displaced);
    expect(await sideways(page)).toBe(false);
  });
}

function shareRow(id: string, signed: number, booking: string) {
  return {
    id, at: new Date().toISOString(), from: signed < 0 ? PEOPLE.me.name : PEOPLE.sam.name, to: signed < 0 ? PEOPLE.sam.name : PEOPLE.me.name,
    amountMinutes: Math.abs(signed), signedAmountMinutes: signed, type: "ShareTransfer", comment: "Share of a split booking",
    subjectUserId: ME, subjectName: PEOPLE.me.name, actorUserId: SAM, actorName: PEOPLE.sam.name, relatedBookingId: booking,
  };
}

test("J13-3 — 390: the share line of a game the member was taken off has no View booking; one still on keeps it", async ({ page }, info) => {
  const ON = "b0000000-0000-0000-0000-0000000000a2";
  const entries = [shareRow("gone-out", -7, BOOKING), shareRow("gone-back", 7, BOOKING), shareRow("on-out", -7, ON)];
  await open(page, "/wallet", { width: 390, height: 844 }, false, memberShellRoutes({ wallet: {
    entries, total_entries: entries.length,
    share_bookings: {
      [BOOKING]: null,
      [ON]: { booking_id: ON, court_name: "Court 4", starts_at: new Date(Date.now() + 86_400_000).toISOString(), organiser: PEOPLE.sam, partners: [{ user_id: ME, name: PEOPLE.me.name, paid_minutes: 7 }] },
    },
  } }));
  await expect(page.getByRole("button", { name: /paid and returned/ })).toBeVisible();
  const links = page.getByRole("link", { name: new RegExp(`^${SHARE_LEDGER_COPY.viewBooking}`) });
  await expect(links).toHaveCount(1);
  await expect(links.first()).toHaveAttribute("href", `/bookings/${ON}`);
  await page.locator("[data-share-group]").first().screenshot({ path: info.outputPath("gone-share-line-390.png") });
});

const MEMBER = "99999999-0000-4000-8000-000000000001";
const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = inDays(2);

// The rail stands beside the grid from a 72rem page (SPEC 3.1) — never at 200 % text on these screens.
for (const [width, height, big] of [[1280, 900, false], [1440, 900, false], [1920, 1080, false]] as const) {
  test(`J13-1 — ${width}${big ? " / 200 %" : ""}: the rail's member wallet below zero says what the bar says`, async ({ page }, info) => {
    const courts = ["a", "b"].map((x, i) => ({ id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}` }));
    await open(page, `/bookings?as=${MEMBER}&date=${DAY}`, { width, height }, big, [
      { path: "/api/v1/schedule", body: { date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 480, dayEndMinute: 1200, advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts, slots: [] } },
      { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [] } },
      { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
      { path: `/api/v1/admin/members/${MEMBER}/booking-rules`, body: { day: DAY, groups: [], allowed_windows: null, empty_window_groups: null } },
      { path: `/api/v1/admin/members/${MEMBER}`, body: { full_name: "Naledi Dlamini", balance_minutes: 3, held_minutes: 15 } },
      ...memberShellRoutes({ admin: true }),
    ]);
    const bar = page.locator("[data-booking-for]");
    await expect(bar).toContainText(BOOKING_FOR.canSpend(-12));
    const rail = page.getByRole("group", { name: BOOKINGS_COPY.summaryTheirTitle("Naledi") });
    await expect(rail).toContainText(BOOKINGS_COPY.summaryBelowZero(12));
    await expect(rail).toContainText("0 min");
    expect(await rail.textContent()).not.toMatch(/−|minus/);
    expect(await sideways(page)).toBe(false);
    await rail.screenshot({ path: info.outputPath(`rail-below-zero-${width}${big ? "x2" : ""}.png`) });
  });
}
