import { useLayoutEffect, useState, type RefObject } from "react";

/** Below this viewport width the day strip sticks (the grid's `md:` — a phone). */
const PHONE_MAX_PX = 767;
/** The most of the page's scroller the strip may cover and still stick (X5-1's rule: by room). */
const MAX_SHARE = 0.4;
const VAR = "--day-strip-height";

/**
 * R5 §4.2 / SPEC 3.1 — on a phone the week strip sticks under the app bar, so the day stays in
 * view while the member scrolls the games away and works the grid. By ROOM, not only by width:
 * a strip taller than 40 % of `<main>` (200 % text on a short phone) does not stick at all.
 *
 * <p>
 * While it sticks it publishes its height as `--day-strip-height`, which the grid's scroller
 * takes off its own height (`BookingGrid`), so at the page's end the grid's court header sits
 * right under the strip rather than behind it.
 * </p>
 */
export function useStickyDayStrip(ref: RefObject<HTMLElement | null>): boolean {
  const [sticks, setSticks] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return undefined;
    const root = document.documentElement;
    const measure = () => {
      const scroller = el.closest("main") ?? root;
      const fits = window.innerWidth <= PHONE_MAX_PX && el.offsetHeight <= scroller.clientHeight * MAX_SHARE;
      setSticks(fits);
      if (fits) root.style.setProperty(VAR, `${el.offsetHeight}px`);
      else root.style.removeProperty(VAR);
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      root.style.removeProperty(VAR);
    };
  }, [ref]);
  return sticks;
}
