import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";

/**
 * The booking grid, in a real browser — the four things no jsdom assertion can reach.
 *
 * <p>
 * Every case below was found by driving the screen, and each one is a fact about LAYOUT or
 * about the platform rather than about a return value:
 * </p>
 *
 * <ul>
 *   <li>where the grid opens, in pixels, measured against the viewport (D3-B01);</li>
 *   <li>what a cell looks like when `forced-colors: active` throws every author background
 *       away — the state in which two of the six cell types had no boundary at all;</li>
 *   <li>how much grid is left at 320x568 with a 32px root font, where a `rem` reserve had
 *       collapsed the scroller to 74px;</li>
 *   <li>how many tab stops the grid is, which is 240 or 1 depending on a roving index that
 *       exists nowhere in the markup a snapshot would capture.</li>
 * </ul>
 */

const COURT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const COURT_B = "aaaaaaaa-0000-4000-8000-00000000000b";
const MEMBER = "bbbbbbbb-0000-4000-8000-00000000000b";

/** Tomorrow, so every slice is in the future whatever time this runs at. */
function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * A day with one of every cell type on it: free, taken by somebody else, a club hold, a
 * continuation, and — through the group window — a restricted one. `dayEndMinute` is before
 * the hold, so the rows between are drawn Closed: that union of the club's hours with whatever
 * the day's bookings occupy is `gridWindow`'s own rule, and it exists because a member was once
 * sold 03:00 on a Sunday and the booking appeared on no screen in the product.
 */
function day(extra: Record<string, unknown> = {}) {
  const d = tomorrow();
  return {
    date: d, timezone: "UTC", sliceMinutes: 15,
    dayStartMinute: 7 * 60, dayEndMinute: 9 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15,
    courts: [
      { id: COURT_A, courtNumber: 1, name: "Court 1", slicePriceCredits: 50 },
      { id: COURT_B, courtNumber: 2, name: "Court 2", slicePriceCredits: 50 },
    ],
    slots: [
      {
        courtId: COURT_A, courtNumber: 1,
        startsAtUtc: `${d}T10:00:00.000Z`, endsAtUtc: `${d}T10:30:00.000Z`,
        status: "adminblock", ownerUserId: null, ownerFirstName: null, ownerPhotoUrl: null,
        isMine: false, bookingId: "hold-1", blockLabel: "League night",
        checkedIn: null, amountChargedCredits: null,
      },
      {
        courtId: COURT_B, courtNumber: 2,
        startsAtUtc: `${d}T07:00:00.000Z`, endsAtUtc: `${d}T07:15:00.000Z`,
        status: "booked", ownerUserId: MEMBER, ownerFirstName: "Thandi", ownerPhotoUrl: null,
        isMine: false, bookingId: "bk-1", blockLabel: null,
        checkedIn: false, amountChargedCredits: 50,
      },
    ],
    rules: {
      groups: [{ id: "g1", name: "Non-league members" }],
      allowedWindows: [{ start: "07:00", end: "08:00" }],
      clubHours: { start: "07:00", end: "09:00" },
      slicePriceCredits: 50, remainingToday: null, adminExempt: false,
    },
    ...extra,
  };
}

async function openGrid(page: import("@playwright/test").Page, over: Record<string, unknown> = {}) {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/schedule", body: day(over) },
    { path: "/api/v1/admin/members/", body: [] },
    { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 10 } },
  ]);
  await page.goto("/schedule");
  await page.waitForSelector('[role="grid"]');
}

test("every cell keeps a boundary when forced colours throw its fill away", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openGrid(page);

  const borders = await page.evaluate(() =>
    [...document.querySelectorAll('[role="gridcell"] > *')].map((c) => ({
      text: (c.textContent ?? "").trim().slice(0, 14),
      width: getComputedStyle(c).borderTopWidth,
      style: getComputedStyle(c).borderTopStyle,
    })));

  expect(borders.length).toBeGreaterThan(4);
  // Every author background is thrown away here, so a cell whose only boundary is its fill
  // becomes bare text in an empty box. Measured: the Taken cell and the continuation were the
  // two on the grid computing 0px.
  for (const b of borders) expect(b.width, `"${b.text}" has no boundary`).not.toBe("0px");
  // And colour is never the only carrier: the restricted state keeps its DASHED edge, so the
  // five unavailable states are still told apart with every fill removed.
  expect(borders.some((b) => b.style === "dashed")).toBe(true);
});

