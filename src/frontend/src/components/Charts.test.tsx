import { describe, expect, it } from "vitest";
import { isValidElement, type ElementType, type ReactElement, type ReactNode } from "react";
import { Bar, BarChart, ReferenceLine, YAxis } from "recharts";
import type { DailyAdminPoint, DailyMePoint } from "../lib/api";
import { drawDailyFlow, drawMyFlow, SIGNED_DOMAIN, signedFloor } from "./Charts";
import { paletteNow } from "./ChartFrame";

/**
 * The money charts, on the day a bucket goes negative.
 *
 * <p>
 * Settlement-model I11 posts a correction as a new row of the same type with the
 * opposite sign, never as an edit — so `refunds_minutes` and `penalties_minutes` are
 * <b>net</b>, and a day is negative whenever a reversal lands in a different day's
 * bucket from the sweep it reverses. That is the netting working; the API is right and
 * stays. What has to hold is on this side: the axis must be able to go under zero, the
 * zero line must be visible, and the legend must not call a net figure a gross one.
 * </p>
 *
 * <p>
 * These assertions read the chart's element tree rather than its pixels. Recharts'
 * `ResponsiveContainer` measures itself with a `ResizeObserver`, which jsdom does not
 * implement, so a rendered chart here is a 0×0 box with nothing in it — a test against
 * the DOM would pass whatever the props said. The tree is where the decision actually
 * lives.
 * </p>
 */
describe("Charts — net series and the sign of a day", () => {
  const ADMIN_DAYS: DailyAdminPoint[] = [
    // Tuesday: the sweep. Wednesday: the box's upload lands and the sweep is reversed,
    // so the penalty bucket for Wednesday is the reversal alone, and negative.
    { date: "2026-09-01", top_ups_minutes: 160, booking_charges_minutes: 24, refunds_minutes: 8, penalties_minutes: 2.4, adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: 141.6, bookings: 3, no_shows: 1 },
    { date: "2026-09-02", top_ups_minutes: 0, booking_charges_minutes: 0, refunds_minutes: -8, penalties_minutes: -2.4, adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: -5.6, bookings: 0, no_shows: 0 },
  ];

  // `attended` and `minutes_on_court` come off `CheckedInAt`, the attendance source of
  // truth: Tuesday she booked three quarter-hours and turned up; Wednesday she booked
  // nothing. A booked-but-not-attended day is what the second bar exists to show.
  const ME_DAYS: DailyMePoint[] = [
    { date: "2026-09-01", top_ups_minutes: 160, spent_minutes: 24, refunds_minutes: 8, bookings: 1, attended: 1, minutes_on_court: 45, balance_minutes: 136 },
    { date: "2026-09-02", top_ups_minutes: 0, spent_minutes: 0, refunds_minutes: -8, bookings: 0, attended: 0, minutes_on_court: 0, balance_minutes: 128 },
  ];

  /** Every element in a chart's tree, depth first. */
  function flatten(node: ReactNode): ReactElement[] {
    if (Array.isArray(node)) return node.flatMap(flatten);
    if (!isValidElement(node)) return [];
    const { children } = node.props as { children?: ReactNode };
    return [node, ...flatten(children)];
  }

  /** The props of every element of one recharts type in the tree. */
  const propsOf = (tree: ReactElement[], type: ElementType) =>
    tree.filter((e) => e.type === type).map((e) => e.props as Record<string, unknown>);

  describe("signedFloor", () => {
    it("drops below zero exactly as far as the data does, and never above it", () => {
      // The one that matters: a negative net penalty has to be inside the domain, or the
      // bar is drawn off the bottom of the plot and the day silently reads as empty.
      expect(signedFloor(-2.4)).toBe(-3);
      expect(signedFloor(-30)).toBe(-30);

      // An all-positive window keeps a zero baseline. Floating the floor up to the data
      // minimum would make every bar's length a lie.
      expect(signedFloor(0)).toBe(0);
      expect(signedFloor(120)).toBe(0);

      // Recharts hands the axis whatever the data gave it. An empty window and a bad row
      // both arrive here as a non-number, and neither is a reason to produce NaN — which
      // recharts rejects as a malformed domain and replaces with the data's own, so the
      // failure would be invisible until a chart was inspected by eye.
      expect(signedFloor(NaN)).toBe(0);
      expect(signedFloor(Infinity)).toBe(0);
    });
  });

  it("gives the club's flow chart a signed floor, a zero line, and a net penalty series", () => {
    const tree = flatten(drawDailyFlow(ADMIN_DAYS, paletteNow()));

    // The y-axis floor is ours, not recharts' default `[0, 'auto']`.
    expect(propsOf(tree, YAxis)[0].domain).toBe(SIGNED_DOMAIN);

    // A solid line at zero, so a bar hanging under it reads as a reversal.
    expect(propsOf(tree, ReferenceLine)).toEqual([expect.objectContaining({ y: 0 })]);

    // `stackOffset="sign"` is what puts the negative part of a stack below the line
    // instead of subtracting it from the positive part.
    expect(propsOf(tree, BarChart)[0].stackOffset).toBe("sign");

    // Legend and tooltip both read this name. "Penalties" alone invites the reader to
    // treat 2.40 on Tuesday and -2.40 on Wednesday as an error rather than as one
    // penalty that was charged and then given back.
    const bars = propsOf(tree, Bar);
    expect(bars.find((b) => b.dataKey === "penalties_minutes")?.name).toBe("Penalties (net)");
    expect(bars.find((b) => b.dataKey === "top_ups_minutes")?.name).toBe("Top-ups");
  });

  it("gives the member's flow chart the same treatment for refunds", () => {
    const tree = flatten(drawMyFlow(ME_DAYS, paletteNow()));

    expect(propsOf(tree, YAxis)[0].domain).toBe(SIGNED_DOMAIN);
    expect(propsOf(tree, ReferenceLine)).toEqual([expect.objectContaining({ y: 0 })]);
    expect(propsOf(tree, BarChart)[0].stackOffset).toBe("sign");

    // A member whose no-show was reversed the next day sees the refund taken back on the
    // day the evidence landed. That is what happened to them, and the label says so.
    const bars = propsOf(tree, Bar);
    expect(bars.find((b) => b.dataKey === "refunds_minutes")?.name).toBe("Refunds (net)");
    expect(bars.find((b) => b.dataKey === "spent_minutes")?.name).toBe("Spent");
  });
});
