import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DOCK_BOTTOM, DOCK_PANEL, usePublishDockedHeight } from "./layout";
import { useStickyTop } from "./use-sticky-top";

/**
 * The page's context and its one primary verb, kept in view (R4 form factor, SPEC 2.5).
 *
 * <ul>
 *   <li><b>`top`</b> — sticks to the top of the scroller (`<main>`, which already sits under the
 *   app bar, so `top: 0` — see `layout.stickyTop`) on the surface with a hairline. It carries a
 *   page's filters, date or range and live totals, so they stay visible while a long list
 *   scrolls under them — but only while it is SHORT for its scroller (`stickyMax`, R5 X5-1): at
 *   200 % text or on a short window a tall bar scrolls away instead of holding the screen. While
 *   it sticks it publishes `--context-bar-top-height` (R5 X5-2).</li>
 *   <li><b>`bottom`</b> — docked above the phone's tab bar, in thumb reach, on the same layer as
 *   the multiselect bar. It holds ONE primary verb (Top up, Accept &amp; pay, Invite a player).
 *   `until` hides it from a breakpoint up, where the page shows that verb in its own place.</li>
 * </ul>
 *
 * <p>
 * <b>The dock is shared, not copied.</b> `DOCK_BOTTOM` (`ui/layout`) is the offset the ActionBar, the
 * Settings save bar and this bar all use: the larger of the tab bar's published height
 * (`--app-bottom-bar-height`, safe area included) and the safe area itself, plus 12px — never
 * their sum, which double-counts the safe area on a phone with a tab bar.
 * </p>
 *
 * <p>
 * <b>A docked bar reserves its own room.</b> While a bottom bar is shown it publishes its height
 * as `--context-bar-height` on the root; the shell adds it to `<main>`'s padding and
 * scroll-padding, so the last row of a page can be scrolled clear of the bar and a field reached
 * by Tab is never scrolled under it (R1 F3.23 / V-13: the save bar covered a focused field). The
 * toast strip climbs over it the same way.
 * </p>
 */
type Breakpoint = "sm" | "md" | "lg" | "xl";

/**
 * A docked bar whose parts all rendered nothing is not drawn (R11): `primary={<InviteButton/>}` is
 * an element even when the component returns null (a full booking has no seat to invite to), and
 * the dock painted an empty white pill over the page. No control and no summary → `display: none`,
 * which also publishes a zero height, so `<main>` stops reserving room for it.
 */
const EMPTY_HIDDEN = "[&:not(:has(button)):not(:has(a)):not(:has(input)):not(:has([data-context-summary]))]:hidden";

/** Written whole, so Tailwind's scanner sees every class. */
const HIDE_FROM: Record<Breakpoint, string> = { sm: "sm:hidden", md: "md:hidden", lg: "lg:hidden", xl: "xl:hidden" };
const SHOW_FROM: Record<Breakpoint, string> = { sm: "hidden sm:flex", md: "hidden md:flex", lg: "hidden lg:flex", xl: "hidden xl:flex" };

export type ContextBarProps = {
  position: "top" | "bottom";
  /** Names the region: "Wallet actions", "Activity range". */
  label: string;
  /** Left: what the bar is about — a total, a range, "3 changes". */
  summary?: ReactNode;
  /** Secondary actions, before the primary. */
  actions?: ReactNode;
  /** The one primary verb, rightmost. */
  primary?: ReactNode;
  /** A `bottom` bar shows only below this breakpoint; a `top` bar only from it. */
  until?: Breakpoint;
  /**
   * `top` only: the most of its scroller's height the bar may take and still stick (default 0.4).
   * By room, not by viewport (R5 X5-1): `lg:sticky` held a 665px bar over a 744px scroller at
   * 1280 with 200 % text. A filter strip that can open on a phone asks for less.
   */
  stickyMax?: number;
  /**
   * `top` only: run the bar out to the page frame's edges (through the gutters), as a page-level
   * strip. Off inside a column, where the bleed would run over the column beside it.
   */
  bleed?: boolean;
  className?: string;
  children?: ReactNode;
};

function Parts({ summary, actions, primary, children }: Pick<ContextBarProps, "summary" | "actions" | "primary" | "children">) {
  return (
    <>
      {summary ? <div data-context-summary="" className="min-w-0 flex-[1_1_10rem] break-words text-sm">{summary}</div> : null}
      {children}
      {actions || primary ? (
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {actions}
          {primary}
        </div>
      ) : null}
    </>
  );
}

export function ContextBar(props: ContextBarProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { position, label, summary, actions, primary, until, stickyMax = 0.4, bleed = true, className, children } = props;
  const ref = useRef<HTMLDivElement>(null);
  usePublishDockedHeight(ref, position === "bottom");
  const sticks = useStickyTop(ref, position === "top", stickyMax);
  const parts = <Parts summary={summary} actions={actions} primary={primary}>{children}</Parts>;

  if (position === "bottom") {
    return (
      <div
        ref={ref}
        role="region"
        aria-label={label}
        data-context-bar="bottom"
        className={cn("pointer-events-none fixed inset-x-0 z-actionbar px-4 print:hidden", DOCK_BOTTOM, EMPTY_HIDDEN, until && HIDE_FROM[until], className)}
      >
        <div className={cn(DOCK_PANEL, "animate-sheet-up motion-reduce:animate-none")}>{parts}</div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      role="region"
      aria-label={label}
      data-context-bar="top"
      data-sticks={sticks || undefined}
      className={cn(
        "z-sticky flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-surface py-2",
        sticks ? "sticky top-0" : "relative",
        bleed ? "-mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 3xl:-mx-12 3xl:px-12" : "rounded-b-xl px-3",
        until && SHOW_FROM[until],
        className,
      )}
    >
      {parts}
    </div>
  );
}
