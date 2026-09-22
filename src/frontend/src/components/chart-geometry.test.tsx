import { afterEach, describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { AreaChart, BarChart, LineChart, YAxis } from "recharts";
import {
  BookingsLineChart, CourtsRevenueBarChart, DailyFlowBarChart, MyBalanceLineChart,
  MyBookingsBarChart, MyFlowBarChart, RevenueAreaChart, moneyAxisWidth,
} from "./Charts";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "../lib/currency";
import type { DailyAdminPoint, DailyMePoint } from "../lib/api";

afterEach(resetClubCurrencySymbol);

/**
 * The plot area has to leave room for the numbers around it.
 *
 * <p>
 * Two things were measured wrong on the live page. The topmost y-axis tick was sliced in half by
 * the SVG's own top edge — "50.00 cr" drawn as a row of half-height digits above an intact
 * "45.00 cr" — because the top margin was 8px and a tick is centred on its gridline. And every
 * money tick wrapped onto two lines ("50.00" / "cr"), because the 48px gutter was narrower than
 * the label and recharts wraps rather than overflows.
 * </p>
 *
 * <p>
 * <b>The unit moved to the FRONT and became the club's to choose, which changes the second
 * measurement and not the first.</b> "R50.00" is narrower than "50.00 cr" was, so the default
 * club has room to spare. A club on "CHF" renders "CHF1000.00", which is wider than anything
 * the 64px constant was ever measured against — and the failure mode is the one above,
 * unchanged: recharts wraps the tick, the label column doubles in height, and the top one goes
 * into the clip. So the gutter is no longer a constant. It is derived from the symbol's length,
 * and {@link moneyAxisWidth} is the derivation.
 * </p>
 *
 * <p>
 * The third was the negative left margin. <code>left: -12</code> pulled the whole axis-label
 * column 12px outside the chart's box, which is exactly where the carousel's Previous arrow sits
 * — <code>left-0 -translate-x-3</code> — so a 36px button was drawn on top of the tick labels.
 * </p>
 *
 * <p>
 * These are assertions about numbers rather than about pixels: jsdom has no layout, so nothing
 * here can prove the label is uncut. What it can do is stop the three constants drifting back,
 * which is what they did. The uncut label was confirmed in a real browser.
 * </p>
 */

const ADMIN: DailyAdminPoint[] = [
  { date: "2026-09-01", top_ups_credits: 160, booking_charges_credits: 24, refunds_credits: 8, penalties_credits: 2.4, adjustments_credits: 0, reversals_credits: 0, net_movement_credits: 141.6, bookings: 3, no_shows: 1 },
];
const ME: DailyMePoint[] = [
  { date: "2026-09-01", top_ups_credits: 160, spent_credits: 24, refunds_credits: 8, bookings: 1, attended: 1, minutes_on_court: 45, balance_credits: 136 },
];

function flatten(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement(node)) return [];
  const { children } = node.props as { children?: ReactNode };
  return [node, ...flatten(children)];
}

/** Every cartesian chart, and whether its y-axis carries money or plain counts. */
type Axis = "money" | "counts";
const CHARTS: [string, () => ReactNode, Axis][] = [
  ["Top-ups over time", () => RevenueAreaChart({ data: ADMIN }), "money"],
  ["Daily money flow (club)", () => DailyFlowBarChart({ data: ADMIN }), "money"],
  ["Bookings & no-shows", () => BookingsLineChart({ data: ADMIN }), "counts"],
  ["Revenue by court", () => CourtsRevenueBarChart({ data: [{ court_name: "Court 1", revenue_credits: 80, bookings: 4 }] }), "money"],
  ["Wallet balance", () => MyBalanceLineChart({ data: ME }), "money"],
  ["Daily money flow (member)", () => MyFlowBarChart({ data: ME }), "money"],
  ["My bookings", () => MyBookingsBarChart({ data: ME }), "counts"],
];

/**
 * The gutter the default club gets, and the number a real browser confirmed.
 *
 * <p>
 * 64 was measured against "50.00 cr". It survives the change because "R50.00" is narrower than
 * what it was measured for, not because nobody looked — and it is asserted here as a FLOOR on
 * {@link moneyAxisWidth}'s one-character answer so that a re-derivation cannot quietly give the
 * default club less room than the version that was photographed.
 * </p>
 */
