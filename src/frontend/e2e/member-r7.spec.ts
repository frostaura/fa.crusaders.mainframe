import type { Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { inviteFixture, memberShellRoutes } from "./playersKit";

/**
 * Review round 7 (lane FD1, member shell and bookings) — what only a browser can measure: where
 * the phone's Bookings grid opens (§4.2, Dean's call), and the round's member layout findings
 * further down this file.
 */

test.describe.configure({ timeout: 120_000 });

const COURTS = ["a", "b", "c", "d"].map((x, i) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}`,
}));

const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = inDays(2);

function wholeDay() {
  return {
    date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 8 * 60, dayEndMinute: 20 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots: [],
  };
}

function game(n: number) {
  const start = new Date(`${inDays(3 + n)}T10:00:00Z`);
  return {
    booking_id: `bbbbbbbb-0000-4000-8000-00000000000${n}`, court_name: `Court ${n}`,
    starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3_600_000).toISOString(),
    role: "organiser", status: "Confirmed", players: [], my_share_minutes: 50, needs_action: false,
  };
}

async function openBookings(page: Page, width: number, height: number, query = `?date=${DAY}`) {
  await page.setViewportSize({ width, height });
  await signIn(page);
  const routes: ApiRoute[] = [
    { path: "/api/v1/schedule", body: wholeDay() },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [game(1), game(2), game(3)] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    ...memberShellRoutes({ invites: [inviteFixture({ invite_id: "i0" }), inviteFixture({ invite_id: "i1" })] }),
  ];
  await serveApi(page, routes);
  await page.goto(`/bookings${query}`);
  await page.waitForSelector('[role="grid"] button[aria-label^="Book "]');
  // The page settles: the opening scroll runs on the frame after the grid draws.
  await page.waitForTimeout(300);
}

const FIRST_BOOK = '[role="grid"] button[aria-label^="Book "]';
const firstBookTop = (page: Page) => page.locator(FIRST_BOOK).first().evaluate((el) => el.getBoundingClientRect().top);
const mainScrollTop = (page: Page) => page.evaluate(() => document.querySelector("main")!.scrollTop);

test.describe("§4.2 — on a phone Bookings opens with the first bookable row in view", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("at 390 the first Book cell is in the top part of the screen, nothing above it removed", async ({ page }) => {
    await openBookings(page, 390, 844);
    const top = await firstBookTop(page);
    test.info().annotations.push({ type: "first Book cell y at 390", description: String(Math.round(top)) });
    // Measured before (R6/R7): 555–759 with the games strip, picker and court chips above it.
    expect(top, "first Book cell's y at 390").toBeLessThanOrEqual(360);
    expect(top, "below the app bar and the week").toBeGreaterThan(56);
    // Nothing removed: the games strip and the invites link are still on the page, above.
    await expect(page.locator("[data-upcoming]")).toHaveCount(1);
    await expect(page.locator("[data-invites-badge]")).toHaveCount(1);
    // The week stays in view (it sticks), so the day on screen is never a mystery.
    const strip = await page.locator("[data-day-strip]").evaluate((el) => el.getBoundingClientRect());
    expect(strip.top).toBeGreaterThanOrEqual(0);
    expect(strip.bottom).toBeLessThanOrEqual(top);
  });

  test("without a date in the address the same holds (the club's today)", async ({ page }) => {
    await openBookings(page, 390, 844, "");
    expect(await firstBookTop(page)).toBeLessThanOrEqual(360);
  });

  test("a re-read never scrolls the page again: the member's own scroll is kept", async ({ page }) => {
    await openBookings(page, 390, 844);
    await page.evaluate(() => { document.querySelector("main")!.scrollTop = 0; });
    await page.getByRole("button", { name: /Refresh/ }).first().click();
    await page.waitForTimeout(400);
    expect(await mainScrollTop(page)).toBe(0);
  });

  test("a desktop opens at the top of the page", async ({ page }) => {
    await openBookings(page, 1280, 800);
    expect(await mainScrollTop(page)).toBe(0);
  });
});
