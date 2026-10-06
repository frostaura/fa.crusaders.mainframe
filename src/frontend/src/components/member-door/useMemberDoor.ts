import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, NetworkError, endpoints, errorCode, type MemberDoor } from "../../lib/api";
import { readLastKnown, rememberDoor } from "../../lib/lastKnown";
import type { ReadFailure } from "../../lib/memberDoorCopy";

/**
 * The one read that carries the member's whole door picture, and how often it is made.
 *
 * <p>
 * <b>Hot and cold.</b> Five seconds while something is happening — a decision inside the
 * last two minutes, the first five minutes after the page was opened, or a `too_early`
 * window the member is waiting out — and thirty otherwise. A member at a door has just
 * held their code up and wants the answer inside fifteen seconds; a member on the sofa
 * costs the club nothing either way, and a phone in a pocket should cost it nothing at
 * all.
 * </p>
 *
 * <p>
 * <b>Nothing polls while the page is hidden</b>, and the moment it is shown again the
 * read happens at once, bypassing the backoff. The same triple the code countdown already
 * listens on — `visibilitychange`, `focus`, `pageshow` — plus `online`, because regaining
 * signal is exactly the instant a member standing in a doorway wants answered.
 * </p>
 */

const HOT_MS = 5_000;
const COLD_MS = 30_000;

/** 5 → 10 → 20 → 30, capped. The request storm this page already learned about once. */
const BACKOFF_MS = [5_000, 10_000, 20_000, 30_000];

/** How long after the page opens it stays hot, whatever the server has said. */
const HOT_AFTER_OPEN_MS = 5 * 60_000;

/** The server's own fetch window for a decision, mirrored so the cadence agrees with it. */
const DECISION_HOT_MS = 2 * 60_000;

export type MemberDoorRead = {
  /** The last good answer, or null if none has ever landed in this tab. */
  door: MemberDoor | null;
  /** The last attempt failed. Not the same thing as having no answer — see the page. */
  failed: boolean;
  /**
   * WHICH failure it was, or null while the last read succeeded.
   *
   * <p>
   * <b>The page used to know only that something had failed, and said the wrong thing
   * about half of them.</b> On an HTTP 500 from the club's own API it told the member
   * "Your phone can't reach the club" and scored "This phone's line to the club ✗" —
   * about a phone that had just carried the request there and brought an answer back. A
   * {@link NetworkError} is the only failure that is the member's signal; everything else
   * arrived, which makes it the club's system, which is a different thing to do next.
   * </p>
   */
  failure: ReadFailure | null;
  /** No answer has landed yet and one is in flight. */
  loading: boolean;
  /** When the answer in `door` was read. ISO, or null if none has ever landed. D6. */
  readAt: string | null;
  /** Read now, ignoring the pacing. What `The door didn't open` and Try again call. */
  refresh: () => Promise<void>;
};

/**
 * Whose failure was it — read off the error's own type rather than guessed.
 *
 * <p>
 * `NetworkError` is thrown only when the request produced no response at all: the socket
 * was refused, the network dropped, or the server took it and never answered. Anything
 * else — an `ApiError`, or a bug of our own — means a round trip happened, so the phone's
 * line to the club demonstrably works and the fault is on the far end of it.
 * </p>
 */
function classify(error: unknown): ReadFailure {
  if (error instanceof NetworkError) return "network";
  // R19 X19-1.3 — the club answered, but busy (429, 503 service_busy) or mid-clash (503
  // conflict_retry): both pass by themselves, and neither is "an error".
  if (error instanceof ApiError && error.status === 429) return "busy";
  const code = error instanceof ApiError && error.status === 503 ? errorCode(error) : null;
  if (code === "service_busy") return "busy";
  if (code === "conflict_retry") return "clash";
  return "server";
}

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * Is there something happening that the member is watching?
 *
 * <p>
 * The third arm is the one that is easy to miss: a `too_early` countdown can run for
 * longer than the decision stays inside the server's window, and a member standing
 * outside watching it tick is the single most attentive reader this page ever has.
 * </p>
 */
function isHot(door: MemberDoor | null, openedAt: number): boolean {
  if (Date.now() - openedAt < HOT_AFTER_OPEN_MS) return true;
  const decision = door?.last_decision;
  if (decision && Date.now() - Date.parse(decision.at) < DECISION_HOT_MS) return true;
  const opensAt = door?.next_booking?.door_opens_at;
  return !!decision && decision.reason === "too_early" && !!opensAt && Date.parse(opensAt) > Date.now();
}

function nextGap(failures: number, door: MemberDoor | null, openedAt: number): number {
  if (failures > 0) return BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
  return isHot(door, openedAt) ? HOT_MS : COLD_MS;
}

