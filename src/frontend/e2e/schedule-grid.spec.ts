import { SESSION_ADMIN, serveApi, signIn, test, expect, singleTap } from "./fixtures";

/**
 * The booking grid, in a real browser — what no jsdom assertion can reach: layout in pixels,
 * forced colours, the tab order, and a real mouse (P4: R1, R2, R4, R5, R6, D8).
 *
 * <p>
 * <b>Retired with P4.</b> "is one tab stop in selection mode" became "one tab stop, always"
 * (APG grid — the grid was 240 tab stops outside selection mode); "Tab lands on the Selected
 * slots region" became the floating ActionBar toolbar; the "Select"/"Done" text button became
 * the header's icon toggle (R4).
 * </p>
 */

const COURT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const COURT_B = "aaaaaaaa-0000-4000-8000-00000000000b";
const MEMBER = "bbbbbbbb-0000-4000-8000-00000000000b";

/** Tomorrow in UTC — every slice is in the future whatever time this runs at. */
function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * One of every cell type: free, somebody else's, a club hold past closing (so the rows between
 * are Closed — `gridWindow`'s union rule), and a group window that restricts from 08:00.
 */
function day() {
  const d = tomorrow();
  return {
    date: d, timezone: "UTC", sliceMinutes: 15,
    dayStartMinute: 7 * 60, dayEndMinute: 9 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15,
    courts: [
      { id: COURT_A, courtNumber: 1, name: "Court 1" },
      { id: COURT_B, courtNumber: 2, name: "Court 2" },
    ],
    slots: [
      {
        courtId: COURT_A, courtNumber: 1,
        startsAtUtc: `${d}T10:00:00.000Z`, endsAtUtc: `${d}T10:30:00.000Z`,
        status: "adminblock", ownerUserId: null, ownerFirstName: null, ownerPhotoUrl: null,
        isMine: false, bookingId: "hold-1", blockLabel: "League night",
        checkedIn: null, amountChargedMinutes: null,
      },
      {
        courtId: COURT_B, courtNumber: 2,
        startsAtUtc: `${d}T07:00:00.000Z`, endsAtUtc: `${d}T07:30:00.000Z`,
        status: "booked", ownerUserId: MEMBER, ownerFirstName: "Thandi", ownerPhotoUrl: null,
        isMine: false, bookingId: "bk-1", blockLabel: null,
        checkedIn: false, amountChargedMinutes: 50,
      },
    ],
    rules: {
      groups: [{ id: "g1", name: "Non-league members" }],
      allowedWindows: [{ start: "07:00", end: "08:00" }],
      clubHours: { start: "07:00", end: "09:00" },
      remainingToday: null, adminExempt: false,
    },
  };
}

async function openGrid(page: import("@playwright/test").Page, isAdmin = true) {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: isAdmin } },
    { path: "/api/v1/schedule", body: day() },
    { path: "/api/v1/admin/members/", body: [] },
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 10 } },
  ]);
  await page.goto(`/bookings?date=${tomorrow()}`);
  await singleTap(page);
  await page.waitForSelector('[role="grid"]');
}

const box = async (page: import("@playwright/test").Page, name: string) =>
  (await page.getByRole("gridcell", { name, exact: true }).boundingBox())!;

test("slots stand apart: 4px between rows, 6px between courts, edges aligned (R1, R2)", async ({ page }) => {
  await openGrid(page);
  const a = await box(page, "Court 1 at 07:00");
  const below = await box(page, "Court 1 at 07:15");
  const beside = await box(page, "Court 2 at 07:45");
  const aboveBeside = await box(page, "Court 1 at 07:45");
  expect(Math.round(below.y - (a.y + a.height))).toBe(4);
  expect(Math.round(beside.x - (aboveBeside.x + aboveBeside.width))).toBe(6);
  // One column is one x: every cell in a court starts where its neighbours do.
  expect(Math.round(below.x)).toBe(Math.round(a.x));
  expect(a.height).toBe(48);
});

