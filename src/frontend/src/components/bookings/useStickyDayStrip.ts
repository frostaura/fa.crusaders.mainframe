import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

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
 *   <li>R8 J8-3 — `keepInView` (the desk's "Booking for … · can spend" bar) is never scrolled
 *   past: the page opens at whichever of it and the week comes first.</li>
 *   <li>R8 X8-1 — it never fights keyboard focus. Focus the person put inside the page (a Tab, the
 *   skip link) cancels the scroll; the route announcer's focus on the page's heading — which the
 *   scroll would leave under the app bar, where the first Tab scrolled the page back to the top —
 *   is handed to the week the page opened at, for as long as the announcer may still land it.</li>
 * </ul>
 */
export function useOpenAtWeek(ref: RefObject<HTMLElement | null>, ready: boolean, keepInView: string | null = null): void {
  const done = useRef(false);
  const release = useRef<(() => void) | null>(null);
  const touched = useTakeOverBeforeDraw(ref);
  useEffect(() => () => { release.current?.(); }, []);
  useLayoutEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    const el = ref.current;
    const main = el?.closest("main");
    if (!el || !main || window.innerWidth > PHONE_MAX_PX || touched.current || focusedByHand(main)) return;
    const anchor = keepInView ? main.querySelector<HTMLElement>(keepInView) : null;
    // R9 J8-3/X8-1 rest — measured in the scroller's own content, not from where it sits now: an
    // in-app arrival (the member page's "Book for member", scrolled to reach the link) left <main>
    // at the last page's scroll (980px at 320 / 200 %), and "only from the top" then skipped the
    // whole opening — the bar 650px above the screen and focus on a heading under the app bar.
    const from = main.getBoundingClientRect().top - main.scrollTop;
    const top = Math.max(0, Math.min(el.getBoundingClientRect().top, anchor ? anchor.getBoundingClientRect().top : Infinity) - from);
    main.scrollTop = top;
    if (top <= 0) return;
    const unpin = pinWhileSettling(main, anchor ?? el);
    const unhand = handHeadingFocusToWeek(main, el, anchor);
    release.current = () => { unpin(); unhand(); };
  }, [ready, ref, keepInView, touched]);
}

/**
 * Whether a person took the page over (wheel, touch, pointer, key) while it was still drawing —
 * the only scroll the opening must leave alone. A scroll already on `<main>` when the page draws
 * is NOT that: the scroller is shared by every page, so it is the previous page's.
 */
function useTakeOverBeforeDraw(ref: RefObject<HTMLElement | null>) {
  const touched = useRef(false);
  useEffect(() => {
    const main = ref.current?.closest("main");
    if (!main) return undefined;
    const mark = () => { touched.current = true; };
    for (const type of TAKE_OVER) main.addEventListener(type, mark, { passive: true });
    return () => { for (const type of TAKE_OVER) main.removeEventListener(type, mark); };
  }, [ref]);
  return touched;
}

/** How long the page may still grow above the week after it draws (the freshness line, the bar's figures). */
const SETTLE_MS = 2000;
/** A person taking the page over: from then on its scroll is theirs. */
const TAKE_OVER = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * J8-3 — what the page opened at stays in view while the page above it settles: the header's
 * freshness line and the bar's own figures land after the scroll, and the browser's scroll
 * anchoring kept a node further down still, so the bar slid 19px under the app bar. Only ever
 * brings `target` back down to the top edge; stops at the first touch, wheel or key.
 */
function pinWhileSettling(main: HTMLElement, target: HTMLElement): () => void {
  let frame = 0;
  const until = performance.now() + SETTLE_MS;
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const type of TAKE_OVER) main.removeEventListener(type, stop);
  };
  const tick = () => {
    const gap = target.getBoundingClientRect().top - main.getBoundingClientRect().top;
    if (gap < -0.5) main.scrollTop += gap;
    if (performance.now() < until) frame = requestAnimationFrame(tick);
    else stop();
  };
  for (const type of TAKE_OVER) main.addEventListener(type, stop, { passive: true });
  frame = requestAnimationFrame(tick);
  return stop;
}

/** How long the route announcer may still put focus on the heading (its retries run five seconds). */
const ANNOUNCER_WINDOW_MS = 6000;

/** Focus somewhere inside the page that a person put there — anything but the announcer's heading. */
function focusedByHand(main: HTMLElement): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && main.contains(active) && !active.hasAttribute("data-route-heading");
}

/**
 * X8-1 — the announcer's heading focus, now or within its retry window, moves to the week's chosen
 * day while that heading is out of sight above the page. A heading in view keeps it. Returns the stop.
 */
function handHeadingFocusToWeek(main: HTMLElement, week: HTMLElement, opensAt: HTMLElement | null = null): () => void {
  const move = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement) || !target.hasAttribute("data-route-heading")) return;
    if (target.getBoundingClientRect().bottom > main.getBoundingClientRect().top) return;
    // R9 X8-1 rest — the page opened at the desk's "Booking for" bar (J8-3): focus goes to that bar,
    // which is on screen; the week can be below the fold at 200 % text.
    if (opensAt && opensAt.tabIndex >= -1 && opensAt.hasAttribute("tabindex")) {
      opensAt.focus({ preventScroll: true });
      return;
    }
    const day = week.querySelector<HTMLElement>('[role="radio"][data-state="on"], [role="radio"][tabindex="0"]');
    day?.focus({ preventScroll: true });
  };
  move(document.activeElement);
  const onFocusIn = (event: FocusEvent) => move(event.target);
  main.addEventListener("focusin", onFocusIn);
  const timer = window.setTimeout(() => main.removeEventListener("focusin", onFocusIn), ANNOUNCER_WINDOW_MS);
  return () => { window.clearTimeout(timer); main.removeEventListener("focusin", onFocusIn); };
}
