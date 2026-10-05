import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Area, Bar, AreaChart, BarChart, Line, LineChart, YAxis } from "recharts";
import {
  minuteAxis, drawBookingsLine, drawCourtsRevenue, drawDailyFlow, drawMyBalance, drawMyBookings,
  drawMyFlow, drawRevenueArea,
} from "./Charts";
import { paletteNow } from "./ChartFrame";
import type { DailyAdminPoint, DailyMePoint } from "../lib/api";

/**
 * The plot area has to leave room for the numbers around it.
 *
 * <p>
 * Two things were measured wrong on the live page. The topmost y-axis tick was sliced in half by
 * the SVG's own top edge — the label drawn as a row of half-height digits above an intact
 * one — because the top margin was 8px and a tick is centred on its gridline. And every money
 * tick wrapped onto two lines, because the 48px gutter was narrower than the label and recharts
 * wraps rather than overflows.
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
  { date: "2026-09-01", top_ups_minutes: 160, booking_charges_minutes: 24, refunds_minutes: 8, penalties_minutes: 2, adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: 142, bookings: 3, no_shows: 1 },
];
const ME: DailyMePoint[] = [
  { date: "2026-09-01", top_ups_minutes: 160, spent_minutes: 24, refunds_minutes: 8, bookings: 1, attended: 1, minutes_on_court: 45, balance_minutes: 136 },
];

/** The palette the drawings are handed; geometry does not depend on which theme it is. */
const P = paletteNow();

function flatten(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement(node)) return [];
  const { children } = node.props as { children?: ReactNode };
  return [node, ...flatten(children)];
}

/** Every cartesian chart, and whether its y-axis carries minutes or plain counts. */
const CHARTS: [string, ReactNode, "minutes" | "counts"][] = [
  ["Minutes sold over time", drawRevenueArea(ADMIN, P), "minutes"],
  ["Daily money flow (club)", drawDailyFlow(ADMIN, P), "minutes"],
  ["Bookings & no-shows", drawBookingsLine(ADMIN, P), "counts"],
  ["Minutes kept by court", drawCourtsRevenue([{ court_name: "Court 1", kept_minutes: 80, bookings: 4 }], P), "minutes"],
  ["Wallet balance", drawMyBalance(ME, P), "minutes"],
  ["Daily money flow (member)", drawMyFlow(ME, P), "minutes"],
  ["My bookings", drawMyBookings(ME, P), "counts"],
];

/** The floor a minutes axis is given ("45 min" is 37px at 12px Figtree, plus the 8px tick gap). */
const MINUTE_GUTTER = 40;

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
        expect(props.width).toBeGreaterThanOrEqual(axis === "minutes" ? MINUTE_GUTTER : 32);
      }
    });
  }
});

/**
 * The gutter has to fit the widest label THIS chart's data can produce, not the widest one
 * anybody happened to have on screen the day it was set.
 *
 * <p>
 * The history: 64px was measured against one label and shipped as a constant, and the constant
 * was the defect — the signed charts plot <b>net</b> series, net goes four figures negative on
 * any day whose penalty rows are reversals of an earlier day's sweep, and that label did not
 * fit. recharts anchors a left axis's tick text at <code>width − tickSize − tickMargin</code>,
 * so it overhung the chart's own left edge, which is where the carousel's Previous arrow sits.
 * And recharts measures a tick in a hidden span at the BODY's font size, so it wrapped labels
 * it judged too wide — the fix for that is a non-breaking space between every part.
 * </p>
 *
 * <p>
 * P13: the ticks are minutes now ("1 h 30 min", "−1 d"), so the width is the widest TICK LABEL
 * the axis will draw, costed glyph by glyph from widths measured in Chromium at the axis's
 * 12px Figtree. The widths below are those measurements; `e2e/chart-axis-labels` is the proof
 * in a real browser.
 * </p>
 */
