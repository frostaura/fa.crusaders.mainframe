import { cn } from "@/lib/utils";

/**
 * A ring that empties over a rotating window — the member code's 30-second step on the pass card
 * (design-system.md, Patterns → Pass card).
 *
 * <p>
 * The arc is `stroke-dashoffset` over the circumference, eased LINEARLY across one `tick`
 * (1 000 ms) so a once-a-second update reads as continuous motion rather than a jump. The
 * seconds left sit in the middle as a tabular number. The first second of a window is not
 * eased, so a new window snaps full instead of sweeping backwards.
 * </p>
 *
 * <p>
 * <b>Reduced motion shows the number only</b> — the ring is hidden, not frozen, because a
 * half-empty ring that never moves is a false statement about time.
 * </p>
 *
 * <p>
 * <b>`aria-hidden`, always.</b> A value that changes every second must not be a live region, and
 * a ring has no text alternative worth reading. The caller puts the sentence beside it
 * ("New code in 12 seconds", visually hidden or not) and decides how often that is read.
 * </p>
 */
export type CountdownRingProps = {
  /** The window's length, ms — 30 000 for a 30-second code step. */
  periodMs: number;
  /** Time left in the current window, ms. Clamped to [0, periodMs]. */
  remainingMs: number;
  /** Outer diameter, px. */
  size?: number;
  /** Ring thickness, px. */
  strokeWidth?: number;
  className?: string;
};

export function CountdownRing({ periodMs, remainingMs, size = 40, strokeWidth = 3, className }: CountdownRingProps) {
  const safePeriod = periodMs > 0 ? periodMs : 1;
  const remaining = Math.min(Math.max(remainingMs, 0), safePeriod);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - remaining / safePeriod);
  const seconds = Math.ceil(remaining / 1000);
  // A new window starts full. Without this the arc would sweep BACK round over one tick.
  const refilling = remaining > safePeriod - 1000;
  return (
    <span
      aria-hidden="true"
      data-countdown-ring=""
      data-remaining-seconds={seconds}
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} focusable="false" className="-rotate-90 motion-reduce:hidden">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-border" />
        <circle
          data-ring-arc=""
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={cn(
            "stroke-accent-strong",
            !refilling && "transition-[stroke-dashoffset] duration-tick ease-linear motion-reduce:transition-none",
          )}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums text-text-primary">
        {seconds}
      </span>
    </span>
  );
}