test("two selected neighbours never touch — the selected edge is drawn inside the cell (R2)", async ({ page }) => {
  await openGrid(page, false);
  await page.getByRole("button", { name: "Select several slots" }).click();
  await page.getByRole("button", { name: /^Book Court 1 at 07:00/ }).click();
  await page.getByRole("button", { name: /^Book Court 1 at 07:15/ }).click();
  const edges = await page.locator("[data-selected-edge]").evaluateAll((els) =>
    els.map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
  expect(edges).toHaveLength(2);
  expect(edges[1].top - edges[0].bottom).toBeGreaterThanOrEqual(2);
});

test("every cell keeps a boundary when forced colours throw its fill away", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openGrid(page);
  const borders = await page.evaluate(() =>
    [...document.querySelectorAll('[role="gridcell"]')]
      .map((cell) => cell.querySelector("button, div"))
      .filter((c): c is Element => c !== null)
      .map((c) => {
        const surface = (c.matches("[data-block-rows]") ? c.firstElementChild : c) as Element;
        return {
          text: (surface.textContent ?? "").trim().slice(0, 14),
          width: getComputedStyle(surface).borderTopWidth,
          style: getComputedStyle(surface).borderTopStyle,
        };
      }));
  expect(borders.length).toBeGreaterThan(4);
  for (const b of borders) expect(b.width, `"${b.text}" has no boundary`).not.toBe("0px");
  expect(borders.some((b) => b.style === "dashed")).toBe(true);
});

test("leaves a usable grid at 320 px with a 32 px root font, and no sideways page scroll", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "32px"; });
  });
  await openGrid(page);
  const measured = await page.evaluate(() => ({
    clientHeight: document.querySelector<HTMLElement>("[data-grid-scroller]")?.clientHeight ?? 0,
    pageScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(measured.clientHeight).toBeGreaterThanOrEqual(280);
  expect(measured.pageScrollWidth).toBe(measured.innerWidth);
});

test("keeps the court header and the time column in place while the grid scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await openGrid(page);
  const scroller = page.locator("[data-grid-scroller]");
  const header = page.getByRole("columnheader", { name: /Court 1/ });
  const time = page.getByRole("rowheader", { name: "08:00" });
  const before = { header: (await header.boundingBox())!, time: (await time.boundingBox())! };
  await scroller.evaluate((el) => { el.scrollTop += 150; el.scrollLeft += 80; });
  const after = { header: (await header.boundingBox())!, time: (await time.boundingBox())! };
  expect(Math.round(after.header.y)).toBe(Math.round(before.header.y));
  expect(Math.round(after.time.x)).toBe(Math.round(before.time.x));
});

test("is one tab stop, in or out of selection mode, and Tab out lands on the action bar", async ({ page }) => {
  await openGrid(page);
  const stops = () => page.evaluate(() => document.querySelectorAll('[role="grid"] [tabindex="0"]').length);
  expect(await stops()).toBe(1);
  await page.getByRole("button", { name: "Select several slots" }).click();
  await page.getByRole("button", { name: /^Book Court 1 at 07:00/ }).click();
  expect(await stops()).toBe(1);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(":focus")).toHaveAttribute("aria-label", /Court 2 at 07:15|Thandi/);
  await page.keyboard.press("Tab");
  const landed = await page.evaluate(() => Boolean(document.activeElement?.closest('[role="toolbar"][aria-label="Selected slots"]')));
  expect(landed).toBe(true);
});

test("answers a cell that cannot be booked, rather than doing nothing", async ({ page }) => {
  await openGrid(page, false);
  const restricted = page.locator('button[aria-label*="outside the times you can book"]').first();
  await expect(restricted).toBeVisible();
  await expect(restricted).toBeEnabled();
  await restricted.click();
  await expect(page.locator("[data-grid-explanation]")).toContainText(/You can book 07:00–08:00/);
  await expect(page.locator('[aria-live="polite"]').filter({ hasText: /You can book 07:00–08:00/ })).toHaveCount(1);
});