describe("a minutes axis is as wide as its own labels", () => {
  /** A club day whose net penalties are a four-figure reversal. Real shape, extreme value. */
  const bigNegative: DailyAdminPoint[] = [
    { date: "2026-09-01", top_ups_minutes: 200, booking_charges_minutes: 30, refunds_minutes: 0, penalties_minutes: -1350, adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: -1180, bookings: 4, no_shows: 0 },
  ];

  const widthsOf = (chart: ReactNode) =>
    flatten(chart).filter((e) => e.type === YAxis).map((e) => (e.props as { width: number }).width);

  /** Measured with getComputedTextLength at 12px Figtree 400 (P13, 2026-10-01), plus the 8px gap. */
  const MEASURED = { "1 h 30 min": 54.45, "−16 h": 32.6, "45 min": 37 } as const;
  const GAP = 8;

  it("fits the widest label it draws, measured, not counted from characters", () => {
    // 0 to 100 minutes ticks every half hour, so "1 h 30 min" is on the axis.
    expect(minuteAxis([0, 100]).ticks).toContain(90);
    expect(minuteAxis([0, 100]).width).toBeGreaterThanOrEqual(Math.ceil(MEASURED["1 h 30 min"] + GAP));
    // A four-figure negative net: ticks down to −1 d, through −16 h.
    expect(minuteAxis([-1350, 200]).ticks).toContain(-960);
    expect(widthsOf(drawDailyFlow(bigNegative, P))[0]).toBeGreaterThanOrEqual(Math.ceil(MEASURED["−16 h"] + GAP));
  });

  it("never goes under the floor, and does not waste the plot's width on short labels", () => {
    // Every digit is costed as the widest, so a short label gets a few pixels of slack — no more.
    expect(minuteAxis([0, 45]).width).toBeGreaterThanOrEqual(Math.ceil(MEASURED["45 min"] + GAP));
    expect(minuteAxis([0, 45]).width).toBeLessThanOrEqual(Math.ceil(MEASURED["45 min"] + GAP) + 4);
    expect(minuteAxis([0, 1]).width).toBeGreaterThanOrEqual(40);
    // An upper bound, but a tight one: no more than a digit's slack over what was measured.
    expect(minuteAxis([0, 100]).width).toBeLessThanOrEqual(Math.ceil(MEASURED["1 h 30 min"] + GAP) + 8);
  });

  it("widens when the labels get wider, so the next wider label cannot defeat it", () => {
    const quarterHours = minuteAxis([0, 45]).width;
    const halfHours = minuteAxis([0, 100]).width;
    expect(halfHours).toBeGreaterThan(quarterHours);
  });

  /**
   * The varied setup: the same four-figure reach arriving as a STACK rather than as one bar.
   * `stackOffset="sign"` piles a stack's negatives on top of each other, so an axis sized from
   * the largest single value would be right for the fixture above and wrong here, on data no
   * more unusual than it. Two ordinary-looking bars, one axis that has to reach −1460.
   */
  it("reaches the stacked sum, not the largest single bar", () => {
    const stacked: DailyAdminPoint[] = [
      { date: "2026-09-01", top_ups_minutes: 160, booking_charges_minutes: -760, refunds_minutes: 0, penalties_minutes: -700, adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: -1300, bookings: 2, no_shows: 0 },
    ];
    const axis = flatten(drawDailyFlow(stacked, P)).find((e) => e.type === YAxis)!.props as { width: number; domain: number[] };
    expect(axis.width).toBe(minuteAxis([-1460, 160]).width);
    // Reaches the stack, though no single series in the fixture does.
    expect(axis.domain[0]).toBeLessThanOrEqual(-1460);
  });

  it("allows for the tick it rounds UP to, not just the value in the data", () => {
    // A series topping out at 950 is ticked to 960 (a step of 4 h); the label drawn is the
    // tick's, so the width is costed from the ticks, not from the data.
    const axis = minuteAxis([0, 950]);
    expect(axis.ticks[axis.ticks.length - 1]).toBeGreaterThanOrEqual(950);
    expect(axis.domain[1]).toBe(axis.ticks[axis.ticks.length - 1]);
  });

  it("is computed from every series the chart declares, read off the chart itself", () => {
    // Guards the one drift this design can suffer: a Bar added to a chart whose width
    // calculation is not told about it. The expectation is rebuilt from the elements rather
    // than restated, so the two cannot disagree quietly.
    // The rows are the ones the chart DRAWS (its own `data`), not the fixture handed in — a chart
    // may derive series from them (R14 J14-2: "sold" is top-ups less given).
    const charts: [string, ReactNode][] = [
      ["Daily money flow (club)", drawDailyFlow(bigNegative, P)],
      ["Daily money flow (member)", drawMyFlow(ME, P)],
      ["Minutes sold over time", drawRevenueArea(ADMIN, P)],
      ["Wallet balance", drawMyBalance(ME, P)],
    ];

    for (const [name, chart] of charts) {
      const rows = (chart as ReactElement<{ data: Record<string, number>[] }>).props.data;
      expect(rows.length, name).toBeGreaterThan(0);
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
      expect(widths, name).toEqual([minuteAxis(extremes).width]);
    }
  });
});
