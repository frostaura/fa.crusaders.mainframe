import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { AreaChart, BarChart, LineChart, YAxis } from "recharts";
import {
  BookingsLineChart, CourtsRevenueBarChart, DailyFlowBarChart, MyBalanceLineChart,
  MyBookingsBarChart, MyFlowBarChart, RevenueAreaChart,
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