test("leaves a usable grid at 320 px with a 32 px root font", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "32px"; });
  });
  await openGrid(page);

  const box = await page.evaluate(() => {
    const scroller = document.querySelector('[role="grid"]')?.parentElement;
    return {
      clientHeight: scroller?.clientHeight ?? 0,
      pageScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  // It measured 74 px when the reserve was written as `9rem`: a slit, with the sticky court
  // header intercepting the click on the one row inside it. A rem reserve scales with the TEXT
  // while the viewport does not, so the bigger the type the less grid there was.
  expect(box.clientHeight).toBeGreaterThanOrEqual(280);
  expect(box.pageScrollWidth).toBe(box.innerWidth);
});

test("opens on the first row that has not started, not at the top of the club's day", async ({ page }) => {
  await openGrid(page);
  const first = page.locator('button[aria-label^="Book "]').first();
  const top = await first.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  // Measured at 3 670 px on a 812 px phone before this: 74 rows of the word PAST between the
  // top of the page and the first slot anybody could book.
  expect(top).toBeLessThan(await page.evaluate(() => window.innerHeight));
});

test("is one tab stop in selection mode, not one per cell", async ({ page }) => {
  await openGrid(page);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.locator('button[aria-label^="Book "]').first().click();

  const stops = await page.evaluate(() => ({
    cells: document.querySelectorAll('[role="gridcell"][tabindex="0"]').length,
    innerInTabOrder: [...document.querySelectorAll('[role="gridcell"] button')]
      .filter((b) => (b as HTMLElement).tabIndex >= 0).length,
  }));
  expect(stops.cells).toBe(1);
  expect(stops.innerInTabOrder).toBe(0);

  // And Tab out of the grid lands on the action bar, which is deliberately next in DOM order.
  await page.keyboard.press("Tab");
  const landed = await page.evaluate(() =>
    Boolean(document.activeElement?.closest('[role="region"][aria-label="Selected slots"]')));
  expect(landed).toBe(true);
});

test("answers a cell that cannot be booked, rather than doing nothing", async ({ page }) => {
  await openGrid(page);
  // 08:00 is outside the group's 07:00–08:00 window.
  const restricted = page.locator('button[aria-label*="outside the times you can book"]').first();
  await expect(restricted).toBeVisible();
  // An ordinary, enabled button: `aria-disabled` would assert it cannot be operated, and
  // operating it is the whole point. Playwright's own actionability check is the proof —
  // it refuses to click an `aria-disabled` button at all.
  await expect(restricted).toBeEnabled();
  await restricted.click();
  await expect(page.locator('[aria-live="polite"]').filter({ hasText: /You can book 07:00–08:00/ })).toHaveCount(1);
});

/**
 * The marquee — D3 §4.1, door 3 — driven with a real mouse in a real engine.
 *
 * <p>
 * The unit test dispatches `pointerover` on the cells it means, which proves the wiring and
 * nothing about the gesture. What a browser adds is the sequence: `pointerover` arriving from
 * movement rather than from a call, a real `click` fired on release over a cell that is now
 * ticked, and the text selection the drag would otherwise paint across every court name it
 * crosses. The last of those is what made a first attempt at this look broken rather than
 * wrong, and no assertion in jsdom can see any of the three.
 * </p>
 */
test("a mouse drag paints a rectangle, enters selection mode, and selects no text", async ({ page }) => {
  await openGrid(page);

  const cell = (name: string) => page.getByRole("gridcell", { name });
  const from = (await cell("Court 1 at 07:00").boundingBox())!;
  const to = (await cell("Court 2 at 07:30").boundingBox())!;

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Through the cell between, as a hand would: a marquee that only reads its endpoints would
  // pass this and miss every cell a real sweep crosses.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height * 1.5, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();

  // Six cells: two courts by three slices. And the mode is on, without anybody pressing Select.
  await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(6);
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();

  // No booking dialog: the click the browser fires on release is swallowed, or a drag would
  // end by opening the very thing selection mode exists to avoid opening one cell at a time.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // And the drag painted no text selection across the court names it crossed.
  expect(await page.evaluate(() => (window.getSelection()?.toString() ?? "").trim())).toBe("");
});

test("shift+click extends the rectangle, and shift+arrow draws the same shape", async ({ page }) => {
  await openGrid(page);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("gridcell", { name: "Court 1 at 07:00" }).click();

  await page.getByRole("gridcell", { name: "Court 1 at 07:30" }).click({ modifiers: ["Shift"] });
  await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(3);

  // Reading order would have taken Court 2 at 07:00 and 07:15 as well. It is a rectangle.
  await expect(page.getByRole("gridcell", { name: "Court 2 at 07:00" }))
    .not.toHaveAttribute("aria-selected", "true");

  // The keyboard grows the same shape from the same anchor — one selection model, two hands.
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(6);
});
