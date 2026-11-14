import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { STREAM_SILENCE_MS } from "./api";
import { adminEndpoints, type ControlBoardCourt, type ControlBoardView } from "./adminApi";
import { type FreshnessMode } from "./monitoringCopy";

/**
 * The Control Board's read: a live stream where one can be had, a poll where it cannot, and
 * the page always able to say which it is doing.
 *
 * <p>
 * <b>SSE, not WebSockets, and not because anybody prefers it.</b> `text/event-stream` with
 * `X-Accel-Buffering: no` is already in production here behind nginx (`proxy_buffering off`)
 * and a Cloudflare tunnel, carrying the wallet stream. nginx carries no `Upgrade` plumbing at
 * all, because the one block that did was deliberately deleted with the reasoning written
 * into the file. Adding it back to ship one wall screen would contradict that in the same
 * file. Ruling 6 settles it; this is the second client of a mechanism that already works.
 * </p>
 *
 * <p>
 * <b>A stream can stop delivering without failing.</b> That is the defect `lib/balance.tsx`
 * documents at length: no `onerror`, no failed request, just a socket that stays open and
 * carries nothing, and a member watching a stale figure until they reloaded. So the only
 * trustworthy liveness signal is a named `ping` and a silence timer, and both are here.
 * </p>
 *
 * <p>
 * <b>The fallback is a requirement, not a nicety.</b> D2 §8.8: every stream has a paired
 * plain GET returning the same payload, and the UI must state which mode it is in and must
 * never show a stale number with no qualifier. After {@link FALLBACK_AFTER_FAILURES}
 * consecutive stream failures inside {@link FALLBACK_WINDOW_MS} this stops trying to stream
 * and polls instead — and says so. A wall tablet that silently stopped updating is the worst
 * outcome available to this page, because nothing on it looks wrong.
 * </p>
 */

/**
 * The three tenant settings this hook is governed by, as constants until the settings read
 * carries them.
 *
 * <p>
 * Named here with their D2 defaults rather than inlined, because ruling 13 says every
 * configurable number is a `tenant_settings` key and these three are on D2 §14's list
 * (`realtime_fallback_after_failures` 3, `realtime_fallback_window_seconds` 120,
 * `realtime_poll_seconds_control_board` 10). The hook takes them as options so the settings
 * row can feed them the day the key ships, and so a test does not have to wait ten seconds.
 * </p>
 */
export const FALLBACK_AFTER_FAILURES = 3;
export const FALLBACK_WINDOW_MS = 120_000;
export const POLL_MS = 10_000;

export type ControlBoardRead = {
  view: ControlBoardView | null;
  /** The FIRST read has not answered. A re-read in flight does not put the page back here. */
  loading: boolean;
  /** What was thrown by the last read, or null once one has succeeded since. */
  error: unknown;
  mode: FreshnessMode;
  /** Epoch millis of the last successful read or delta, for the freshness line. */
  readAt: number | null;
  refresh: () => Promise<void>;
};

type Options = {
  pollMs?: number;
  fallbackAfterFailures?: number;
  fallbackWindowMs?: number;
  /** Off in a test that is only exercising the poll, and off while the page is unmounted. */
  stream?: boolean;
};

/**
 * Merge one court's delta into the snapshot we hold.
 *
 * <p>
 * A delta for a court the snapshot has never seen is IGNORED rather than appended. A court
 * appears on this board because the club has it, not because a message mentioned it, and a
 * wall that grows a fifth tile from one frame is a wall nobody can reconcile against the
 * four courts in the building. The periodic full `snapshot` is what introduces a new court.
 * </p>
 */
export function applyCourtDelta(view: ControlBoardView, court: ControlBoardCourt): ControlBoardView {
  const known = view.courts.some((c) => c.court_id === court.court_id);
  if (!known) return view;
  return {
    ...view,
    courts: view.courts.map((c) => (c.court_id === court.court_id ? { ...c, ...court } : c)),
  };
}

