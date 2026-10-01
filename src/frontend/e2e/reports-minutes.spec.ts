import { expect, serveApi, SESSION_ADMIN, signIn, test } from "./fixtures";
import { CLUB_REPORT_COPY as COPY } from "../src/lib/reportsCopy";

/**
 * P13 — the club's report in a real browser: whole minutes, rand where rand is meant, and a
 * desktop that uses its width (sales beside the minutes totals, the charts beside the courts),
 * while a phone stacks the same panels in reading order.
 */

const DAILY = [
  { date: "2026-09-01", top_ups_minutes: 900, booking_charges_minutes: 270, refunds_minutes: 45, penalties_minutes: 15, adjustments_minutes: 60, reversals_minutes: 0, net_movement_minutes: 720, bookings: 6, no_shows: 1 },
  { date: "2026-09-02", top_ups_minutes: 300, booking_charges_minutes: 90, refunds_minutes: 0, penalties_minutes: 0, adjustments_minutes: 0, reversals_minutes: -300, net_movement_minutes: -90, bookings: 2, no_shows: 0 },
];

const ROUTES = [
  { path: "/api/v1/whoami", body: SESSION_ADMIN },
  { path: "/api/v1/me/profile", body: { full_name: "Club Admin", email: "a@test.local", photo_url: null, membership_number: "A-1" } },
  { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [] } },
  {
    path: "/api/v1/admin/reports/revenue",
    body: {
      from: "2026-09-01T00:00:00Z", to: "2026-09-03T00:00:00Z",
      gross_topups_zar: 1650, reversals_zar: 550, net_zar: 1100,
      gross_topups_minutes: 1200, reversals_minutes: 300, net_minutes: 900, zar_per_minute_sold: 1.2222,
    },
  },
  {
    path: "/api/v1/admin/reports/utilisation",
    body: {
      from: "", to: "",
      by_court: [
        { court_id: "c1", court_number: 1, court_name: "Court 1", slices: 8, booked_minutes: 240, bookings: 5, kept_minutes: 225, sold_minutes: 270 },
        { court_id: "c2", court_number: 2, court_name: "Court 2", slices: 2, booked_minutes: 90, bookings: 3, kept_minutes: 15, sold_minutes: 90 },
      ],
    },
  },
  { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 8, no_show: 1, no_show_pct: 12.5 } },
  { path: "/api/v1/admin/reports/daily", body: DAILY },
];

async function open(page: Parameters<typeof serveApi>[0], width: number) {
  await page.setViewportSize({ width, height: 1000 });
  await signIn(page);
  await serveApi(page, ROUTES);
  await page.goto("/admin/reports?from=2026-09-01&to=2026-09-02");
  await expect(page.getByRole("region", { name: COPY.sales.title })).toBeVisible();
}

async function boxOf(page: Parameters<typeof serveApi>[0], name: string) {
  return (await page.getByRole("region", { name, exact: true }).boundingBox())!;
}

test("says the period in whole minutes and rand, never a decimal minute or a credit", async ({ page }) => {
  await open(page, 1440);
  const main = page.locator("main");
  // Rand where rand is meant: received, and the price per hour joining the two units.
  await expect(page.getByRole("region", { name: COPY.sales.title })).toContainText("R1100.00");
  await expect(main).toContainText("R73.33"); // 1.2222 × 60, the tile and the card
  // Minutes in the app's one format.
  await expect(page.getByRole("region", { name: COPY.sales.title })).toContainText("15 h");
  await expect(page.getByRole("region", { name: COPY.utilisation.title })).toContainText("4 h 30 min");
  await expect(page.getByRole("columnheader", { name: COPY.utilisation.charged })).toBeVisible();
  const text = (await main.innerText()).replace(/R\d[\d.]*/g, "");
  expect(text).not.toMatch(/\bcr\b|credit|Quoted/i);
  expect(text).not.toMatch(/\d+\.\d{2}\s*(min|h)\b/);
});

for (const width of [1440, 1920] as const) {
  test(`${width}px: a desktop puts sales beside the minutes totals, and the charts beside the courts`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "a desktop width");
    await open(page, width);
    const sales = await boxOf(page, COPY.sales.title);
    const totals = await boxOf(page, COPY.totals.title);
    expect(Math.abs(sales.y - totals.y)).toBeLessThan(2);
    expect(totals.x).toBeGreaterThan(sales.x + sales.width - 1);

    const charts = await boxOf(page, COPY.charts.title);
    const courts = await boxOf(page, COPY.utilisation.title);
    expect(Math.abs(charts.y - courts.y)).toBeLessThan(2);
    expect(courts.x).toBeGreaterThan(charts.x + charts.width - 1);

    // Nothing scrolls the page sideways.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("390px: a phone stacks the same panels in reading order, without sideways scroll", async ({ page }) => {
  await open(page, 390);
  const order = [COPY.sales.title, COPY.totals.title, COPY.charts.title, COPY.utilisation.title, COPY.daily.title];
  const ys: number[] = [];
  for (const name of order) ys.push((await boxOf(page, name)).y);
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  const sales = await boxOf(page, COPY.sales.title);
  const totals = await boxOf(page, COPY.totals.title);
  expect(Math.abs(sales.x - totals.x)).toBeLessThan(2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
