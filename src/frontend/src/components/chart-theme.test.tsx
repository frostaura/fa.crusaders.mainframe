import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Tooltip } from "recharts";
import { MyFlowBarChart, drawDailyFlow } from "./Charts";
import { paletteNow, useChartColors } from "./ChartFrame";
import { ThemeProvider, useTheme } from "../lib/theme";
import { themes } from "../lib/tokens";
import type { DailyAdminPoint, DailyMePoint } from "../lib/api";

/**
 * The charts follow the theme that is PAINTED, not the one the tab opened in (D7).
 *
 * <p>
 * `Charts.tsx` read `chartColors()` once, at module load, and kept the answer in constants. With
 * one theme that was harmless; with two it froze every chart in the palette of whichever theme
 * the page happened to load under — navy bars and slate gridlines on the dark card, and a white
 * tooltip slab over them. These tests hold the three halves of the fix: the palette is read at
 * render, a theme change re-renders the chart, and the parts recharts paints by default
 * (tooltip surface, its rows, the hover band) take the theme's own roles.
 * </p>
 */

const ME: DailyMePoint[] = [
  { date: "2026-09-01", top_ups_minutes: 100, spent_minutes: 50, refunds_minutes: 10, bookings: 2, attended: 2, minutes_on_court: 30, balance_minutes: 250 },
];
const ADMIN: DailyAdminPoint[] = [
  { date: "2026-09-01", top_ups_minutes: 160, booking_charges_minutes: 24, refunds_minutes: 8, penalties_minutes: 2, adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: 142, bookings: 3, no_shows: 1 },
];

afterEach(() => {
  document.documentElement.classList.remove("dark");
  try { window.localStorage.removeItem("crusaders:theme"); } catch { /* storage refused */ }
  vi.restoreAllMocks();
});

function Probe() {
  const c = useChartColors();
  return <output aria-label="accent">{c.accent}</output>;
}

function flatten(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement(node)) return [];
  const { children } = node.props as { children?: ReactNode };
  return [node, ...flatten(children)];
}

describe("chart colours and the theme", () => {
  it("are not resolved at module load", () => {
    // The palette arrives from the frame on every render; nothing in the chart module may read
    // it into a constant again.
    const source = readFileSync(join(__dirname, "Charts.tsx"), "utf8");
    expect(source).not.toMatch(/chartColors\s*\(/);
  });

  it("re-read when the document is repainted, without a provider", async () => {
    render(<Probe />);
    expect(screen.getByLabelText("accent")).toHaveTextContent(themes.light.accent.strong);

    act(() => { document.documentElement.classList.add("dark"); });
    await waitFor(() => expect(screen.getByLabelText("accent")).toHaveTextContent(themes.dark.accent.strong));

    act(() => { document.documentElement.classList.remove("dark"); });
    await waitFor(() => expect(screen.getByLabelText("accent")).toHaveTextContent(themes.light.accent.strong));
  });

  it("follow the member's choice through the provider — after the provider has painted it", async () => {
    function Chooser() {
      const { setTheme } = useTheme();
      return (
        <>
          <button type="button" onClick={() => setTheme("dark")}>Dark</button>
          <button type="button" onClick={() => setTheme("light")}>Light</button>
        </>
      );
    }
    render(<ThemeProvider><Chooser /><Probe /></ThemeProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    await waitFor(() => expect(screen.getByLabelText("accent")).toHaveTextContent(themes.dark.accent.strong));
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    await waitFor(() => expect(screen.getByLabelText("accent")).toHaveTextContent(themes.light.accent.strong));
  });

  it("paint the tooltip on the theme's raised surface, in body text, in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      const tooltip = flatten(drawDailyFlow(ADMIN, paletteNow())).find((e) => e.type === Tooltip)!;
      const props = tooltip.props as {
        contentStyle: { background: string; color: string; border: string };
        itemStyle: { color: string };
        cursor: { fill: string; stroke: string };
      };
      expect(props.contentStyle.background, theme).toBe(themes[theme].bg.raised);
      expect(props.contentStyle.color, theme).toBe(themes[theme].text.primary);
      expect(props.contentStyle.border, theme).toContain(themes[theme].border);
      // Rows in body text, not each series' own colour — a soft series' row was a ghost.
      expect(props.itemStyle.color, theme).toBe(themes[theme].text.primary);
      expect(props.cursor.fill, theme).toBe(themes[theme].border);
      expect(props.cursor.stroke, theme).toBe(themes[theme].border);
    }
  });

  it("redraws a chart that is already on screen in the new theme's colours", async () => {
    // A size, so the frame opens and recharts draws real bars — see chart-frame.test.tsx.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      width: 600, height: 240, top: 0, left: 0, right: 600, bottom: 240, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container } = render(<MyFlowBarChart data={ME} />);
    // Every painted fill in the chart — jsdom draws the legend swatches (the series colours)
    // and the axis ticks even where it cannot lay the bars out.
    const fills = () => [...container.querySelectorAll("[fill]")].map((el) => el.getAttribute("fill"));

    await waitFor(() => expect(fills()).toContain(themes.light.accent.strong));

    act(() => { document.documentElement.classList.add("dark"); });
    await waitFor(() => expect(fills()).toContain(themes.dark.accent.strong));
    expect(fills()).not.toContain(themes.light.accent.strong);
    // The axis ticks too: the muted role, in the painted theme.
    expect(fills()).toContain(themes.dark.text.muted);
  });
});
