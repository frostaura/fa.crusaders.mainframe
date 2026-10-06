import { useLayoutEffect, type RefObject } from "react";

/** The custom property a fill scroller reads (set on the scroller itself, in px). */
export const FILL_ROOM_VAR = "--fill-room";

/**
 * A scroller that FILLS what is left of the shell's scroller (`<main>`) below its own top, so the
 * page holds still and only the scroller moves (Dean, 2026-10: "the booking grid should take the
 * space it can and be scrollable — a scrollable parent page too makes for a jumpy UI").
 *
 * <p>
 * Measured, not a chain of `flex-1 min-h-0`: the grid sits under a page header, a rail, a day
 * picker and notices that grow and fold on their own, and threading a fill through every wrapper
 * between `<main>` and the scroller is how a later wrapper silently breaks it. What is measured is
 * the scroller's top inside `<main>`'s content and `<main>`'s own height less its bottom padding
 * (the phone's tab bar and any docked bar, which the shell already adds there), so the scroller's
 * foot lands `reserveBelow` px above the foot of `<main>` and `<main>` has nothing left to scroll.
 * `<main>` is `100%` of the root, which follows the dynamic viewport, so iOS's collapsing toolbars
 * re-measure rather than jump.
 * </p>
 *
 * <p>
 * The caller decides the floor (`max(<floor>, var(--fill-room))`): on a very short viewport (a
 * landscape phone, ~360 px tall) the room left can be a slit, so the scroller keeps its floor and
 * ONLY then does the page scroll to reach the rest of it.
 * </p>
 */
export function useFillHeight(ref: RefObject<HTMLElement | null>, reserveBelow: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    const main = el?.closest<HTMLElement>("main");
    if (!el || !main) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      const padBottom = parseFloat(getComputedStyle(main).paddingBottom) || 0;
      const room = Math.floor(main.clientHeight - padBottom - top - reserveBelow);
      el.style.setProperty(FILL_ROOM_VAR, `${room}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    // What moves the scroller's top or <main>'s foot: the window, <main> itself, and anything in
    // the page above (notices, the rail strip, the header's actions) — the page's root box grows.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(main);
    const page = main.firstElementChild;
    if (page) observer?.observe(page);
    const shell = el.closest("[data-page-shell]");
    if (shell) observer?.observe(shell);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      el.style.removeProperty(FILL_ROOM_VAR);
    };
  }, [ref, reserveBelow]);
}
