import { describe, expect, it } from "vitest";
import { isValidElement, type ElementType, type ReactElement, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart } from "recharts";
import type { DailyAdminPoint } from "../lib/api";
import { drawDailyFlow, drawRevenueArea } from "./Charts";
import { paletteNow } from "./ChartFrame";
import { BUCKET_LABELS } from "./wallet/walletBuckets";

/**
 * Review round 14, J14-2: "Sold" on the club's Reports is paid minutes only. The daily report says
 * how much of each day's top-ups the club GAVE (`given_minutes`, a subset); "Minutes sold over
 * time" and the flow chart's sold series draw top-ups less that, and a gift is its own series —
 * only when there was one. Read off the element tree (see `Charts.test.tsx` for why).
 */
type Day = DailyAdminPoint & { given_minutes?: number };

const day = (date: string, topUps: number, given?: number): Day => ({
  date, top_ups_minutes: topUps, booking_charges_minutes: 0, refunds_minutes: 0, penalties_minutes: 0,
  adjustments_minutes: 0, reversals_minutes: 0, share_transfers_minutes: 0, net_movement_minutes: topUps, bookings: 0, no_shows: 0,
  ...(given === undefined ? {} : { given_minutes: given }),
});

function flatten(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement(node)) return [];
  const { children } = node.props as { children?: ReactNode };
  return [node, ...flatten(children)];
}
const propsOf = (tree: ReactElement[], type: ElementType) =>
  tree.filter((e) => e.type === type).map((e) => e.props as Record<string, unknown>);

/** The figure each named series draws on each day, as recharts would read it. */
function series(tree: ReactElement[], chart: ElementType, mark: ElementType): Record<string, number[]> {
  const rows = propsOf(tree, chart)[0].data as Record<string, number>[];
  const out: Record<string, number[]> = {};
  for (const p of propsOf(tree, mark)) out[String(p.name)] = rows.map((r) => r[String(p.dataKey)]);
  return out;
}

describe("J14-2 — the club's sold minutes are paid minutes only", () => {
  const GIVEN = [day("2026-09-01", 120, 45), day("2026-09-02", 60, 0)];
  const NONE = [day("2026-09-01", 120, 0), day("2026-09-02", 60)];

  it("Minutes sold over time draws top-ups less what the club gave", () => {
    const tree = flatten(drawRevenueArea(GIVEN, paletteNow()));
    expect(series(tree, AreaChart, Area)["Minutes sold"]).toEqual([75, 60]);
  });

  it("the flow chart's sold bar is paid only, with the gift as its own series", () => {
    const tree = flatten(drawDailyFlow(GIVEN, paletteNow()));
    const bars = series(tree, BarChart, Bar);
    expect(bars["Minutes sold"]).toEqual([75, 60]);
    expect(bars[BUCKET_LABELS.given]).toEqual([45, 0]);
  });

  it("with nothing given (or an older server) sold is every top-up and no Given series is drawn", () => {
    const area = flatten(drawRevenueArea(NONE, paletteNow()));
    expect(series(area, AreaChart, Area)["Minutes sold"]).toEqual([120, 60]);
    const bars = series(flatten(drawDailyFlow(NONE, paletteNow())), BarChart, Bar);
    expect(bars["Minutes sold"]).toEqual([120, 60]);
    expect(Object.keys(bars)).not.toContain(BUCKET_LABELS.given);
  });
});
