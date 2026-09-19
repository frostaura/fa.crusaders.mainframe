import { useEffect, useState } from "react";
import { doorEndpoints, type DoorsView } from "../../lib/api";
import { isOnline, offlineAfterSecondsFor } from "../../lib/deviceLiveness";
import { doorNeedsAttention } from "../../lib/doorsCopy";

/** What the chrome needs from the doors read, and nothing else. */
export type DoorsChrome = {
  /** One sentence per door that needs somebody, in tile order. Empty on a failed read. */
  attention: string[];
  shut: number;
  total: number;
};

const NOTHING: DoorsChrome = { attention: [], shut: 0, total: 0 };

/**
 * The doors facts the app chrome carries on every admin route.
 *
 * <p>
 * <b>Modelled on `usePendingApplicationCount`, deliberately.</b> That hook is the pattern
 * this product already has for "a cue in the chrome, re-read on navigation", and its own
 * comment carries the rule that matters here: <i>a badge is a cue, not a screen — a failed
 * read shows nothing rather than an error.</i> So a failed read produces no dot, no count
 * and no banner: the banner's ABSENCE is the default rather than a claim, which is what
 * stops a failed read rendering a false all-clear.
 * </p>
 *
 * <p>
 * <b>Re-read on navigation only, and that is an honest limit.</b> The cue can be up to one
 * navigation stale; the doors page itself is what ticks. A chrome-level poll would make four
 * calls a minute on every screen in the product to keep a dot warm.
 * </p>
 *
 * <p>
 * Counted: silent, shut, unnamed. NOT counted: refusal spikes, the releasing flag, scan
 * counts (A2.6) — a badge that fires on a dirty scanner is one an admin learns to ignore
 * before the badge that fires on a dead board ever appears.
 * </p>
 */
export function useDoorsChrome(enabled: boolean, routeKey: string): DoorsChrome {
  const [chrome, setChrome] = useState<DoorsChrome>(NOTHING);

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the cue when the session stops being an admin one
      setChrome(NOTHING);
      return;
    }
    let cancelled = false;
    doorEndpoints.doors()
      .then((view) => { if (!cancelled) setChrome(summarise(view)); })
      .catch(() => { /* A cue, not a screen: a failed read shows nothing rather than an error. */ });
    return () => { cancelled = true; };
  }, [enabled, routeKey]);

  return chrome;
}

function summarise(view: DoorsView): DoorsChrome {
  const now = Date.now();
  const attention: string[] = [];
  for (const row of view.doors) {
    const online = isOnline(row.device, offlineAfterSecondsFor(row.device, null), now);
    const reason = doorNeedsAttention(row.device, online);
    if (reason) attention.push(reason);
  }
  return {
    attention,
    shut: view.doors.filter((row) => !row.device.enabled).length,
    total: view.doors.length,
  };
}
