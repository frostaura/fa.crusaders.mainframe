import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Legend } from "recharts";
import {
  drawBookingsLine, drawCourtsRevenue, drawDailyFlow, drawMyBalance, drawMyBookings, drawMyFlow,
  drawNoShowDonut, drawRevenueArea,
} from "./Charts";
import { paletteNow, type ChartPalette } from "./ChartFrame";
import type { DailyAdminPoint, DailyMePoint } from "../lib/api";
import { contrastRatio, themes, type ThemeName } from "../lib/tokens";

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

/** Every element in a chart's tree, depth first — same walk as Charts.test.tsx. */
function flatten(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement(node)) return [];
  const { children } = node.props as { children?: ReactNode };
  return [node, ...flatten(children)];
}

const ADMIN: DailyAdminPoint[] = [
  { date: "2026-09-01", top_ups_minutes: 160, booking_charges_minutes: 24, refunds_minutes: 8, penalties_minutes: 2.4, adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: 141.6, bookings: 3, no_shows: 1 },
];
const ME: DailyMePoint[] = [
  { date: "2026-09-01", top_ups_minutes: 160, spent_minutes: 24, refunds_minutes: 8, bookings: 1, attended: 1, minutes_on_court: 45, balance_minutes: 136 },
];

/** Every chart in the product, by the name a reader would recognise it under. */
const CHARTS: [string, (c: ChartPalette) => ReactNode][] = [
  ["Top-ups over time", (c) => drawRevenueArea(ADMIN, c)],
  ["Daily money flow (club)", (c) => drawDailyFlow(ADMIN, c)],
  ["Bookings & no-shows", (c) => drawBookingsLine(ADMIN, c)],
  ["Revenue by court", (c) => drawCourtsRevenue([{ court_name: "Court 1", kept_minutes: 80, bookings: 4 }], c)],
  ["Show rate", (c) => drawNoShowDonut(10, 2, c)],
  ["Wallet balance", (c) => drawMyBalance(ME, c)],
  ["Daily money flow (member)", (c) => drawMyFlow(ME, c)],
  ["My bookings", (c) => drawMyBookings(ME, c)],
];

/** The palette as the document paints it in `theme`. */
function paletteIn(theme: ThemeName): ChartPalette {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    return paletteNow();
  } finally {
    document.documentElement.classList.remove("dark");
  }
}

describe("chart legends", () => {
  for (const theme of ["light", "dark"] as const) {
    const surface = themes[theme].bg.surface;
    const palette = paletteIn(theme);

    for (const [name, draw] of CHARTS) {
      const legends = flatten(draw(palette)).filter((e) => e.type === Legend);
      if (legends.length === 0) continue;

      it(`${name} (${theme}): every label is set in a colour that clears AA on the card`, () => {
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
          expect(style?.color, `${name} (${theme}) legend has no colour of its own`).toBeTruthy();
          expect(contrastRatio(style!.color!, surface)).toBeGreaterThanOrEqual(AA_BODY);
        }
      });
    }
  }
});
