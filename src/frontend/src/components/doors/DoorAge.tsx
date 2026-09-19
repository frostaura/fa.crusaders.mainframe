import { relative } from "../../lib/deviceLiveness";
import { spellAge } from "../../lib/doorsCopy";

/**
 * How long ago this door called in, ticking.
 *
 * <p>
 * <b>This is the honesty signal, not a decoration.</b> P1: a scan is a pull, server-side
 * changes apply on the next scan, and no control may look instant when it is not — so the
 * live-ticking age is how the screen says what a green dot cannot. It has no pause control
 * by design; SC 2.2.2's real-time exemption is this case, and it is suspended whenever the
 * tab is hidden, which is the only time nobody needs it.
 * </p>
 *
 * <p>
 * <b>`aria-live="off"`, explicitly.</b> A screen-reader user landing on a live region that
 * rewrites itself every second is interrupted out of the page they are trying to read. The
 * relative text is the visual affordance; the accessible name carries the absolute time, so
 * the fact arrives once and completely.
 * </p>
 *
 * <p>
 * `now` is a parameter, not a `Date.now()` inside: one instant per paint, so three ages on
 * one screen cannot straddle a second boundary and print two numbers for one moment.
 * </p>
 */
export function DoorAge({ at, now, prefix = "Last heard from" }: {
  at: string | null;
  now: number;
  /** "Last heard from" on a silent door, "Heard from" on a reporting one. */
  prefix?: string;
}) {
  const ago = relative(at, now);
  if (at === null) {
    return <span className="text-sm text-text-muted">Never heard from</span>;
  }
  const absolute = new Date(at).toLocaleString("en-GB", {
    hour: "2-digit", minute: "2-digit", day: "numeric", month: "long", hour12: false,
  });
  return (
    <time
      dateTime={at}
      aria-live="off"
      aria-label={`${prefix} ${spellAge(ago)}, at ${absolute}`}
      title={absolute}
      className="text-sm text-text-secondary"
    >
      {`${prefix} ${ago}`}
    </time>
  );
}
