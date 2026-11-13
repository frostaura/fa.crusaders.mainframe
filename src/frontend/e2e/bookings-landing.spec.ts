import type { Page } from "@playwright/test";
import { serveApi, signIn, test, expect } from "./fixtures";
import { firstBookInView } from "./layoutKit";
import { memberShellRoutes } from "./playersKit";
import { BOOKINGS_COPY } from "../src/lib/bookingsCopy";

/**
 * Dean, 2026-10: "when a user lands on the page, ensure that the next available slot is at the
 * top of the grid … late in the day the top of the grid scroller has got a bunch of unavailable
 * slots and the user has to scroll all the way to the bottom." The clock is fixed late in the
 * club's day; the member played this morning (so the past rows are NOT folded behind "Earlier
 * today" — the wall Dean saw), and the first rows still to come are full on every court. The
 * grid must open on the first row with a Book cell, one row of context above it.
 */

test.describe.configure({ timeout: 120_000 });
test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

const COURTS = ["a", "b", "c", "d"].map((x, i) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}`,
}));
const DAY = new Date().toISOString().slice(0, 10);
const LATE = Date.parse(`${DAY}T18:40:00Z`);

function slot(court: number, from: string, to: string, extra: Record<string, unknown> = {}) {
  return {
    courtId: COURTS[court].id, courtNumber: court + 1, startsAtUtc: `${DAY}T${from}:00.000Z`, endsAtUtc: `${DAY}T${to}:00.000Z`,
    status: "booked", ownerUserId: null, ownerFirstName: "Sam", ownerPhotoUrl: null, isMine: false, bookingId: `b-${court}-${from}`,
    blockLabel: null, checkedIn: null, ...extra,
  };
}

function lateDay() {
  return {
    date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 6 * 60, dayEndMinute: 22 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS,
    slots: [
      slot(0, "09:00", "10:00", { isMine: true, bookingId: "mine-1", checkedIn: true }),
      // 18:45 and 19:00 are taken everywhere: 19:15 is the first row with a Book cell.
      ...COURTS.map((_, i) => slot(i, "18:45", "19:15")),
    ],
  };
}

async function land(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(LATE);
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/schedule", body: lateDay() },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    ...memberShellRoutes({}),
  ]);
  await page.goto("/bookings");
  await page.waitForSelector('[role="grid"] button[aria-label^="Book "]');
  await page.waitForTimeout(400);
}

/** The first Book cell's distance below the sticky court header, and the row header just above it. */
const placement = (page: Page) => page.locator('[role="grid"] button[aria-label^="Book "]').first().evaluate((cell) => {
  const scroller = cell.closest<HTMLElement>("[data-grid-scroller]")!;
  const header = scroller.querySelector<HTMLElement>("[data-court-col]")!.getBoundingClientRect();
  const r = cell.getBoundingClientRect();
  const above = [...scroller.querySelectorAll<HTMLElement>("[data-time-row]")].find((t) => t.textContent === "19:00")!.getBoundingClientRect();
  return { below: r.top - header.bottom, rowHeight: r.height, label: cell.getAttribute("aria-label"), aboveTop: above.top - header.bottom };
});

for (const [name, width, height] of [["phone", 390, 844], ["desktop", 1280, 800]] as const) {
  test(`${name}: landing late in the day puts the first bookable row at the top of the grid, one row above it`, async ({ page }) => {
    await land(page, width, height);
    const first = await firstBookInView(page);
    expect(first.inScroller && first.onScreen, `first Book cell at y=${Math.round(first.top)}`).toBe(true);
    // The page moves no further than the week it opens at on a phone (useOpenAtWeek, R7) — which
    // has room to act now that the games detail lies under the grid; the grid scrolls itself.
    const opening = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      const week = document.querySelector("[data-day-strip]");
      return week && innerWidth <= 767 ? Math.max(0, week.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop) : 0;
    });
    expect(first.pageScroll, "the page holds still; the grid scrolls itself").toBeLessThanOrEqual(opening + 2);
    expect(first.gridScroll, "the grid opened scrolled past the morning").toBeGreaterThan(0);
    const at = await placement(page);
    expect(at.label).toContain("19:15");
    // One row (3rem + the 4px gap) of context above it — the full 19:00 row, under the header.
    expect(at.below).toBeGreaterThanOrEqual(at.rowHeight);
    expect(at.below).toBeLessThanOrEqual(at.rowHeight + 12);
    expect(at.aboveTop, "the row before is whole, not under the court header").toBeGreaterThanOrEqual(-1);
  });
}

test("a refresh never moves a grid the member has scrolled", async ({ page }) => {
  await land(page, 390, 844);
  const scroller = page.locator("[data-grid-scroller]");
  await scroller.evaluate((el) => { el.scrollTop = 120; });
  await page.getByRole("button", { name: BOOKINGS_COPY.refresh }).first().click();
  await page.waitForTimeout(600);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(120);
});
