import { useCallback, useLayoutEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

/**
 * Whether a `SplitView`'s box is wide enough to split — measured the SAME way its container query
 * decides (the box's own width against `splitAt` in rem, so 200 % text stacks it), and kept live
 * as the box changes.
 *
 * <p>
 * <b>Why a page needs this (R5 X5-3).</b> Inbox and Invites chose "open in the pane beside the
 * list" by the viewport (`useMediaQuery(lg)`) while the split view stacked by its box. At large
 * text on a desktop the two disagreed: a pick opened in a pane the split view had stacked away,
 * the list vanished, focus fell to `<body>` with no way back, and the URL was replaced so Back left
 * the page. The page and the split view now read one measure: pass the result to `SplitView`'s
 * `layout` and decide "pick in place or go to the page" from `split`.
 * </p>
 *
 * <p>
 * Before the first measure (and with no layout engine, as in jsdom) it answers `false` — stacked,
 * the phone's behaviour — and the measure runs in a layout effect, so no frame paints the wrong one.
 * </p>
 */
export type SplitAt = "48rem" | "56rem" | "64rem";

export type SplitLayout = {
  /** A callback ref for the split view's box (`SplitView` attaches it when given this object). */
  attach: (el: HTMLElement | null) => void;
  /** The box is at least `splitAt` wide: list and detail side by side. */
  split: boolean;
};

function rootFontPx(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

/** `96rem` is not a SplitView width: My Code's three full columns at 1920 read the same measure (R6). */
export function useSplitLayout(splitAt: SplitAt | "96rem"): SplitLayout {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [split, setSplit] = useState(false);
  const attach = useCallback((next: HTMLElement | null) => setEl(next), []);
  useLayoutEffect(() => {
    if (!el) return undefined;
    const rem = Number.parseFloat(splitAt);
    const measure = () => setSplit(el.getBoundingClientRect().width >= rem * rootFontPx());
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    // The text size can change while the box keeps its width (a capped page): a 1rem probe
    // resizes with the root font, and is measured too.
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;width:1rem;height:0;top:0;left:0";
    document.body.appendChild(probe);
    observer?.observe(probe);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      probe.remove();
      window.removeEventListener("resize", measure);
    };
  }, [el, splitAt]);
  return { attach, split };
}

/** Set on a history entry that a pick pushed from the bare list: Back (or the back control) pops it. */
const PICKED_FROM_LIST = "splitPickedFromList";

/**
 * The picked item kept in the URL (`?n=`, `?seat=`) — R5 X5-3: a pick made from the bare list
 * PUSHES a history entry, so the phone's Back (or the stacked view's back control) returns to the
 * list instead of leaving the page; switching from one picked item to another replaces it, so Back
 * never walks through every row looked at.
 */
export function usePickParam(name: string): { value: string | null; pick: (value: string) => void; unpick: () => void } {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const value = params.get(name);
  const fromList = value === null;
  const state: unknown = location.state;
  const pushed = typeof state === "object" && state !== null && (state as Record<string, unknown>)[PICKED_FROM_LIST] === true;
  const pick = useCallback((next: string) => {
    setParams((was) => { const p = new URLSearchParams(was); p.set(name, next); return p; }, fromList
      ? { state: { [PICKED_FROM_LIST]: true } }
      : { replace: true, state });
  }, [setParams, name, fromList, state]);
  const unpick = useCallback(() => {
    if (pushed) { navigate(-1); return; }
    setParams((was) => { const p = new URLSearchParams(was); p.delete(name); return p; }, { replace: true });
  }, [pushed, navigate, setParams, name]);
  return { value, pick, unpick };
}
