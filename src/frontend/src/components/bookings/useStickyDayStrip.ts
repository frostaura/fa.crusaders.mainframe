import { useLayoutEffect, useRef, useState, type RefObject } from "react";

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

/**
 * §4.2 (Dean's call, R7) — on a phone Bookings OPENS with the week at the top of the page, so the
 * first bookable row is on the first screen (y 555 → ~300 at 390). Nothing is removed: the games
 * strip, the invites and the notices stay where they were, one swipe up. The grid's own scroller
 * already opens at the first live row (`BookingGrid` `useBoardScroll`); this moves the PAGE.
 *
 * <ul>
 *   <li>Once per visit, when the day first draws — never on a re-read or a day change, which
 *   would yank the page out from under a member who scrolled.</li>
 *   <li>Only from the top: a member who already scrolled (or a restored position) is left alone.</li>
 *   <li>Only on a phone (the strip's own width rule); a desktop opens at the top.</li>
 *   <li>Any day — today or a date the member asked for in the address.</li>
 * </ul>
 */
export function useOpenAtWeek(ref: RefObject<HTMLElement | null>, ready: boolean): void {
  const done = useRef(false);
  useLayoutEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    const el = ref.current;
    const main = el?.closest("main");
    if (!el || !main || window.innerWidth > PHONE_MAX_PX || main.scrollTop > 0) return;
    const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top;
    if (top > 0) main.scrollTop = top;
  }, [ready, ref]);
}
