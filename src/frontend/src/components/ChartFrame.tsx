import { ResponsiveContainer } from "recharts";
import { useEffect, useRef, useState } from "react";

/**
 * How tall every chart in this product is drawn. Shared with <c>Charts.tsx</c>, which is the
 * only other file that needs it, so it is stated once here and imported there.
 */
export const CHART_HEIGHT = 240;

type FrameSize = { width: number };

/**
 * The box a chart is drawn in, which does not draw the chart until the box has a size.
 *
 * <p>
 * recharts' <code>ResponsiveContainer</code> measures its parent and, when it cannot, renders
 * nothing and logs <i>"The width(-1) and height(-1) of chart should be greater than 0"</i>. On
 * /reports that happened sixteen times per page load: the report charts live in a carousel whose
 * off-screen slides are laid out at zero width, so every chart that was not the visible slide
 * measured -1 and complained. The charts themselves were fine — they render the moment their
 * slide is scrolled to.
 * </p>
 *
 * <p>
 * Sixteen warnings a load is not a cosmetic problem. /reports is the one screen an admin opens
 * when they think something is wrong, and a console that is already full of red is a console
 * nobody reads the seventeenth line of.
 * </p>
 *
 * <p>
 * Holding the chart back until the box is measurable removes the warning at its cause rather
 * than silencing it, and costs nothing visible: a slide with no width has nothing to show
 * anyway. The height is fixed, so only the width is ever in question.
 * </p>
 *
 * <p>
 * <b>The gate alone was not enough, and the round-1 claim above was false as written.</b> A
 * headed pass counted <i>six warnings per /reports load</i> at the same moment all three frames
 * reported <code>data-measurable="true"</code> and <code>clientWidth: 950</code> — so the gate
 * was open and the complaint was coming from inside <code>ResponsiveContainer</code> anyway.
 * It defaults <code>initialDimension</code> to <code>{-1, -1}</code> and warns on its very first
 * render, before its own ResizeObserver has had a chance to run; no parent can prevent that by
 * being the right size, because the parent is not what it reads on that render. jsdom has no
 * layout, so the round-1 test never got the frame measurable and never reached the render that
 * warns — it passed while the defect was untouched. Handing the container the width the frame
 * has already measured is what closes it: the first render is a real size, and there is no
 * frame with nothing in it to warn about.
 * </p>
 *
 * <p>
 * Worth knowing before deciding this is a development-only annoyance: recharts' own
 * <code>LogUtils</code> hard-codes <code>isDev = true</code> in the published build, so these
 * warnings fire in production too.
 * </p>
 */
export function ChartFrame({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Null until the box has a width; the width it FIRST had once it does. Only the first positive
  // measurement is kept, because after that `ResponsiveContainer`'s own ResizeObserver owns the
  // size — re-rendering the chart on every pixel of a window drag would buy nothing. The state
  // therefore changes only on a null↔sized transition.
  const [frame, setFrame] = useState<FrameSize | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // `width > 0`, never `width <= 0`: lizard reads a bare `<` in a .tsx file as a JSX open tag
    // and swallows the rest of the file into whichever function it was last inside, reporting
    // this one at 268 lines and tripping `-L 200` on a line nobody touched. See memory/gotchas.md.
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
          {children as React.ReactElement}
        </ResponsiveContainer>
      )}
    </div>
  );
}
