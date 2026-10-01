import type { Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";
import { BOOK_SHEET, BOOKINGS_COPY } from "../src/lib/bookingsCopy";

/**
 * Review round 1 on the Bookings screen, where only a browser can tell (F1.14, F1.16, F1.17,
 * F1.19): where keyboard focus lands and whether it is visible, the day strip at twice the text
 * size on a phone, and the Back button with a sheet open.
 */

const COURT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const COURT_B = "aaaaaaaa-0000-4000-8000-00000000000b";
const COURT_C = "aaaaaaaa-0000-4000-8000-00000000000c";

/** The club's today in UTC, the club's zone here. */
const today = () => new Date().toISOString().slice(0, 10);

/** A whole day, midnight to midnight, so "now" is always on it whatever time this runs. */
function wholeDay(date = today()) {
  return {
    date, timezone: "UTC", sliceMinutes: 15,
    dayStartMinute: 0, dayEndMinute: 24 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15,
    courts: [
      { id: COURT_A, courtNumber: 1, name: "Court 1" },
      { id: COURT_B, courtNumber: 2, name: "Court 2" },
      { id: COURT_C, courtNumber: 3, name: "Court 3" },
    ],
    slots: [],
  };
}

async function open(page: Page, options: { isAdmin?: boolean; date?: string } = {}) {
  const { isAdmin = false, date } = options;
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: isAdmin } },
    { path: "/api/v1/schedule", body: wholeDay(date) },
    { path: "/api/v1/admin/members/", body: [] },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [] } },
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
  ]);
  await page.goto(date ? `/bookings?date=${date}` : "/bookings");
  await page.waitForSelector('[role="grid"]');
}

/** The row a focused grid element sits in, as minutes into the day. */
async function focusedRowMinutes(page: Page): Promise<number> {
  return page.evaluate(() => {
    const cell = document.activeElement?.closest<HTMLElement>('[role="gridcell"]');
    const row = cell?.dataset.row;
    const header = row === undefined ? null : document.querySelector<HTMLElement>(`[data-time-row="${row}"]`);
    const [h, m] = (header?.textContent ?? "").split(":").map(Number);
    return h * 60 + m;
  });
}

for (const isAdmin of [false, true]) {
  test(`F1.17 — Tab into the grid lands on the slice it is now, not a past 06:00 (${isAdmin ? "admin" : "member"})`, async ({ page }) => {
    await open(page, { isAdmin });
    await page.locator('[role="grid"] [tabindex="0"]').focus();
    const now = new Date();
    const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const at = await focusedRowMinutes(page);
    // The first slice that has not started — at most one slice ahead of now, never behind it.
    expect(at).toBeGreaterThan(nowMinutes - 15);
    expect(at).toBeLessThanOrEqual(nowMinutes + 15);
  });
}

test("F1.14 — a cell reached by keyboard is never under the sticky header, time column or the bars", async ({ page }) => {
  // Fifty-odd key presses, each measured.
  test.setTimeout(120_000);
  await open(page, { isAdmin: true, date: (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })() });
  await page.getByRole("button", { name: BOOKINGS_COPY.selectOn }).click();
  await page.locator('[role="grid"] [tabindex="0"]').focus();
  const check = async () => page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const r = el.getBoundingClientRect();
    const head = document.querySelector<HTMLElement>("[data-court-col]")!.getBoundingClientRect();
    const time = document.querySelector<HTMLElement>("[data-time-row]")!.getBoundingClientRect();
    const scroller = document.querySelector<HTMLElement>("[data-grid-scroller]")!.getBoundingClientRect();
    const bars = [...document.querySelectorAll<HTMLElement>('[role="toolbar"], nav')]
      .map((b) => b.getBoundingClientRect())
      .filter((b) => b.height > 0 && b.top > window.innerHeight / 2);
    const floor = Math.min(window.innerHeight, scroller.bottom, ...bars.map((b) => b.top));
    const ok = { top: r.top >= head.bottom - 1, left: r.left >= time.right - 1, bottom: r.bottom <= floor + 1 };
    if (!ok.top || !ok.left || !ok.bottom) {
      return JSON.stringify({ r: [r.top, r.bottom, r.left], head: head.bottom, time: time.right, scroller: [scroller.top, scroller.bottom], bars: bars.map((b) => [b.top, b.height]), vh: window.innerHeight, sy: window.scrollY, st: document.querySelector<HTMLElement>("[data-grid-scroller]")!.scrollTop, el: el.tagName + (el.getAttribute("aria-label") ?? "") });
    }
    return ok;
  });
  for (let i = 0; i < 24; i += 1) {
    await page.keyboard.press("ArrowDown");
    expect(await check(), `after ${i + 1} × ArrowDown`).toEqual({ top: true, left: true, bottom: true });
  }
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("ArrowRight");
    expect(await check(), `after ${i + 1} × ArrowRight`).toEqual({ top: true, left: true, bottom: true });
  }
  for (let i = 0; i < 24; i += 1) {
    await page.keyboard.press("ArrowUp");
    expect(await check(), `after ${i + 1} × ArrowUp`).toEqual({ top: true, left: true, bottom: true });
  }
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("ArrowLeft");
    expect(await check(), `after ${i + 1} × ArrowLeft`).toEqual({ top: true, left: true, bottom: true });
  }
});

test("F1.16 — at 200% text on a 390px phone the day strip keeps its chips apart and its labels whole", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "32px"; });
  });
  await open(page);
  const strip = await page.evaluate(() => {
    const chips = [...document.querySelectorAll<HTMLElement>("[data-week-strip] [data-date]")].map((c) => c.getBoundingClientRect());
    // Only chips on one row can overlap: the strip wraps a row rather than squeeze seven into it.
    const overlaps = chips.slice(1).filter((c, i) => Math.abs(c.top - chips[i].top) < 1 && c.left < chips[i].right - 0.5).length;
    const month = document.querySelector<HTMLElement>("[data-week-strip] [data-month]")!;
    const h1 = document.querySelector<HTMLElement>("h1")!;
    const words = (el: HTMLElement) => {
      // A word broken across lines: two client rects for one text node's single word.
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getClientRects().length;
    };
    return {
      overlaps,
      monthClipped: month.scrollWidth > month.clientWidth + 1,
      h1Lines: words(h1),
      chipsFit: chips.every((c) => c.right <= window.innerWidth + 1),
    };
  });
  expect(strip.overlaps, "chips overlapping").toBe(0);
  expect(strip.chipsFit, "chips past the edge").toBe(true);
  expect(strip.monthClipped, "month caption clipped").toBe(false);
  expect(strip.h1Lines, "'Bookings' broken across lines").toBe(1);
  // The date button keeps its name at any size.
  await expect(page.getByRole("button", { name: new RegExp(`^${BOOKINGS_COPY.jumpToDate}`) })).toBeVisible();
});

test("F1.19 — Back with the Book sheet open closes the sheet and stays on Bookings", async ({ page }) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  const date = d.toISOString().slice(0, 10);
  await open(page, { date });
  await page.getByRole("button", { name: /^Book Court 1 at 12:00/ }).click();
  await expect(page.getByRole("dialog", { name: BOOK_SHEET.title(1) })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/bookings\\?date=${date}`));
  await expect(page.getByRole("heading", { name: BOOKINGS_COPY.title, level: 1 })).toBeVisible();
  // …and Back again leaves, as it would have without the sheet.
});
