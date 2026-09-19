import { useEffect, useState } from "react";

/**
 * One instant per paint, re-read once a second while somebody is looking.
 *
 * <p>
 * <b>The number this returns is the doors surface's honesty signal.</b> P1 says a scan is a
 * pull and nothing on a door may look instant when it is not, and the live-ticking "last
 * heard from Ns ago" is how a screen says so — a green dot alone cannot. So this is not
 * decoration, and it has no pause control by design: SC 2.2.2's real-time exemption is
 * exactly this case.
 * </p>
 *
 * <p>
 * <b>Recomputed, never accumulated.</b> Phones suspend timers while asleep, so a counter
 * that adds a second per tick comes back wrong — showing an age far shorter than the truth,
 * which is the one direction this number must never be wrong in. Every tick reads the clock.
 * </p>
 *
 * <p>
 * <b>Suspended while the tab is hidden, and caught up on the way back in.</b> Nobody is
 * reading a background tab, and waiting up to a second on return is a stale age on a screen
 * an outage email links to. `visibilitychange` writes the clock immediately rather than
 * waiting for the next interval.
 * </p>
 *
 * <p>
 * <b>No `mounted` ref and no early-return guard.</b> React's StrictMode runs
 * mount → cleanup → mount, and a ref written only on cleanup is already false before the
 * first tick — the shape behind two live defects in this repo. Clearing the interval is the
 * whole cleanup; a second mount starts a second interval and the first is cleared.
 * </p>
 *
 * @param active whether the caller still wants a clock — a page that has nothing ticking
 *   (an empty list, a failed read) passes false rather than mounting a timer for nothing.
 * @param intervalMs how often to look. One second everywhere; a parameter only because the
 *   tests should not have to wait a real one.
 */
export function useTicker(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
    };
    const onVisibility = () => { if (document.visibilityState === "visible") setNow(Date.now()); };
    const timer = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, intervalMs]);

  return now;
}