test("a mouse drag paints a rectangle, enters selection mode, and selects no text", async ({ page }) => {
  await openGrid(page);
  const from = await box(page, "Court 1 at 07:30");
  const to = await box(page, "Court 2 at 07:45");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Stop selecting" })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Selected slots" })).toContainText("4 slots · 1 hour");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window.getSelection()?.toString() ?? "").trim())).toBe("");
});

test("shift+click extends the rectangle, and shift+arrow draws the same shape", async ({ page }) => {
  await openGrid(page);
  await page.getByRole("button", { name: "Select several slots" }).click();
  await page.getByRole("button", { name: /^Book Court 1 at 07:00/ }).click();
  await page.getByRole("gridcell", { name: "Court 1 at 07:30", exact: true }).click({ modifiers: ["Shift"] });
  await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(3);
  await page.keyboard.press("Shift+ArrowRight");
  // Court 2 at 07:00 is Thandi's booking (one block, one key — an admin may take it for a
  // cancel), 07:15 is its continuation, 07:30 is free: three plus two.
  await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(5);
});

test("the action bar floats clear of the phone's tab bar", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openGrid(page, false);
  await page.getByRole("button", { name: "Select several slots" }).click();
  await page.getByRole("button", { name: /^Book Court 1 at 07:00/ }).click();
  const toolbar = page.getByRole("toolbar", { name: "Selected slots" });
  // It slides up; measure where it comes to rest.
  await toolbar.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const barBox = (await toolbar.boundingBox())!;
  const tabs = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--app-bottom-bar-height"));
  const tabBar = parseFloat(tabs) || 0;
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(812 - tabBar);
});

test("scrolled to the end of the page, the court names still show and the bar covers no row", async ({ page }) => {
  // Integration P3/P4: the scroller's ceiling reserved 24px against the shell's 40px bottom
  // padding, the selection room was a spacer that also took the shell's 32px section gap, and the
  // app frame shrank to the scroller so a phone's tab bar hid the page's last 65px. At the end of
  // the page the court header row sat above the scroll edge — gone exactly while slots were picked.
  const long = { ...day(), dayStartMinute: 6 * 60, dayEndMinute: 21 * 60, slots: [],
    rules: { ...day().rules, allowedWindows: [{ start: "06:00", end: "21:00" }], clubHours: { start: "06:00", end: "21:00" } } };
  for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await signIn(page);
    await serveApi(page, [
      { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: false } },
      { path: "/api/v1/schedule", body: long },
      { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    ]);
    await page.goto(`/bookings?date=${tomorrow()}`);
    await singleTap(page);
    await page.waitForSelector('[role="grid"]');
    for (const selecting of [false, true]) {
      if (selecting) await page.getByRole("button", { name: "Select several slots" }).click();
      const m = await page.evaluate(() => {
        const main = document.getElementById("main-content")!;
        main.scrollTop = main.scrollHeight;
        const grid = document.querySelector("[data-grid-scroller]")!.getBoundingClientRect();
        const bar = document.querySelector("[data-action-bar] [role=toolbar]")?.getBoundingClientRect();
        const tabs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-bottom-bar-height")) || 0;
        return { top: grid.top, bottom: grid.bottom, mainTop: main.getBoundingClientRect().top, floor: bar ? bar.top : innerHeight - tabs };
      });
      expect(m.top, `${viewport.width}px, selecting=${selecting}: header row above the scroll edge`).toBeGreaterThanOrEqual(m.mainTop - 1);
      expect(m.bottom, `${viewport.width}px, selecting=${selecting}: last row under the chrome`).toBeLessThanOrEqual(m.floor + 1);
    }
  }
});
