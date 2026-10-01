import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A main column with a side rail (R4 form factor, SPEC 2.3) — the Bookings day summary, the
 * Wallet's balance, a booking's money.
 *
 * <p>
 * <b>Decided by the box, not the viewport.</b> The root is a container (`@container/aside`); the
 * rail stands beside the main column once the BOX is `at` wide (72rem by default), so the same
 * page lays out right beside the admin rail, inside a split view, and at 200 % text (rem, so the
 * threshold doubles with the text and a large-text reader keeps one readable column).
 * </p>
 *
 * <ul>
 *   <li><b>`after`</b> (default) — the rail on the right; stacked, it follows the main column.</li>
 *   <li><b>`before`</b> — the rail on the left and FIRST in reading order; stacked, above.</li>
 *   <li><b>`first`</b> — the rail on the right, but FIRST in reading order; stacked, above. For a
 *   rail that a phone wants at the top (the Bookings page's games) and a desktop beside.</li>
 *   <li><b>`sheet`</b> — the rail on the right; stacked, it is not drawn at all, because the page
 *   carries the same content another way (a bottom sheet, a ContextBar button). Never the only
 *   home of an action on a phone.</li>
 * </ul>
 *
 * <p>
 * <b>Sticky, with its own scroll.</b> Beside the main column the rail sticks 1.5rem under the top
 * of the scroller (`<main>` sits under the app bar, so that is `top-6`, not the bar's height) and
 * is capped at the screen's height less the measured chrome, scrolling inside itself — so the
 * money stays in view while the players are worked. From 3xl it widens to `asideWide`.
 * </p>
 *
 * <p>
 * It is an `<aside aria-label>`: a complementary landmark a screen reader can jump to.
 * </p>
 */
type At = "56rem" | "64rem" | "72rem";
type AsideWidth = "18rem" | "20rem" | "22rem" | "24rem";

/** Every class written whole, so Tailwind's scanner sees it. */
const GRID: Record<At, string> = {
  "56rem": "@[56rem]/aside:grid @[56rem]/aside:items-start @[56rem]/aside:gap-8",
  "64rem": "@[64rem]/aside:grid @[64rem]/aside:items-start @[64rem]/aside:gap-8",
  "72rem": "@[72rem]/aside:grid @[72rem]/aside:items-start @[72rem]/aside:gap-8",
};
const COLS_END: Record<At, string> = {
  "56rem": "@[56rem]/aside:grid-cols-[minmax(0,1fr)_var(--aside-w)]",
  "64rem": "@[64rem]/aside:grid-cols-[minmax(0,1fr)_var(--aside-w)]",
  "72rem": "@[72rem]/aside:grid-cols-[minmax(0,1fr)_var(--aside-w)]",
};
const COLS_START: Record<At, string> = {
  "56rem": "@[56rem]/aside:grid-cols-[var(--aside-w)_minmax(0,1fr)]",
  "64rem": "@[64rem]/aside:grid-cols-[var(--aside-w)_minmax(0,1fr)]",
  "72rem": "@[72rem]/aside:grid-cols-[var(--aside-w)_minmax(0,1fr)]",
};
const STICKY: Record<At, string> = {
  "56rem": "@[56rem]/aside:sticky @[56rem]/aside:top-6 @[56rem]/aside:max-h-[calc(100dvh-var(--app-chrome-height,0px)-3rem)] @[56rem]/aside:overflow-y-auto",
  "64rem": "@[64rem]/aside:sticky @[64rem]/aside:top-6 @[64rem]/aside:max-h-[calc(100dvh-var(--app-chrome-height,0px)-3rem)] @[64rem]/aside:overflow-y-auto",
  "72rem": "@[72rem]/aside:sticky @[72rem]/aside:top-6 @[72rem]/aside:max-h-[calc(100dvh-var(--app-chrome-height,0px)-3rem)] @[72rem]/aside:overflow-y-auto",
};
/** The rail's width, widened from 3xl (`asideWide`) where a 1920 screen has the room. */
const WIDTH: Record<AsideWidth, string> = {
  "18rem": "[--aside-w:18rem] 3xl:[--aside-w:22rem]",
  "20rem": "[--aside-w:20rem] 3xl:[--aside-w:24rem]",
  "22rem": "[--aside-w:22rem] 3xl:[--aside-w:24rem]",
  "24rem": "[--aside-w:24rem]",
};
/** `first`: DOM-first, drawn in the second column. */
const SECOND_COLUMN: Record<At, string> = {
  "56rem": "@[56rem]/aside:col-start-2 @[56rem]/aside:row-start-1",
  "64rem": "@[64rem]/aside:col-start-2 @[64rem]/aside:row-start-1",
  "72rem": "@[72rem]/aside:col-start-2 @[72rem]/aside:row-start-1",
};
const FIRST_COLUMN: Record<At, string> = {
  "56rem": "@[56rem]/aside:col-start-1 @[56rem]/aside:row-start-1",
  "64rem": "@[64rem]/aside:col-start-1 @[64rem]/aside:row-start-1",
  "72rem": "@[72rem]/aside:col-start-1 @[72rem]/aside:row-start-1",
};
const SHOW_AT: Record<At, string> = {
  "56rem": "hidden @[56rem]/aside:flex",
  "64rem": "hidden @[64rem]/aside:flex",
  "72rem": "hidden @[72rem]/aside:flex",
};

export type WithAsideProps = {
  aside: ReactNode;
  /** The landmark's name: "Today", "Your balance", "Money". */
  asideLabel: string;
  placement?: "after" | "before" | "first" | "sheet";
  /** The BOX width at which the rail stands beside the main column. */
  at?: At;
  asideWidth?: AsideWidth;
  sticky?: boolean;
  /** The space between blocks (stacked, and inside each column): `lg` (32px, sections) or `md` (16px, one tool). The columns themselves stay 32px apart. */
  gap?: "md" | "lg";
  className?: string;
  children: ReactNode;
};

export function WithAside(props: WithAsideProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { aside, asideLabel, placement = "after", at = "72rem", asideWidth = "20rem", sticky = true, gap = "lg", className, children } = props;
  const before = placement === "before";
  const first = placement === "first";
  const rail = (
    <aside
      aria-label={asideLabel}
      data-aside={placement}
      className={cn(
        "min-w-0 flex-col",
        gap === "md" ? "gap-4" : "gap-6",
        placement === "sheet" ? SHOW_AT[at] : "flex",
        first && SECOND_COLUMN[at],
        // Room for a focus outline inside the rail's own scroller.
        sticky && cn(STICKY[at], "overscroll-contain p-1 -m-1"),
      )}
    >
      {aside}
    </aside>
  );
  return (
    <div data-with-aside="" className={cn("@container/aside min-w-0", className)}>
      <div
        className={cn("flex flex-col", gap === "md" ? "gap-4" : "gap-8", WIDTH[asideWidth], GRID[at], before ? COLS_START[at] : COLS_END[at])}
      >
        {before || first ? rail : null}
        <div data-aside-main="" className={cn("flex min-w-0 flex-col", gap === "md" ? "gap-4" : "gap-8", first && FIRST_COLUMN[at])}>{children}</div>
        {before || first ? null : rail}
      </div>
    </div>
  );
}
