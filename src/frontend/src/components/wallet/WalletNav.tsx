import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * The wallet's two views — the balance with its ledger, and the activity report — as a
 * segmented control of LINKS.
 *
 * <p>
 * Links, not tabs: each view is its own address (`/wallet`, `/wallet/activity`), so the back
 * button, a bookmark and the route announcer all work, and navigation is a link (design-system.md,
 * Buttons vs links). It borrows the segmented look so the two read as one place with two faces;
 * `aria-current="page"` (from `NavLink`) is what a screen reader hears as the selected one.
 * </p>
 */
// F4-7: `h-auto min-h-touch whitespace-normal py-2` (the design system's rule for labels that must
// wrap) and a gutter that gives way — at 200 % text "Overview | Activity" overflowed the screen.
const SEGMENT = cn(
  "no-lift inline-flex min-h-touch min-w-0 items-center justify-center rounded-md border border-transparent px-3 py-2 text-center whitespace-normal sm:px-4",
  "text-sm font-semibold text-text-secondary transition-colors duration-fast ease-standard motion-reduce:transition-none",
  "hover:text-text-primary focus-visible:-outline-offset-2",
);
const ACTIVE = cn(
  "border-border bg-bg-surface text-accent-strong shadow-xs hover:text-accent-strong",
  // F4-5: forced colours discard the lifted surface, which left both views identical.
  "forced-colors:border-[Highlight] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]",
);

const VIEWS = [
  { to: "/wallet", label: "Overview", end: true },
  { to: "/wallet/activity", label: "Activity", end: false },
];

export function WalletNav() {
  return (
    <nav aria-label="Wallet views" className="-mb-2 inline-flex w-fit max-w-full items-center gap-1 self-start rounded-lg bg-bg-muted p-1">
      {VIEWS.map((view) => (
        <NavLink key={view.to} to={view.to} end={view.end} className={({ isActive }) => cn(SEGMENT, isActive && ACTIVE)}>
          {view.label}
        </NavLink>
      ))}
    </nav>
  );
}
