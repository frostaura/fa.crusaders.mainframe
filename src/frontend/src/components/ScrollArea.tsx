import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

/**
 * A horizontally scrolling region that says it is one.
 *
 * <p>
 * A wide table inside a plain `overflow-auto` div is correct — the page itself does not scroll
 * sideways — and completely silent: on a phone the wallet ledger cut off mid-word with no
 * chevron, no gradient and no hint, so the two columns a member opens their wallet to read
 * looked like they did not exist rather than like they were one swipe away. A container that
 * hides content without saying so is worse than one that does not hide it.
 * </p>
 *
 * <p>
 * It is also focusable, which is not decoration: a scrollable region that keyboard users cannot
 * reach is a WCAG failure on its own, and a `tabIndex` of 0 is what lets the arrow keys move it.
 * The role and label are what stop that focus stop being a mystery to a screen reader.
 * </p>
 */
/**
 * The colour each fade melts into — the surface the region sits on. A surface-white fade on the
 * page canvas reads as a smudge (R4 form factor: the bookings court chips sit on `bg-app`).
 */
const FADE = {
  surface: { left: "from-bg-surface", right: "from-bg-surface" },
  app: { left: "from-bg-app", right: "from-bg-app" },
} as const;

type ScrollAreaProps = {
  /** Names the region for assistive tech — "Wallet ledger", not "Table". */
  label: string;
  className?: string;
  /**
   * Whether the region itself is a tab stop. It is, by default, for the reason above.
   *
   * <p>
   * C19 — set it false where everything inside is ALREADY focusable and brings itself into
   * view, which is the section tab strip: every tab is a link, every link scrolls itself in
   * on focus, so the region's own stop reaches nothing the next Tab would not. A tab stop
   * that does nothing is not neutral; on a phone the strip is the second stop on every
   * route, announced as a region, and it goes nowhere.
   * </p>
   */
  tabbable?: boolean;
  /** What the region sits on, so the edge fades melt into it. */
  fade?: keyof typeof FADE;
  /**
   * R5 V5-6: be a scroller ONLY while the content is wider than the box. A box with
   * `overflow: auto` is a scroll container in BOTH axes, so a sticky table header inside it sticks
   * to a box that never scrolls vertically and leaves with the page. While the content fits, the
   * region is a plain box (no tab stop, nothing to reach) and a sticky child sticks to the page's
   * own scroller; once the content is wider, it scrolls sideways as before. The outer box carries
   * `data-scrolls` while it does, so the children can pin a column against it.
   */
  onlyWhenWider?: boolean;
  children: React.ReactNode;
};

export function ScrollArea(props: ScrollAreaProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { label, className, tabbable = true, fade = "surface", onlyWhenWider = false, children } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  const [wider, setWider] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // A one-pixel tolerance: sub-pixel layout leaves scrollWidth a fraction above clientWidth on
    // content that fits perfectly, which would otherwise show a permanent fade on a full table.
    const max = el.scrollWidth - el.clientWidth;
    setMore({ left: el.scrollLeft > 1, right: max - el.scrollLeft > 1 });
    // The content's own width, which does not depend on whether the box scrolls — so switching
    // the box between the two modes cannot flip the answer back.
    const content = el.firstElementChild;
    const width = content ? content.getBoundingClientRect().width : el.scrollWidth;
    setWider(width > el.clientWidth + 1 || max > 1);
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    // ResizeObserver covers the cases a window resize does not: a column appearing, rows
    // loading, the parent flexing. jsdom has it; older browsers fall back to the window event.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, children]);

  const scrolls = !onlyWhenWider || wider;
  return (
    <div className={cn("relative", className)} data-scrolls={onlyWhenWider && wider ? "" : undefined}>
      <div
        ref={ref}
        onScroll={measure}
        // A tab stop on a non-interactive element, on purpose: a scrolling region that keyboard
        // users cannot focus cannot be scrolled by keyboard at all, so its hidden content is
        // simply unreachable. role="region" + aria-label is what keeps the stop from being a
        // mystery when a screen reader lands on it.
        tabIndex={tabbable && scrolls ? 0 : undefined}
        role="region"
        aria-label={label}
        className={cn(
          "h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-strong rounded-lg",
          scrolls ? "overflow-auto" : "overflow-visible",
        )}
      >
        {children}
      </div>
      {/* Pointer-events-none so the fades never eat a tap on the row underneath. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r to-transparent transition-opacity duration-fast",
          FADE[fade].left,
          more.left ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l to-transparent transition-opacity duration-fast",
          FADE[fade].right,
          more.right ? "opacity-100" : "opacity-0",
        )}
      />
      {/*
        The gradient is the affordance for someone who can see it. This sentence is the
        affordance for everyone else, and it is what a screen reader reads when it lands on
        the region — so it is present only while there is actually more to reach.
      */}
      {(more.left || more.right) && (
        <p className="sr-only" data-testid="scroll-hint">
          {label} scrolls sideways — there is more to see.
        </p>
      )}
    </div>
  );
}