const CONFIRMED_DEFAULT_GUTTER = 64;

function yAxisWidths(chart: ReactNode): (number | undefined)[] {
  return flatten(chart).filter((e) => e.type === YAxis).map((e) => (e.props as { width?: number }).width);
}

describe("chart plot area", () => {
  for (const [name, chart, axis] of CHARTS) {
    it(`${name}: leaves room above the top tick and does not draw the axis outside itself`, () => {
      const plot = flatten(chart()).find((e) => e.type === AreaChart || e.type === BarChart || e.type === LineChart)!;
      const margin = (plot.props as { margin: { top: number; left: number } }).margin;
      // Half a line of 11px text, so the topmost tick is not cut by the SVG edge.
      expect(margin.top).toBeGreaterThanOrEqual(16);
      // A negative left margin is what put the tick labels under the carousel arrow.
      expect(margin.left).toBeGreaterThanOrEqual(0);
    });

    it(`${name}: gives the y-axis a gutter its labels fit in`, () => {
      const widths = yAxisWidths(chart());
      expect(widths).not.toHaveLength(0);
      for (const width of widths) {
        expect(width).toBeGreaterThanOrEqual(axis === "money" ? moneyAxisWidth() : 32);
      }
    });

    if (axis === "money") {
      /**
       * The club's symbol reaches the GUTTER, not only the tick text.
       *
       * <p>
       * This is the assertion the old constant could not carry. A chart that formats "CHF50.00"
       * into a box sized for "R50.00" does not overflow — recharts wraps it, which is the exact
       * failure the 48→64 change was made for, reintroduced by a club changing one setting.
       * </p>
       */
      it(`${name}: widens its gutter for a club whose symbol is longer`, () => {
        setClubCurrencySymbol("CHF");
        for (const width of yAxisWidths(chart())) {
          expect(width).toBeGreaterThanOrEqual(moneyAxisWidth());
          expect(width).toBeGreaterThan(moneyAxisWidth("R"));
        }
      });
    } else {
      it(`${name}: a count axis is not widened by a symbol it never draws`, () => {
        const plain = yAxisWidths(chart());
        setClubCurrencySymbol("CHF");
        expect(yAxisWidths(chart())).toEqual(plain);
      });
    }
  }
});

/**
 * The derivation itself, rather than the constant it replaced.
 *
 * <p>
 * jsdom computes no layout, so none of this proves a label is uncut — the same caveat the file
 * header states. What it holds is the DECISION: that the gutter grows with the symbol, that it
 * never drops below the width a browser confirmed, and that an absent symbol is treated as the
 * default rather than as no symbol at all.
 * </p>
 */
describe("the money gutter", () => {
  it("never gives the default club less than the width a browser confirmed", () => {
    expect(moneyAxisWidth("R")).toBeGreaterThanOrEqual(CONFIRMED_DEFAULT_GUTTER);
  });

  it("grows, strictly, with every extra character of symbol", () => {
    const widths = ["R", "R$", "CHF", "US$$"].map((s) => moneyAxisWidth(s));
    for (let i = 1; i < widths.length; i += 1) expect(widths[i]).toBeGreaterThan(widths[i - 1]);
  });

  it("reads the club's symbol when it is not told one", () => {
    setClubCurrencySymbol("CHF");
    expect(moneyAxisWidth()).toBe(moneyAxisWidth("CHF"));
    resetClubCurrencySymbol();
    expect(moneyAxisWidth()).toBe(moneyAxisWidth("R"));
  });

  it("treats an unusable symbol exactly as the default", () => {
    setClubCurrencySymbol("CHF");
    setClubCurrencySymbol(undefined);
    expect(moneyAxisWidth()).toBe(moneyAxisWidth("R"));
  });

  /**
   * The bound is the bound. `MAX_CURRENCY_SYMBOL_LENGTH` is 4, so the widest gutter this can
   * ever be asked for is a four-character one — and it has to stay a gutter rather than
   * becoming the chart.
   */
  it("stays a gutter at the widest symbol the product accepts", () => {
    expect(moneyAxisWidth("US$$")).toBeLessThanOrEqual(96);
  });
});
