import type { Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute, singleTap } from "./fixtures";
import { BOOKINGS_COPY, BOOK_SHEET, CANCEL_SHEET, UPCOMING } from "../src/lib/bookingsCopy";

/**
 * Review round 3 on the Bookings screen, where only a browser can tell (lane F1): an open
 * invite-link seat on the upcoming card at 320, the week strip's width at 1280, where focus goes
 * when a sheet closes over a re-drawn cell, the date picker's first focus, and a court chip
 * reached by Tab.
 */

const COURTS = ["a", "b", "c", "d"].map((x, i) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}`,
}));

const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = inDays(2);

function wholeDay(slots: unknown[] = []) {
  return {
    date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 0, dayEndMinute: 24 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots,
  };
}

function mySlot() {
  return {
    courtId: COURTS[0].id, courtNumber: 1, startsAtUtc: `${DAY}T12:00:00.000Z`, endsAtUtc: `${DAY}T12:15:00.000Z`,
    status: "booked", ownerUserId: SESSION_ADMIN.user_id, ownerFirstName: "Dean", ownerPhotoUrl: null, isMine: true,
    bookingId: "bbbbbbbb-0000-4000-8000-000000000001", blockLabel: null, checkedIn: false, amountChargedMinutes: 50,
  };
}

function openSeatGame() {
  return {
    booking_id: "bbbbbbbb-0000-4000-8000-000000000009", court_name: "Court 2", starts_at: `${DAY}T10:30:00Z`,
    ends_at: `${DAY}T11:00:00Z`, role: "organiser", status: "booked",
    players: [
      { name: "Valerie Vermaak", photo_url: null, status: "accepted" },
      { name: "Vincent Venter", photo_url: null, status: "invited" },
      { name: null, photo_url: null, status: "invited" },
    ],
    my_share_minutes: 67, needs_action: false,
  };
}

async function open(page: Page, options: { routes?: ApiRoute[]; upcoming?: unknown[] } = {}) {
  await signIn(page);
  await serveApi(page, [
    ...(options.routes ?? []),
    { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: false } },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: options.upcoming ?? [] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
  ].filter((r, i, all) => all.findIndex((o) => o.path === r.path && (o.method ?? "GET") === (r.method ?? "GET")) === i));
  await page.goto(`/bookings?date=${DAY}`);
  await singleTap(page);
  await page.waitForSelector('[role="grid"]');
}

/** What holds focus, as a sentence a failure can be read by. */
function focused(page: Page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName ?? "", label: a?.getAttribute("aria-label") ?? "", inGrid: Boolean(a?.closest('[role="grid"]')) };
  });
}

test("V-1 / V-9 — a game with an open invite-link seat draws at 320, with no dangling separator", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, { routes: [{ path: "/api/v1/schedule", body: wholeDay() }], upcoming: [openSeatGame()] });
  const card = page.locator("[data-upcoming] a").first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Valerie");
  await expect(card).not.toContainText("Vincent");
  await expect(card).toContainText(UPCOMING.share(67));
  expect(errors).toEqual([]);
  // No line of the card starts with the separator.
  const starts = await card.evaluate((el) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent ?? "";
      const range = document.createRange();
      for (let i = 0; i < t.length; i++) {
        if (t[i] !== "·") continue;
        range.setStart(n, i); range.setEnd(n, i + 1);
        const dot = range.getBoundingClientRect();
        range.setStart(n, Math.max(0, i - 2)); range.setEnd(n, Math.max(1, i - 1));
        const before = range.getBoundingClientRect();
        if (Math.round(before.top) !== Math.round(dot.top)) out.push(t);
      }
    }
    return out;
  });
  expect(starts, "a separator starts a line").toEqual([]);
});

test("V-12 — at 1280 the week strip spans the grid's width", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { routes: [{ path: "/api/v1/schedule", body: wholeDay() }] });
  const widths = await page.evaluate(() => {
    const strip = document.querySelector("[data-week-strip]")!.getBoundingClientRect();
    const grid = document.querySelector("[data-grid-scroller]")!.parentElement!.getBoundingClientRect();
    return { strip: strip.right - strip.left, grid: grid.right - grid.left };
  });
  // The facts column may keep up to 20rem of its own beside it; never the half-width strip.
  expect(widths.strip, JSON.stringify(widths)).toBeGreaterThan(widths.grid * 0.7);
});

test.describe("X-6 — a sheet closing over a re-drawn cell gives focus back to that cell", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  function bookingRoutes(): ApiRoute[] {
    let booked = false;
    return [
      { path: "/api/v1/schedule", respond: () => wholeDay(booked ? [mySlot()] : []) },
      { method: "POST", path: "/api/v1/bookings/", respond: () => { booked = true; return { booking_id: mySlot().bookingId, balance_after_minutes: 450 }; } },
    ];
  }

  for (const how of ["Done", "Escape"] as const) {
    test(`after booking, ${how} lands on the booked cell, not <main>`, async ({ page }) => {
      await open(page, { routes: bookingRoutes() });
      await page.getByRole("button", { name: /^Book Court 1 at 12:00/ }).click();
      const sheet = page.getByRole("dialog", { name: BOOK_SHEET.title(1) });
      await sheet.getByRole("button", { name: BOOK_SHEET.next }).click();
      // The sheet ignores a press in the first moments of a new step (a double tap is not a booking).
      await page.waitForTimeout(400);
      await sheet.getByRole("button", { name: BOOK_SHEET.primary(1, 15, null) }).click();
      await expect(sheet.getByRole("button", { name: BOOK_SHEET.done })).toBeVisible();
      if (how === "Done") await sheet.getByRole("button", { name: BOOK_SHEET.done }).click();
      else await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect.poll(() => focused(page)).toMatchObject({ inGrid: true, label: expect.stringMatching(/Court 1 at 12:00/) });
    });
  }

  test("after cancelling from the cell, focus lands on the freed slot", async ({ page }) => {
    let cancelled = false;
    await open(page, {
      routes: [
        { path: "/api/v1/schedule", respond: () => wholeDay(cancelled ? [] : [mySlot()]) },
        { path: `/api/v1/bookings/${mySlot().bookingId}/cancellation-quote`, body: {
          bookingId: mySlot().bookingId, amountChargedMinutes: 50, refundMinutes: 50, penaltyMinutes: 0, penaltyPct: 30,
          penaltyWindowMinutes: 15, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false,
        } },
        { method: "POST", path: `/api/v1/bookings/${mySlot().bookingId}/cancel`, respond: () => { cancelled = true; return { refunded_minutes: 50, penalty_minutes: 0 }; } },
      ],
    });
    await page.getByRole("button", { name: /Cancel your booking on Court 1 at 12:00/ }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: CANCEL_SHEET.confirm(1) }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => focused(page)).toMatchObject({ inGrid: true, label: expect.stringMatching(/^Book Court 1 at 12:00/) });
  });
});

for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  test(`X-7 — Jump to a date opens on the chosen day at ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page, { routes: [{ path: "/api/v1/schedule", body: wholeDay() }] });
    await page.getByRole("button", { name: new RegExp(`^${BOOKINGS_COPY.jumpToDate}`) }).click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-day") ?? "")).toBe(DAY);
  });
}

test("X-8 — a court chip reached by Tab is scrolled into view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, { routes: [{ path: "/api/v1/schedule", body: wholeDay() }] });
  const chips = page.getByRole("group", { name: BOOKINGS_COPY.courtChips });
  await chips.getByRole("button").first().focus();
  for (let i = 1; i < COURTS.length; i++) await page.keyboard.press("Tab");
  const box = await page.evaluate(() => {
    const a = document.activeElement!.getBoundingClientRect();
    return { left: a.left, right: a.right, vw: window.innerWidth, label: document.activeElement!.getAttribute("aria-label") };
  });
  expect(box.label).toMatch(/Court 4/);
  expect(box.right, JSON.stringify(box)).toBeLessThanOrEqual(box.vw);
  expect(box.left).toBeGreaterThanOrEqual(0);
});
