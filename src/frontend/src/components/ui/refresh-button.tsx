import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useTicker } from "@/lib/useTicker";
import { ArrowsClockwise, WarningCircle } from "./icons";

/**
 * Refresh, and how fresh (design-system.md, Patterns → Refresh). Both always sit in the page
 * header's actions slot, on the right — `<PageHeader actions={<RefreshButton/>}
 * freshness={<Freshness/>}>` — never as a text button or a link somewhere in the body.
 */

/**
 * The shortest spin a press produces. A read that answers in 40ms otherwise flickers the icon
 * for two frames, and a member cannot tell a refresh that happened from a tap that missed.
 */
export const MIN_SPIN_MS = 400;

export type RefreshButtonProps = {
  /** Start the read. Return nothing — the caller owns the read's error state. */
  onRefresh: () => void;
  /** The read is in flight. */
  loading?: boolean;
  /** The accessible name. An icon button has no other. */
  label?: string;
  className?: string;
};

/** True for {@link MIN_SPIN_MS} after `start()`; the timer is cleared on unmount. */
function useMinimumSpin(): [boolean, () => void] {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const start = useCallback(() => {
    window.clearTimeout(timer.current);
    setHolding(true);
    timer.current = window.setTimeout(() => setHolding(false), MIN_SPIN_MS);
  }, []);
  return [holding, start];
}

/**
 * A 44px icon button (ArrowsClockwise) that spins while loading — for at least
 * {@link MIN_SPIN_MS} after a press — with `aria-busy`, and `aria-disabled` rather than
 * `disabled` so focus stays on it while it works. A press while it is spinning is ignored.
 * Reduced motion: the icon holds still; `aria-busy` and the cursor still say it is working.
 */
export function RefreshButton({ onRefresh, loading = false, label = "Refresh", className }: RefreshButtonProps) {
  const [holding, hold] = useMinimumSpin();
  const spinning = loading || holding;
  const press = () => {
    if (spinning) return;
    hold();
    onRefresh();
  };
  return (
    <button
      type="button"
      aria-label={label}
      aria-busy={spinning || undefined}
      aria-disabled={spinning || undefined}
      data-spinning={spinning || undefined}
      onClick={press}
      className={cn(
        "no-lift inline-flex size-touch shrink-0 items-center justify-center rounded-lg border border-transparent",
        "text-text-secondary transition-colors duration-fast ease-standard hover:bg-bg-muted hover:text-text-primary",
        "aria-disabled:cursor-progress",
        className,
      )}
    >
      <ArrowsClockwise
        size={20}
        aria-hidden="true"
        className={cn(spinning && "animate-spin motion-reduce:animate-none")}
      />
    </button>
  );
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { style: "narrow", numeric: "always" });

/** "Updated 12s ago", "Updated 3m ago", "Updated 2h ago", "Updated 1d ago". */
function describeAge(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 5) return "Updated just now";
  if (seconds < 60) return `Updated ${RELATIVE.format(-seconds, "second")}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${RELATIVE.format(-minutes, "minute")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${RELATIVE.format(-hours, "hour")}`;
  return `Updated ${RELATIVE.format(-Math.floor(hours / 24), "day")}`;
}

export type FreshnessProps = {
  /** When the data on screen was read. `null` before the first read: nothing is rendered. */
  at: Date | number | null;
  /** From this age the line turns warning and gains an icon. Default one minute. */
  staleAfterMs?: number;
  className?: string;
};

/** Re-renders every {@link TICK_MS}: coarser than the seconds it prints, finer than anyone reads. */
const TICK_MS = 10_000;

/**
 * How old the screen is, as a `<time>`. Stale is said twice — the warning colour AND a warning
 * icon — because colour is never the only signal. Not a live region: a line that changed every
 * ten seconds would talk over everything else on the page.
 */
export function Freshness({ at, staleAfterMs = 60_000, className }: FreshnessProps) {
  const now = useTicker(at !== null, TICK_MS);
  if (at === null) return null;
  const when = typeof at === "number" ? at : at.getTime();
  const age = now - when;
  const stale = age >= staleAfterMs;
  return (
    <time
      dateTime={new Date(when).toISOString()}
      data-stale={stale || undefined}
      className={cn(
        "inline-flex items-center gap-1 text-xs tabular-nums",
        stale ? "font-medium text-warning-strong" : "text-text-muted",
        className,
      )}
    >
      {stale ? <WarningCircle size={14} weight="bold" aria-hidden="true" /> : null}
      {describeAge(age)}
    </time>
  );
}
