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
export function ScrollArea({
  label,
  className,
  tabbable = true,
  children,
}: {
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
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // A one-pixel tolerance: sub-pixel layout leaves scrollWidth a fraction above clientWidth on
    // content that fits perfectly, which would otherwise show a permanent fade on a full table.
    const max = el.scrollWidth - el.clientWidth;
    setMore({ left: el.scrollLeft > 1, right: max - el.scrollLeft > 1 });
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    // ResizeObserver covers the cases a window resize does not: a column appearing, rows
    // loading, the parent flexing. jsdom has it; older browsers fall back to the window event.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, children]);

  return (
    <div className={cn("relative", className)}>
      <div
        ref={ref}
        onScroll={measure}
        // A tab stop on a non-interactive element, on purpose: a scrolling region that keyboard
        // users cannot focus cannot be scrolled by keyboard at all, so its hidden content is
        // simply unreachable. role="region" + aria-label is what keeps the stop from being a
        // mystery when a screen reader lands on it.
        tabIndex={tabbable ? 0 : undefined}
        role="region"
        aria-label={label}
        className="overflow-auto h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-strong rounded-lg"
      >
        {children}
      </div>
      {/* Pointer-events-none so the fades never eat a tap on the row underneath. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-bg-surface to-transparent transition-opacity duration-fast",
          more.left ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-bg-surface to-transparent transition-opacity duration-fast",
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
