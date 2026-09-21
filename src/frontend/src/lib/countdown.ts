/**
 * Every countdown a member is shown, on one clock.
 *
 * <p>
 * These four lived inside `CourtCode.tsx`, where the code's own expiry was their only
 * reader. They have four now — the code, the door's `too_early` window, the stale-cache
 * age, and whatever the next door surface needs — so they are EXTRACTED here rather than
 * copied. The two-clock rule below is subtle enough that a second hand-rolled copy is a
 * second place to get it wrong, which is exactly what the doors contract forbids for
 * `relative()` and `offlineAfterSeconds()` on the admin side.
 * </p>
 */

/**
 * A deadline, on two clocks.
 *
 * <p>
 * <code>performance.now()</code> is monotonic — it cannot be dragged backwards by a
 * clock correction — but on some phones it stops while the device sleeps, which is
 * exactly when a member is not looking at the page. <code>Date.now()</code> runs
 * through sleep but can jump. Reading the deadline off both and trusting whichever says
 * less time is left means a dead code is never shown as live, whichever clock lied.
 * </p>
 */
export type Deadline = { wall: number; perf: number };

/** A deadline `seconds` from now — a lifetime the server expressed as a duration. */
export function deadlineFor(seconds: number): Deadline {
  return { wall: Date.now() + seconds * 1000, perf: performance.now() + seconds * 1000 };
}

/**
 * A deadline at an instant the server NAMED, or null when there is no readable one.
 *
 * <p>
 * An absolute instant is a different problem from a lifetime, and pretending otherwise
 * is how a countdown to 1970 reaches a member's screen. There is no monotonic reading of
 * a wall-clock instant: <code>performance.now()</code> has no relation to it. So the
 * wall half is the instant itself and the monotonic half is derived from it at the
 * moment of construction — which still gives the two-clock guard everything it can
 * honestly have, because from here on the two drift apart exactly as they do for a
 * lifetime.
 * </p>
 *
 * <p>
 * Null in, null out, and an unparseable string out too. A door window the server did not
 * send is a sentence with no countdown in it, never a countdown to an invented time.
 * </p>
 */
export function deadlineAt(instant: string | null | undefined): Deadline | null {
  if (!instant) return null;
  const wall = Date.parse(instant);
  if (Number.isNaN(wall)) return null;
  return { wall, perf: performance.now() + (wall - Date.now()) };
}

/** Whole seconds left, never negative, read off the clock rather than counted in ticks. */
export function secondsUntil(deadline: Deadline): number {
  const ms = Math.min(deadline.wall - Date.now(), deadline.perf - performance.now());
  return Math.max(0, Math.ceil(ms / 1000));
}

/**
 * A duration in the shape a member reads at a glance.
 *
 * <p>
 * The seconds are zero-padded and the minutes are not, deliberately: a digit that
 * appears and disappears under the eye makes the whole line jump, and this line is read
 * by somebody holding a phone in one hand in the dark.
 * </p>
 */
/*
 * `formatClock` and `formatDayAndClock` used to live here, and they were the SECOND clock
 * formatter in this product.
 *
 * O1: they formatted in the viewer's own zone, while `lib/clubClock` — which every admin
 * door surface uses — formats in the club's. One event, two screens, two different times,
 * and neither screen said which zone it had written. `/me/door` and `/me/door/history` now
 * carry `timezone` (WIRE-R2 §4), so the member surfaces call `clubClock` / `clubDayAndClock`
 * with the club's own zone and there is exactly one clock face in the product.
 *
 * What stays here is what is genuinely about DURATION rather than about a face on a clock:
 * the two-clock deadline, the reading off it, and the countdown's shape.
 */

export function formatCountdown(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}
