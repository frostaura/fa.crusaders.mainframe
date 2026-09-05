import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BookingsLineChart, RevenueAreaChart } from "./Charts";
import type { DailyAdminPoint } from "../lib/api";

/**
 * The charts must not shout at the console when they have nowhere to draw.
 *
 * <p>
 * `/reports` logged sixteen recharts warnings on every page load — "The width(-1) and height(-1)
 * of chart should be greater than 0" — because the report charts sit in a carousel whose
 * off-screen slides are laid out at zero width, and `ResponsiveContainer` complains when it
 * cannot measure its parent. Nothing was broken; each chart drew fine once its slide was
 * scrolled to. But `/reports` is the screen an admin opens when they think something is wrong,
 * and a console that is already full is one nobody reads the seventeenth line of.
 * </p>
 *
 * <p>
 * jsdom has no layout, so every container measures zero — which makes it exactly the
 * environment the bug lives in. A chart rendered here either stays quiet or reproduces the
 * defect.
 * </p>
 */

const SERIES: DailyAdminPoint[] = [
  { date: "2026-09-01", top_ups_credits: 100, booking_charges_credits: 40, refunds_credits: 0, penalties_credits: 0, bookings: 4, no_shows: 0 },
  { date: "2026-09-02", top_ups_credits: 160, booking_charges_credits: 80, refunds_credits: 0, penalties_credits: 5, bookings: 8, no_shows: 1 },
];

afterEach(() => vi.restoreAllMocks());

describe("a chart with nowhere to draw", () => {
  it("says nothing to the console", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<><RevenueAreaChart data={SERIES} /><BookingsLineChart data={SERIES} /></>);

    const complaints = [...warn.mock.calls, ...error.mock.calls]
      .map((args) => args.join(" "))
      .filter((line) => /width\(-?\d+\) and height\(-?\d+\)/.test(line));

    expect(complaints).toEqual([]);
  });

  it("holds the chart back rather than drawing into nothing", () => {
    render(<RevenueAreaChart data={SERIES} />);
    // The frame is there, reserving its height so the layout does not jump; the chart inside it
    // is not, because there is nothing to draw into yet.
    const frames = screen.getAllByTestId("chart-frame");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveAttribute("data-measurable", "false");
    expect(frames[0]).toBeEmptyDOMElement();
  });
});
