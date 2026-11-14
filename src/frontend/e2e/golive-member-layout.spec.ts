import type { Page } from "@playwright/test";
import { expect, serveApi, signIn, test } from "./fixtures";
import { memberShellRoutes } from "./playersKit";

/**
 * Go-live layout fixes on the member side, measured in a real browser (jsdom lays nothing out).
 *
 * BM-04 — the booking grid showed three to five rows of a sixteen-hour day at laptop and phone
 * heights: it took only the room left under the page's chrome, and that room was its 280px floor.
 */
test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "sizes are set per test"); });

const COURTS = ["a", "b", "c", "d"].map((x, i) => ({ id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}` }));
const DAY = new Date().toISOString().slice(0, 10);
const day = () => ({
  date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 6 * 60, dayEndMinute: 22 * 60,
  advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots: [],
});

async function bookings(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(Date.parse(`${DAY}T07:00:00Z`));
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/schedule", body: day() },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    ...memberShellRoutes(),
  ]);
  await page.goto("/bookings");
  await page.waitForSelector('[role="grid"] [data-time-row]');
  await page.waitForTimeout(300);
}

/** Rows of the grid wholly inside the grid's own box, and the box's height. */
const gridRows = (page: Page) => page.evaluate(() => {
  const scroller = document.querySelector<HTMLElement>("[data-grid-scroller]")!;
  const box = scroller.getBoundingClientRect();
  const rows = [...scroller.querySelectorAll<HTMLElement>("[data-time-row]")]
    .filter((row) => { const r = row.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom; }).length;
  return { rows, height: box.height };
});

for (const [name, width, height] of [["laptop", 1440, 723], ["phone", 390, 667], ["short phone", 606, 667]] as const) {
  test(`BM-04 ${name}: the grid is tall enough to hold seven rows of the day`, async ({ page }) => {
    await bookings(page, width, height);
    const { rows, height: tall } = await gridRows(page);
    expect(tall).toBeGreaterThanOrEqual(400);
    expect(rows).toBeGreaterThanOrEqual(6);
  });
}

test("BM-04 laptop: the day's rows start in the first screen, not under a strip of empty chrome", async ({ page }) => {
  await bookings(page, 1440, 723);
  const visible = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-time-row]")]
    .filter((row) => { const r = row.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }).length);
  expect(visible).toBeGreaterThanOrEqual(6);
});
