import { useEffect, useState, type RefObject } from "react";

/**
 * Whether a top bar may STICK — decided by the room it would take, never by the viewport (R5 X5-1, HIGH).
 *
 * <p>
 * Admin Transactions stuck its filters-and-totals bar from Tailwind's `lg` (1024 CSS px of
 * viewport). At 1280×800 with 200 % text that bar was 665px tall in a 744px scroller, so it stuck
 * and no ledger row was ever on screen. A bar sticks only while it takes at most `max` of its
 * scroller's height; at large text, or on a short window, it scrolls away with the page instead.
 * The bar's height does not depend on whether it sticks, so the answer cannot flip-flop.
 * </p>
 *
 * <p>
 * <b>It publishes its height while it sticks</b> (R5 X5-2) as `--context-bar-top-height` on the
 * root — the twin of the bottom dock's `--context-bar-height` — so the shell's `scroll-padding-top`
 * keeps a focused control clear of it (WCAG 2.4.11) and a table's sticky heads stand under it.
 * </p>
 */
export function useStickyTop(ref: RefObject<HTMLElement | null>, enabled: boolean, max: number): boolean {
  const [sticks, setSticks] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) { setSticks(false); return undefined; }
    const key = Symbol("top-bar");
    const scroller = scrollerOf(el);
    const measure = () => {
      const room = scroller ? scroller.clientHeight : window.innerHeight;
      const height = el.getBoundingClientRect().height;
      const fits = room > 0 && height > 0 && height <= room * max;
      setSticks(fits);
      stuck.set(key, fits ? Math.round(height) : 0);
      publishStuck();
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    if (scroller) observer?.observe(scroller);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      stuck.delete(key);
      publishStuck();
    };
  }, [ref, enabled, max]);
  return sticks;
}

/** The nearest ancestor that scrolls vertically — `<main>` in the shell. Null: the document. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll") return at;
  }
  return null;
}

/** The heights of every stuck top bar on screen; the root variable carries the tallest. */
const stuck = new Map<symbol, number>();

function publishStuck() {
  const tallest = Math.max(0, ...stuck.values());
  const root = document.documentElement;
  if (tallest > 0) root.style.setProperty("--context-bar-top-height", `${tallest}px`);
  else root.style.removeProperty("--context-bar-top-height");
}
