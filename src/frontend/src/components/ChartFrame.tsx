/* eslint-disable react-refresh/only-export-components -- the frame and the palette hook it draws with belong in one module. */
import { ResponsiveContainer } from "recharts";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { activeTheme, chartColors, type ThemeName } from "../lib/tokens";
import { useTheme } from "../lib/theme";

/**
 * How tall every chart in this product is drawn.
 *
 * <p>
 * Module-private: <c>ChartFrame</c> is the only thing that has ever needed it, because the
 * frame is what gives a chart its height in the first place.
 * </p>
 */
const CHART_HEIGHT = 240;

type FrameSize = { width: number };

/**
 * The colours a chart is drawn in, read from the LIVE theme.
 *
 * <p>
 * <b>Why a hook and not a module constant.</b> `Charts.tsx` used to call `chartColors()` once, at
 * module load, and destructure the answer into constants. That was right while the product had
 * one theme and wrong the moment it had two (D7): every chart kept the light palette for the
 * life of the tab, so a member who switched to dark — or whose phone did at sunset — read navy
 * bars and slate gridlines on a navy-black card. The palette is now read on every render, and
 * the chart re-renders when the painted theme changes.
 * </p>
 *
 * <p>
 * <b>Two signals, on purpose.</b> `useTheme()` re-renders on the member's choice, but the
 * provider paints `html.dark` in an EFFECT, which runs after this render has already read the
 * variables — so on that render the document is still in the old theme. The second signal is the
 * document itself: a subscription to `<html>`'s class, which fires once the paint has actually
 * happened and re-reads the palette against it. Either alone is a chart one theme behind.
 * </p>
 */
export type ChartPalette = ReturnType<typeof chartColors>;

function subscribeToPaint(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  return () => observer.disconnect();
}

const serverTheme = (): ThemeName => "light";

/** The chart palette for whichever theme is painted right now. */
export function paletteNow(): ChartPalette {
  return chartColors();
}

export function useChartColors(): ChartPalette {
  useTheme();
  useSyncExternalStore(subscribeToPaint, activeTheme, serverTheme);
  return paletteNow();
}

/**
 * The box a chart is drawn in, which does not draw the chart until the box has a size.
 *
 * <p>
 * recharts' <code>ResponsiveContainer</code> measures its parent and, when it cannot, renders
 * nothing and logs <i>"The width(-1) and height(-1) of chart should be greater than 0"</i>. The
 * report charts live in a carousel whose off-screen slides are laid out at zero width, so every
 * chart that was not the visible slide measured -1 and complained. Holding the chart back until
 * the box is measurable removes the warning at its cause.
 * </p>
 *
 * <p>
 * <b>The gate alone was not enough.</b> <code>ResponsiveContainer</code> defaults
 * <code>initialDimension</code> to <code>{-1, -1}</code> and warns on its very first render,
 * before its own ResizeObserver has run; no parent can prevent that by being the right size.
 * Handing the container the width the frame has already measured is what closes it. recharts'
 * <code>LogUtils</code> hard-codes <code>isDev = true</code> in the published build, so these
 * warnings fired in production too.
 * </p>
 *
 * <p>
 * <b>The chart is a function of the palette</b> (a render prop), so the frame owns the one
 * subscription to the theme and every chart inside it redraws in the new colours together.
 * </p>
 */
export function ChartFrame({ children }: { children: (palette: ChartPalette) => ReactElement }) {
  const ref = useRef<HTMLDivElement>(null);
  const palette = useChartColors();
  // Null until the box has a width; the width it FIRST had once it does. Only the first positive
  // measurement is kept, because after that `ResponsiveContainer`'s own ResizeObserver owns the
  // size. The state therefore changes only on a null↔sized transition.
  const [frame, setFrame] = useState<FrameSize | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // `width > 0`, never `width <= 0`: lizard reads a bare `<` in a .tsx file as a JSX open tag
    // and swallows the rest of the file into whichever function it was last inside.
    const check = () => {
      const width = el.clientWidth;
      setFrame((previous) => (width > 0 ? previous ?? { width } : null));
    };
    check();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", check);
      return () => window.removeEventListener("resize", check);
    }
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} style={{ height: CHART_HEIGHT }} data-testid="chart-frame" data-measurable={frame !== null}>
      {frame && (
        <ResponsiveContainer initialDimension={{ width: frame.width, height: CHART_HEIGHT }}>
          {children(palette)}
        </ResponsiveContainer>
      )}
    </div>
  );
}