export function useControlBoard(options: Options = {}): ControlBoardRead {
  const {
    pollMs = POLL_MS,
    fallbackAfterFailures = FALLBACK_AFTER_FAILURES,
    fallbackWindowMs = FALLBACK_WINDOW_MS,
    stream = true,
  } = options;

  const [view, setView] = useState<ControlBoardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState<FreshnessMode>(stream ? "connecting" : "polling");
  const [readAt, setReadAt] = useState<number | null>(null);
  /**
   * Whether the stream has failed often enough, recently enough, to be given up on.
   *
   * A ref and not state: it is read inside the connect loop, and a state write there would
   * restart the very effect that is counting.
   */
  const failures = useRef<{ count: number; firstAt: number }>({ count: 0, firstAt: 0 });
  const [degraded, setDegraded] = useState(!stream);

  /** The paired plain GET — the reason a fallback is possible at all. */
  const refresh = useCallback(async () => {
    try {
      const next = await adminEndpoints.controlBoard();
      setView(next);
      setError(null);
      setReadAt(Date.now());
    } catch (err) {
      // The last good view is KEPT. On a wall, stale truth beats no truth — the band above
      // the tiles is what stops it being a lie, and blanking the screen would lose the only
      // information in the building about what should be happening.
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // The first read, always over plain HTTP. A page that waited for a stream to open before
  // showing anything would show nothing at all where the stream cannot be had, which is
  // precisely the deployment this fallback exists for.
  //
  // `refresh` is async: the only thing this effect does synchronously is start a request, and
  // every setState inside it happens in a promise callback. Fetching on mount is the
  // "subscribe to an external system" case the rule's own message carves out.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
  useEffect(() => { void refresh(); }, [refresh]);

  // The poll, while degraded. Suspended by `document.hidden` through the same visibility
  // check every other polling surface here uses: a tablet with the screen off does not need
  // ten requests a minute, and a page that catches up on return is indistinguishable.
  useEffect(() => {
    if (!degraded) return;
    // The mode IS the external state this effect synchronises: a poll has just started, and
    // the line under the heading has to stop saying "live" in the same commit as the first
    // poll rather than one tick later, because that tick is ten seconds long.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    setMode((m) => (m === "lost" ? m : "polling"));
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh();
    }, pollMs);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [degraded, pollMs, refresh]);

  // BA-14 (the console's half): a hidden tab parks its stream. Over plain HTTP/1.1 a browser
  // keeps six connections per host across every tab, and an open stream per hidden tab starved
  // the console's ordinary reads ("Connecting to the club…" for 12 s). Showing the tab again
  // reconnects, and the connect's snapshot catches it up.
  const visible = useSyncExternalStore(subscribeVisibility, tabVisible, () => true);

  useEffect(() => {
    if (!stream || degraded || !visible) return;
    // A browser with no EventSource can never stream, so this is a one-shot capability check
    // and not a render loop: `degraded` is in this effect's deps precisely so that setting it
    // stops the effect running again.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    if (typeof EventSource === "undefined") { setDegraded(true); return; }

    let es: EventSource | null = null;
    let cancelled = false;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let silence: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;

    const clearSilence = () => { if (silence) { clearTimeout(silence); silence = null; } };

    /**
     * Count this failure, and give up on the stream once there have been enough of them
     * close enough together.
     *
     * The WINDOW is what makes the count mean something: three failures over an afternoon is
     * an ordinary network, and three in ninety seconds is a deployment that cannot carry a
     * stream. Without it, a tab left open all day would eventually fall back for ever on the
     * strength of three unrelated blips.
     */
    const noteFailure = () => {
      const now = Date.now();
      const since = now - failures.current.firstAt;
      if (failures.current.count === 0 || since > fallbackWindowMs) {
        failures.current = { count: 1, firstAt: now };
      } else {
        failures.current = { count: failures.current.count + 1, firstAt: failures.current.firstAt };
      }
      if (failures.current.count >= fallbackAfterFailures) setDegraded(true);
    };

    const dropAndRetry = () => {
      clearSilence();
      es?.close();
      es = null;
      noteFailure();
      if (cancelled) return;
      reconnect = setTimeout(() => { void connect(); }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    };

    /** Restarted by every byte the stream delivers; firing means it has gone quiet. */
    const heardFrom = () => {
      clearSilence();
      silence = setTimeout(() => { void refresh(); dropAndRetry(); }, STREAM_SILENCE_MS);
    };

    const connect = async () => {
      if (cancelled) return;
      let ticket: string;
      try {
        ({ ticket } = await adminEndpoints.controlBoardTicket());
      } catch {
        // No ticket, no stream. This counts as a failure, because a ticket endpoint that
        // will not answer is exactly the deployment where streaming is not available.
        dropAndRetry();
        return;
      }
      if (cancelled) return;
      es = new EventSource(adminEndpoints.controlBoardStreamUrl(ticket));
      heardFrom();
      es.onopen = () => { backoffMs = 1000; failures.current = { count: 0, firstAt: 0 }; setMode("live"); heardFrom(); };
      // The full payload, on connect and every `control_board_resync_seconds`. A client that
      // missed a delta self-heals here rather than staying permanently wrong about one court
      // on an unattended screen for the rest of the evening.
      es.addEventListener("snapshot", (e) => {
        heardFrom();
        try {
          setView(JSON.parse((e as MessageEvent).data) as ControlBoardView);
          setError(null);
          setReadAt(Date.now());
          setLoading(false);
        } catch { /* a frame we cannot parse is a frame we ignore */ }
      });
      es.addEventListener("court", (e) => {
        heardFrom();
        try {
          const court = JSON.parse((e as MessageEvent).data) as ControlBoardCourt;
          setView((current) => (current ? applyCourtDelta(current, court) : current));
          setReadAt(Date.now());
        } catch { /* as above */ }
      });
      // The keep-alive carries nothing; all it proves is that the stream is still ours.
      es.addEventListener("ping", heardFrom);
      es.onerror = dropAndRetry;
    };

    void connect();
    return () => {
      cancelled = true;
      if (reconnect) clearTimeout(reconnect);
      clearSilence();
      es?.close();
    };
  }, [stream, degraded, visible, fallbackAfterFailures, fallbackWindowMs, refresh]);

  /*
   * `lost` outranks both live and polling, and it is the one mode derived rather than set:
   * it is true exactly when the most recent read failed, whichever mechanism made it. A page
   * that said "live" over a failed read would be asserting the freshest thing it can say
   * about the stalest thing it holds.
   */
  const resolved: FreshnessMode = error ? "lost" : mode;

  return { view, loading, error, mode: resolved, readAt, refresh };
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

function tabVisible(): boolean {
  return document.visibilityState !== "hidden";
}
