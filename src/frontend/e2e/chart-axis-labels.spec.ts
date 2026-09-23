import { readFileSync } from "node:fs";
import { expect, serveApi, SESSION_ADMIN, signIn, test } from "./fixtures";

/**
 * The y-axis labels on the report charts, in a real browser.
 *
 * <p>
 * jsdom has no layout, so the unit suite can hold the gutter CONSTANT and can prove nothing
 * about the label that has to fit inside it. Both faults this spec exists for were invisible
 * there and obvious here:
 * </p>
 *
 * <ul>
 * <li><b>Every credit tick above 99 wrapped onto two lines.</b> "100.00" above "cr", on an
 * ordinary club's ordinary chart. recharts decides whether a tick fits by measuring it in a
 * hidden <code>&lt;span&gt;</code> that inherits the BODY's font size while drawing it at the
 * axis's 11px, so it judged every label about 45% too wide. A wrapped tick doubles the label
 * column's height and pushes the topmost one into the SVG's clip.</li>
 * <li><b>A four-figure negative overhung the chart's own left edge.</b> The signed charts plot
 * net series and net goes negative on any day whose penalty rows reverse an earlier sweep;
 * "-1350.00 cr" is 57.3px against the 56px the shipped 64px gutter left it, and what sits in
 * that 1.3px is the carousel's Previous arrow.</li>
 * </ul>
 *
 * <p>
 * <b>The font is planted rather than assumed.</b> This repository is worked in a git worktree
 * whose <code>node_modules</code> resolves outside Vite's serving root, so the dev server
 * answers 403 for every Figtree file and the browser falls back to the platform sans. Measuring
 * a label against a font the product does not ship would make this spec agree with itself and
 * with nothing else, so the real Figtree 400 is injected from the package the app builds
 * against. On a normal checkout Vite serves the identical face and this declaration is a
 * harmless duplicate.
 * </p>
 */

const FIGTREE_400 = readFileSync(
  new URL("../node_modules/@fontsource/figtree/files/figtree-latin-400-normal.woff2", import.meta.url),
).toString("base64");

/**
 * A club whose penalties went four figures negative on one day and stayed ordinary on the
 * other — so the same chart has to draw "-1350.00 cr" and "200.00 cr" without either of them
 * wrapping or overhanging.
 */
const DAILY = [
  { date: "2026-09-01", top_ups_credits: 200, booking_charges_credits: 30, refunds_credits: 8, penalties_credits: -1350, adjustments_credits: 0, reversals_credits: 0, net_movement_credits: -1172, bookings: 4, no_shows: 1 },
  { date: "2026-09-02", top_ups_credits: 160, booking_charges_credits: 24, refunds_credits: 0, penalties_credits: 12, adjustments_credits: 0, reversals_credits: 0, net_movement_credits: 124, bookings: 3, no_shows: 0 },
];

async function openReports(page: Parameters<typeof serveApi>[0]) {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Club Admin", email: "a@test.local", photo_url: null, membership_number: "A-1" } },
    { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [] } },
    { path: "/api/v1/reports/me/wallet", body: { from: "", to: "", top_ups_credits: 0, spent_credits: 0, refunds_credits: 0, penalty_count: 0, count: 0, minutes_on_court: 0 } },
    { path: "/api/v1/reports/me/daily", body: [] },
    { path: "/api/v1/admin/reports/revenue", body: { from: "2026-09-01T00:00:00Z", to: "2026-09-03T00:00:00Z", gross_topups_zar: 1000, reversals_zar: 0, net_zar: 1000, gross_topups_credits: 1600, reversals_credits: 0, net_credits: 1600 } },
    { path: "/api/v1/admin/reports/utilisation", body: { from: "", to: "", by_court: [] } },
    { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 0, no_show: 0, no_show_pct: 0 } },
    { path: "/api/v1/admin/reports/daily", body: DAILY },
  ]);

  await page.goto("/reports");
  await page.addStyleTag({
    content: `@font-face{font-family:'Figtree';font-style:normal;font-weight:400;font-display:block;src:url(data:font/woff2;base64,${FIGTREE_400}) format('woff2');}`,
  });
  await page.evaluate(() => document.fonts.ready);
  // The frames render only once they have been measured, and the axis relays out when the
  // font lands. Waiting for a tick to exist is not enough; waiting for the count to settle is.
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=chart-frame] text").length > 4);
  await page.waitForTimeout(500);
}

/** Every y-axis tick label on the page, with the geometry that decides whether it is legible. */
async function axisLabels(page: Parameters<typeof serveApi>[0]) {
  return page.evaluate(() => {
    const out: { text: string; lines: number; overhang: number; width: number }[] = [];
    // Every svg INSIDE the frame, not the first one: recharts puts the legend's swatch icons
    // in a wrapper div ahead of the plot surface, so `querySelector("svg")` finds a 14px
    // legend square on exactly the charts that have a legend — which is the signed pair this
    // spec exists for. The surface is the one carrying a y-axis.
    document.querySelectorAll("[data-testid=chart-frame] svg").forEach((svg) => {
      const ticks = svg.querySelectorAll("g[class*=yAxis] text");
      if (ticks.length === 0) return;
      const left = svg.getBoundingClientRect().left;
      ticks.forEach((t) => {
        const box = t.getBoundingClientRect();
        out.push({
          text: t.textContent ?? "",
          lines: t.querySelectorAll("tspan").length,
          // Positive means the label starts left of the chart's own edge, under the carousel
          // arrow and inside the SVG's clip.
          overhang: Math.round((left - box.left) * 100) / 100,
          width: Math.round(box.width * 100) / 100,
        });
      });
    });
    return out;
  });
}

test("no y-axis tick label wraps onto two lines", async ({ page }) => {
  await openReports(page);
  const labels = await axisLabels(page);

  expect(labels.length).toBeGreaterThan(4);
  // The credit labels are the ones that were breaking; the count axes were never in question.
  expect(labels.filter((l) => l.text.includes("cr")).length).toBeGreaterThan(0);
  expect(labels.filter((l) => l.lines > 1)).toEqual([]);
});

test("no y-axis tick label overhangs the chart it belongs to", async ({ page }) => {
  await openReports(page);
  const labels = await axisLabels(page);

  // A hair of tolerance for subpixel text metrics; 1.3px of overhang was the measured defect,
  // so this is not a threshold anything real hides under.
  expect(labels.filter((l) => l.overhang > 0.5)).toEqual([]);
});

test("the four-figure negative the signed charts can produce is drawn in full", async ({ page }) => {
  await openReports(page);
  const labels = await axisLabels(page);

  // Named explicitly, so a future change that quietly stops the chart reaching four figures
  // cannot turn the two tests above into assertions about nothing.
  const negative = labels.filter((l) => /^-\d{4}\./.test(l.text));
  expect(negative.length).toBeGreaterThan(0);
  for (const label of negative) {
    expect(label.lines, label.text).toBeLessThanOrEqual(1);
    expect(label.overhang, label.text).toBeLessThanOrEqual(0.5);
  }
});
