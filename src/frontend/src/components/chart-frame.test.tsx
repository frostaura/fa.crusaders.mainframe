import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { BookingsLineChart, MyFlowBarChart, RevenueAreaChart } from "./Charts";
import type { DailyAdminPoint, DailyMePoint } from "../lib/api";

/**
 * The charts must not shout at the console — including once they have somewhere to draw.
 *
 * <p>
 * `/reports` logged recharts warnings on every page load — "The width(-1) and height(-1) of chart
 * should be greater than 0" — and round 1 answered it by holding the chart back until its frame
 * had a width. That fixed half of it. A headed pass then counted <b>six per load</b> with all
 * three frames reporting `data-measurable="true"` and `clientWidth: 950`: `ResponsiveContainer`
 * defaults `initialDimension` to {-1,-1} and warns on its own first render, before its
 * ResizeObserver has run, so no parent can prevent it by being the right size.
 * </p>
 *
 * <p>
 * That is why this file has two tests and a layout stub. jsdom has no layout, so every element
 * measures zero — which is the off-screen-carousel-slide case and nothing else. The round-1 test
 * lived entirely inside it, never got a frame measurable, and therefore never reached the render
 * that warns: it passed while the defect it names was untouched. `withLayout` gives the elements
 * a size so the second test exercises the path a real browser takes.
 * </p>
 */

const SERIES: DailyAdminPoint[] = [
  { date: "2026-09-01", top_ups_minutes: 100, booking_charges_minutes: 40, refunds_minutes: 0, penalties_minutes: 0, adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: 60, bookings: 4, no_shows: 0 },
  { date: "2026-09-02", top_ups_minutes: 160, booking_charges_minutes: 80, refunds_minutes: 0, penalties_minutes: 5, adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: 75, bookings: 8, no_shows: 1 },
];

const MY_SERIES: DailyMePoint[] = [
  { date: "2026-09-01", top_ups_minutes: 100, spent_minutes: 50, refunds_minutes: 0, bookings: 2, attended: 2, minutes_on_court: 30, balance_minutes: 250 },
  { date: "2026-09-02", top_ups_minutes: 0, spent_minutes: 100, refunds_minutes: 25, bookings: 3, attended: 1, minutes_on_court: 15, balance_minutes: 175 },
];

/**
 * Gives every element a size, the way a browser does and jsdom does not.
 *
 * `clientWidth` is what `ChartFrame` measures; `getBoundingClientRect` is what
 * `ResponsiveContainer`'s own effect reads a beat later. Stubbing only the first leaves the
 * container resetting itself to zero and complaining anyway, which is a jsdom artefact rather
 * than the product's behaviour.
 */
function withLayout(width: number, height: number) {
  const rect = () => ({
    width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;

  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(rect);
}

/** Every console line that is recharts complaining about a non-positive chart size. */
function sizeComplaints(...spies: { mock: { calls: unknown[][] } }[]) {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((args) => args.join(" "))
    .filter((line) => /width\(-?\d+\) and height\(-?\d+\)/.test(line));
}

afterEach(() => vi.restoreAllMocks());

describe("a chart with nowhere to draw", () => {
  it("says nothing to the console", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<><RevenueAreaChart data={SERIES} /><BookingsLineChart data={SERIES} /></>);

    expect(sizeComplaints(warn, error)).toEqual([]);
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

describe("a chart that does have somewhere to draw", () => {
  it("draws, and still says nothing to the console", () => {
    withLayout(950, 240);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // The three a member's /reports renders — the load the six warnings were counted on.
    act(() => {
      render(<>
        <RevenueAreaChart data={SERIES} />
        <BookingsLineChart data={SERIES} />
        <MyFlowBarChart data={MY_SERIES} />
      </>);
    });

    const frames = screen.getAllByTestId("chart-frame");
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      // The gate is open — which is exactly the state the six warnings were measured in.
      expect(frame).toHaveAttribute("data-measurable", "true");
      expect(frame).not.toBeEmptyDOMElement();
    }

    expect(sizeComplaints(warn, error)).toEqual([]);
  });
});
