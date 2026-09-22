import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Area, Bar, AreaChart, BarChart, Line, LineChart, YAxis } from "recharts";
import {
  BookingsLineChart, CourtsRevenueBarChart, DailyFlowBarChart, MyBalanceLineChart,
  MyBookingsBarChart, MyFlowBarChart, RevenueAreaChart, creditAxisWidth,
} from "./Charts";
import type { DailyAdminPoint, DailyMePoint } from "../lib/api";

/**
 * The plot area has to leave room for the numbers around it.
 *
 * <p>
 * Two things were measured wrong on the live page. The topmost y-axis tick was sliced in half by
 * the SVG's own top edge — "50.00 cr" drawn as a row of half-height digits above an intact
 * "45.00 cr" — because the top margin was 8px and a tick is centred on its gridline. And every
 * credit tick wrapped onto two lines ("50.00" / "cr"), because the 48px gutter was narrower than
 * the label and recharts wraps rather than overflows.
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

/** Every cartesian chart, and whether its y-axis carries credits or plain counts. */
const CHARTS: [string, ReactNode, "credits" | "counts"][] = [
  ["Top-ups over time", RevenueAreaChart({ data: ADMIN }), "credits"],
  ["Daily money flow (club)", DailyFlowBarChart({ data: ADMIN }), "credits"],
  ["Bookings & no-shows", BookingsLineChart({ data: ADMIN }), "counts"],
  ["Revenue by court", CourtsRevenueBarChart({ data: [{ court_name: "Court 1", revenue_credits: 80, bookings: 4 }] }), "credits"],
  ["Wallet balance", MyBalanceLineChart({ data: ME }), "credits"],
  ["Daily money flow (member)", MyFlowBarChart({ data: ME }), "credits"],
  ["My bookings", MyBookingsBarChart({ data: ME }), "counts"],
];

/** Wide enough for "50.00 cr" at 11px, which is what wrapped at 48. */
const CREDIT_GUTTER = 64;

describe("chart plot area", () => {
  for (const [name, chart, axis] of CHARTS) {
    const tree = flatten(chart);
    const plot = tree.find((e) => e.type === AreaChart || e.type === BarChart || e.type === LineChart)!;
    const margin = (plot.props as { margin: { top: number; left: number } }).margin;
    const yAxis = tree.filter((e) => e.type === YAxis).map((e) => e.props as { width?: number });

    it(`${name}: leaves room above the top tick and does not draw the axis outside itself`, () => {
      // Half a line of 11px text, so the topmost tick is not cut by the SVG edge.
      expect(margin.top).toBeGreaterThanOrEqual(16);
      // A negative left margin is what put the tick labels under the carousel arrow.
      expect(margin.left).toBeGreaterThanOrEqual(0);
    });

    it(`${name}: gives the y-axis a gutter its labels fit in`, () => {
      expect(yAxis).not.toHaveLength(0);
      for (const props of yAxis) {
        expect(props.width).toBeGreaterThanOrEqual(axis === "credits" ? CREDIT_GUTTER : 32);
      }
    });
  }
});

/**
 * The gutter has to fit the widest label THIS chart's data can produce, not the widest one
 * anybody happened to have on screen the day it was set.
 *
 * <p>
 * 64 was measured against "50.00 cr" and shipped as a constant, and the constant is the defect:
 * the signed charts plot <b>net</b> series, net goes four figures negative on any day whose
 * penalty rows are reversals of an earlier day's sweep, and "-1350.00 cr" does not fit in it.
 * Measured in Chromium at the 11px Figtree the axis is actually set in, the label is 57.3px
 * wide and the gutter leaves it <code>64 − 6 − 2 = 56px</code> — recharts anchors a left axis's
 * tick text at <code>width − tickSize − tickMargin</code>. It overhangs the chart's own left
 * edge, which is where the carousel's Previous arrow sits.
 * </p>
 *
 * <p>
 * <b>The browser found a second, larger fault the arithmetic above does not show.</b> recharts
 * decides whether a tick fits by measuring it in a hidden <code>&lt;span&gt;</code> that
 * inherits the BODY's font size, while drawing it at the axis's 11px — so it was judging every
 * label about 45% too wide and wrapping it onto two lines. "100.00 cr" — a wholly ordinary
 * label, on an ordinary club's chart — rendered as "100.00" above "cr" at the shipped gutter.
 * The fix for that is not a wider number: it is a non-breaking space, which makes the label one
 * token that recharts cannot break wherever it thinks the edge is. See `Charts.tsx`.
 * </p>
 *
 * <p>
 * These remain assertions about numbers — jsdom has no layout — and the widths they check
 * against were measured in a real browser. What stops the constant drifting back is that it is
 * no longer a constant: `creditAxisWidth` derives it from the extremes of the series the chart
 * declares, so a wider label widens the gutter instead of defeating it. The last test here
 * reads those series off the chart's own elements rather than repeating them, so a series
 * added to a chart and not to its width calculation fails rather than silently under-fitting.
 * </p>
 */
