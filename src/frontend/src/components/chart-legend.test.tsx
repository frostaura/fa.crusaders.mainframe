import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Legend } from "recharts";
import {
  BookingsLineChart, CourtsRevenueBarChart, DailyFlowBarChart, MyBalanceLineChart,
  MyBookingsBarChart, MyFlowBarChart, NoShowDonut, RevenueAreaChart,
} from "./Charts";
import type { DailyAdminPoint, DailyMePoint } from "../lib/api";

/**
 * Every legend label on /reports has to be readable.
 *
 * <p>
 * Two of the five were not. recharts paints a legend label in that series' own colour, and the
 * two series drawn with a <i>soft</i> fill — "Refunds (net)" on `success.soft`, "Booked" on
 * `accent.soft` — therefore had their labels painted in it too: measured from the live page at
 * <b>1.10:1 and 1.15:1 on white</b>, against the 4.5:1 body-text floor
 * `docs/specs/design-system.md` commits to. "Booked" was a pale ghost beside a legible "Played",
 * at 1440, 768 and 375, and there is only one theme so there was nowhere for it to be readable.
 * </p>
 *
 * <p>
 * The measurement is the same WCAG 2.1 arithmetic `tokens.test.ts` uses on the palette. It runs
 * over every chart the product renders rather than the two that were wrong, because the defect
 * was not two bad constants — it was a rule that had to be remembered per series.
 * </p>
 */

const AA_BODY = 4.5;
const WHITE = "#FFFFFF";

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channel = (offset: number) => {
    const raw = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every element in a chart's tree, depth first — same walk as Charts.test.tsx. */
function flatten(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement(node)) return [];
  const { children } = node.props as { children?: ReactNode };
  return [node, ...flatten(children)];
}

const ADMIN: DailyAdminPoint[] = [
  { date: "2026-09-01", top_ups_credits: 160, booking_charges_credits: 24, refunds_credits: 8, penalties_credits: 2.4, adjustments_credits: 0, reversals_credits: 0, net_movement_credits: 141.6, bookings: 3, no_shows: 1 },
];
const ME: DailyMePoint[] = [
  { date: "2026-09-01", top_ups_credits: 160, spent_credits: 24, refunds_credits: 8, bookings: 1, attended: 1, minutes_on_court: 45, balance_credits: 136 },
];

/** Every chart in the product, by the name a reader would recognise it under. */
const CHARTS: [string, ReactNode][] = [
  ["Top-ups over time", RevenueAreaChart({ data: ADMIN })],
  ["Daily money flow (club)", DailyFlowBarChart({ data: ADMIN })],
  ["Bookings & no-shows", BookingsLineChart({ data: ADMIN })],
  ["Revenue by court", CourtsRevenueBarChart({ data: [{ court_name: "Court 1", revenue_credits: 80, bookings: 4 }] })],
  ["Show rate", NoShowDonut({ total: 10, noShow: 2 })],
  ["Wallet balance", MyBalanceLineChart({ data: ME })],
  ["Daily money flow (member)", MyFlowBarChart({ data: ME })],
  ["My bookings", MyBookingsBarChart({ data: ME })],
];

describe("chart legends", () => {
  for (const [name, chart] of CHARTS) {
    const legends = flatten(chart).filter((e) => e.type === Legend);
    if (legends.length === 0) continue;

    it(`${name}: every label is set in a colour that clears AA on the card`, () => {
      for (const legend of legends) {
        const { formatter } = legend.props as {
          formatter?: (value: string, entry: unknown, index: number) => ReactNode;
        };

        // A legend with no formatter falls back to the series colour, which is how the two
        // soft-filled series ended up at 1.1:1. This is the assertion that stops a NEW chart
        // reintroducing it.
        expect(formatter, `${name} renders its legend labels in the series colour`).toBeTypeOf("function");

        const rendered = formatter!("Refunds (net)", {}, 0);
        expect(isValidElement(rendered)).toBe(true);

        const { style, children } = (rendered as ReactElement).props as {
          style?: { color?: string };
          children?: ReactNode;
        };
        // The label text itself must survive the wrapping — a formatter that dropped it would
        // pass a colour check and show an empty legend.
        expect(children).toBe("Refunds (net)");
        expect(contrast(style?.color ?? WHITE, WHITE)).toBeGreaterThanOrEqual(AA_BODY);
      }
    });
  }
});
