import { useEffect, useRef } from "react";

/**
 * Re-reads the page at every instant the page already knows something changes at.
 *
 * <p>
 * <b>The defect, in one sentence: a page left open kept presenting a finished booking's
 * code in the present tense.</b> Twenty minutes after her court had ended, with a healthy
 * countdown under it and a standing line still saying "the door opens for you now", a
 * member was holding up a code the door would refuse. Nothing was broken — everything on
 * that screen was true when it was fetched, and the page's own refresh cycle happened to
 * be forty-five minutes long. The poll rate was the only thing standing between a member
 * and a wrong answer, and a poll rate is not an argument.
 * </p>
 *
 * <p>
 * <b>Every one of these instants is sent BY the server, in a field the page is already
 * reading.</b> The booking's end, the door window opening and closing, the code's own
 * expiry: the page has all four and used none of them to decide when to ask again. A
 * clock-driven re-read at a boundary costs one request at the one moment the answer is
 * known to have changed, which is strictly cheaper than polling fast enough to catch it.
 * </p>
 *
 * <p>
 * <b>Three things make it survive a phone.</b> The timer is recomputed from
 * {@link Date.now} rather than counted down, so a device that slept through the boundary
 * fires on wake rather than late by however long it was asleep; `visibilitychange`,
 * `focus` and `pageshow` all force that recomputation, which is the same triple every
 * other clock on this surface listens on; and an instant already in the past fires once
 * and is then not re-armed, because a boundary that has passed is a fact, not a repeating
 * alarm.
 * </p>
 *
 * <p>
 * A `setTimeout` longer than `2^31 − 1` milliseconds overflows to firing immediately, so
 * a far-future instant is slept towards in bounded hops instead. Nothing on this page is
 * twenty-five days away, but a malformed or absurd date from anywhere is one line away
 * from a request every four milliseconds.
 * </p>
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Below this, two boundaries a few hundred ms apart are one re-read rather than two. */
const SETTLE_MS = 250;

export function useBoundaryRefresh(instants: (string | null | undefined)[], onBoundary: () => void) {
  // Joined, so the effect re-arms when a boundary genuinely moves and not on every render
  // of an array literal built inline by the caller.
  const key = instants.filter((i): i is string => !!i).sort().join("|");
  const fire = useRef(onBoundary);
  fire.current = onBoundary;
  /** Boundaries already acted on, so a re-render cannot replay one. */
  const done = useRef(new Set<number>());

  useEffect(() => {
    if (!key) return;
    const parsed = key.split("|").map((i) => Date.parse(i)).filter((t) => !Number.isNaN(t));
    if (parsed.length === 0) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;

    const arm = () => {
      if (!live) return;
      clearTimeout(timer);
      const now = Date.now();
      // Anything already behind us that has not been acted on yet IS the boundary: the
      // page was asleep, or was opened after it passed with stale data in hand.
      const passed = parsed.filter((t) => t <= now && !done.current.has(t));
      if (passed.length > 0) {
        for (const t of passed) done.current.add(t);
        fire.current();
      }
      const next = parsed.filter((t) => t > now).sort((a, b) => a - b)[0];
      if (next === undefined) return;
      timer = setTimeout(arm, Math.min(MAX_TIMEOUT_MS, Math.max(SETTLE_MS, next - now)));
    };

    arm();
    document.addEventListener("visibilitychange", arm);
    window.addEventListener("focus", arm);
    window.addEventListener("pageshow", arm);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
      window.removeEventListener("focus", arm);
      window.removeEventListener("pageshow", arm);
    };
  }, [key]);
}