export function useMemberDoor(enabled: boolean): MemberDoorRead {
  const [door, setDoor] = useState<MemberDoor | null>(null);
  /** D6 — when `door` was read, so a page serving it through a failure can say how old it is. */
  const [readAt, setReadAt] = useState<string | null>(null);
  const [failure, setFailure] = useState<ReadFailure | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [visible, setVisible] = useState(isVisible);
  /** Bumped by every settled read, which is what reschedules the next one. */
  const [settled, setSettled] = useState(0);
  const failures = useRef(0);
  const inflight = useRef(false);
  /** A lazy initialiser, not `useRef(Date.now())` — the clock is not pure to read in a render. */
  const [openedAt] = useState(() => Date.now());
  const doorNow = useRef<MemberDoor | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled || inflight.current) return;
    inflight.current = true;
    try {
      const next = await endpoints.meDoor();
      failures.current = 0;
      doorNow.current = next;
      setDoor(next);
      setReadAt(new Date().toISOString());
      setFailure(null);
      // Written on every success, so a cold start with no signal paints something.
      rememberDoor(next);
    } catch (error) {
      // Which sentence a failure earns is the page's call, not this hook's: a failed
      // read with a cached copy and a failed read without one are different silences.
      // WHOSE failure it was is this hook's call, because the error object is the only
      // place that fact survives, and it is gone by the time the page renders.
      failures.current += 1;
      setFailure(classify(error));
    } finally {
      inflight.current = false;
      setLoading(false);
      setSettled((n) => n + 1);
    }
  }, [enabled]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader, the house idiom
  useEffect(() => { void refresh(); }, [refresh]);

  // A phone pulled out of a pocket, a tab brought forward, a page restored from the
  // back-forward cache, and a network that has just come back: all four are answered at
  // once rather than on the next tick of whatever gap was running.
  useEffect(() => {
    if (!enabled) return;
    const wake = () => {
      const now = isVisible();
      setVisible(now);
      if (now) void refresh();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("online", wake);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || !visible) return;
    // A club with no door has nothing to poll for. One read settles it; polling on from
    // there would be thirty seconds of nothing, forever, on every member's phone.
    if (doorNow.current && !doorNow.current.doors) return;
    const timer = setTimeout(() => void refresh(), nextGap(failures.current, doorNow.current, openedAt));
    return () => clearTimeout(timer);
  }, [enabled, visible, settled, refresh, openedAt]);

  return { door, failed: failure !== null, failure, loading, readAt, refresh };
}

/**
 * Which decision is on screen, and what taking it off screen means.
 *
 * <p>
 * Two minutes is the SERVER's fetch window, not a display window. A card that vanishes
 * mid-sentence while a cold member is reading it is a defect, and on a five-second poll
 * that boundary lands mid-read for somebody — so once a decision has been adopted it
 * stays until a NEWER one supersedes it or the member dismisses it, whatever the response
 * stops carrying.
 * </p>
 *
 * <p>
 * The second effect is the `not_recognised` arm. That reason means the code in the
 * member's hand was dead, so the page fetches a fresh one on its own rather than waiting
 * to be asked; the button on that card is for the member who wants to watch it happen.
 * Once per decision, tracked by its own timestamp, never in a loop.
 * </p>
 */
export function useShownDecision(door: MemberDoor | null, refreshCode: () => void) {
  const [shown, setShown] = useState<MemberDoor["last_decision"]>(null);
  const dismissedAt = useRef<string | null>(null);
  const chased = useRef<string | null>(null);

  useEffect(() => {
    const latest = door?.last_decision;
    if (!latest || dismissedAt.current === latest.at) return;
    setShown((current) => (current?.at === latest.at ? current : latest));
  }, [door]);

  useEffect(() => {
    const latest = door?.last_decision;
    if (!latest || latest.released || latest.reason !== "not_recognised") return;
    if (chased.current === latest.at) return;
    chased.current = latest.at;
    refreshCode();
  }, [door, refreshCode]);

  const dismiss = useCallback(() => {
    setShown((current) => {
      if (current) dismissedAt.current = current.at;
      return null;
    });
  }, []);

  return { shown, dismiss };
}

/**
 * Does this club have a door at all — nothing more, and in THREE answers.
 *
 * <p>
 * For the Home tile, which forks one clause of one hint on it, and for the Profile page's
 * door-history section. It is seeded from the last-known store so a returning member gets
 * the right answer before the request lands.
 * </p>
 *
 * <p>
 * <b>D11: a failed read used to answer "no", and that deleted a member's own record.</b> A
 * `/me/door` that did not land left this false, so the Profile page rendered no door history
 * at all — for a member whose history endpoint was working perfectly and had rows in it. The
 * club with no door must stay SILENT, which is why the flag exists; a club this page could
 * not ask about is a different thing and now says so, and the history card decides for itself
 * from rows it actually has.
 * </p>
 */
export type DoorsKnowledge = "yes" | "no" | "unknown";

export function useDoorsFlag(): DoorsKnowledge {
  const [doors, setDoors] = useState<DoorsKnowledge>(
    () => (readLastKnown().door?.value.doors === true ? "yes" : "unknown"),
  );

  useEffect(() => {
    let live = true;
    endpoints.meDoor()
      .then((next) => {
        if (!live) return;
        setDoors(next.doors === true ? "yes" : "no");
        rememberDoor(next);
      })
      // Still silent — but silent about the DOOR, not about the member's own record. The
      // caller is told the question went unanswered rather than answered "no".
      .catch(() => { if (live) setDoors("unknown"); });
    return () => { live = false; };
  }, []);

  return doors;
}