describe("a credit axis is as wide as its own numbers", () => {
  /** A club day whose net penalties are a four-figure reversal. Real shape, extreme value. */
  const bigNegative: DailyAdminPoint[] = [
    { date: "2026-09-01", top_ups_credits: 200, booking_charges_credits: 30, refunds_credits: 0, penalties_credits: -1350, adjustments_credits: 0, reversals_credits: 0, net_movement_credits: -1180, bookings: 4, no_shows: 0 },
  ];

  const widthsOf = (chart: ReactNode) =>
    flatten(chart).filter((e) => e.type === YAxis).map((e) => (e.props as { width: number }).width);

  it("fits a four-figure negative, which is what the shipped 64 did not", () => {
    // 61.7px for the widest "-9999.00 cr" shaped label at 11px Figtree, plus the 8px recharts
    // reserves between the plot and the tick text. Measured, not counted from characters.
    expect(widthsOf(DailyFlowBarChart({ data: bigNegative }))[0]).toBeGreaterThanOrEqual(70);
  });

  it("does not narrow the charts that were already right", () => {
    // The floor stays at the measured 64. This is a fix for labels that do not fit, not a
    // licence to reclaim plot width from the ones that do.
    expect(widthsOf(RevenueAreaChart({ data: ADMIN }))[0]).toBe(64);
    expect(creditAxisWidth([0, 45])).toBe(64);
  });

  it("keeps widening past the first label that defeated the old constant", () => {
    // The property that makes this a derivation rather than a bigger magic number: each extra
    // digit buys more room, so the next wider label cannot defeat it either.
    const four = creditAxisWidth([-1350, 200]);
    const five = creditAxisWidth([-13500, 200]);
    const six = creditAxisWidth([-135000, 200]);
    expect(four).toBeGreaterThan(64);
    expect(five).toBeGreaterThan(four);
    expect(six).toBeGreaterThan(five);
  });

  /**
   * The varied setup: the same four-figure reach arriving as a STACK rather than as one bar.
   * `stackOffset="sign"` piles a stack's negatives on top of each other, so an axis sized from
   * the largest single value would be right for the fixture above and wrong here, on data no
   * more unusual than it. Two ordinary-looking days, one axis that has to reach −1460.
   */
  it("reaches the stacked sum, not the largest single bar", () => {
    const stacked: DailyAdminPoint[] = [
      { date: "2026-09-01", top_ups_credits: 160, booking_charges_credits: -760, refunds_credits: 0, penalties_credits: -700, adjustments_credits: 0, reversals_credits: 0, net_movement_credits: -1300, bookings: 2, no_shows: 0 },
    ];
    const width = widthsOf(DailyFlowBarChart({ data: stacked }))[0];
    expect(width).toBe(creditAxisWidth([-1460]));
    // Sized for four figures, though no single series in the fixture reaches them.
    expect(width).toBeGreaterThanOrEqual(70);
  });

  it("allows for the tick recharts rounds UP to, not just the value in the data", () => {
    // A domain ending at 950 is labelled to 1000, which is a digit wider than anything in the
    // series. Reading the data alone would under-fit the axis by exactly one character.
    expect(creditAxisWidth([0, 950])).toBe(creditAxisWidth([0, 1000]));
  });

  it("is computed from every series the chart declares, read off the chart itself", () => {
    // Guards the one drift this design can suffer: a Bar added to a chart whose width
    // calculation is not told about it. The expectation is rebuilt from the elements rather
    // than restated, so the two cannot disagree quietly.
    const charts: [string, ReactNode, Record<string, number>[]][] = [
      ["Daily money flow (club)", DailyFlowBarChart({ data: bigNegative }), bigNegative as unknown as Record<string, number>[]],
      ["Daily money flow (member)", MyFlowBarChart({ data: ME }), ME as unknown as Record<string, number>[]],
      ["Top-ups over time", RevenueAreaChart({ data: ADMIN }), ADMIN as unknown as Record<string, number>[]],
      ["Wallet balance", MyBalanceLineChart({ data: ME }), ME as unknown as Record<string, number>[]],
    ];

    for (const [name, chart, rows] of charts) {
      const series = flatten(chart)
        .filter((e) => e.type === Bar || e.type === Area || e.type === Line)
        .map((e) => e.props as { dataKey: string; stackId?: string });
      expect(series.length, name).toBeGreaterThan(0);

      // Each stack's positives and negatives accumulate separately — `stackOffset="sign"` —
      // so the axis has to reach the stacked sum, not the largest single bar.
      const stacks = new Map<string, string[]>();
      series.forEach((s, i) => {
        const key = s.stackId ?? `solo-${i}`;
        stacks.set(key, [...(stacks.get(key) ?? []), s.dataKey]);
      });

      const extremes: number[] = [];
      for (const row of rows) {
        for (const keys of stacks.values()) {
          const values = keys.map((k) => Number(row[k])).filter(Number.isFinite);
          extremes.push(values.filter((v) => v > 0).reduce((a, b) => a + b, 0));
          extremes.push(values.filter((v) => v < 0).reduce((a, b) => a + b, 0));
        }
      }

      const widths = flatten(chart).filter((e) => e.type === YAxis).map((e) => (e.props as { width: number }).width);
      expect(widths, name).toEqual([creditAxisWidth(extremes)]);
    }
  });
});
