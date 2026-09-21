import { useCallback, useEffect, useRef, useState } from "react";
import { endpoints, type MyQrCode, type MyQrKind } from "../../lib/api";
import { describeCourtCodeFetchFailure, describeCourtCodeRefusal } from "../../lib/bookingErrors";
import { type Deadline, deadlineFor, secondsUntil } from "../../lib/countdown";
import { readWalkUpChoice, rememberQr, rememberWalkUpChoice } from "../../lib/lastKnown";

/**
 * The code's own lifecycle: getting one, counting it down, and replacing it before it dies.
 *
 * <p>
 * <b>Why it is a hook rather than the top of the page.</b> None of this is about doors.
 * It is the pacing, the pre-fetch, the not-rotated chase and the barred dead end — five
 * pieces of machinery that existed before the gate shipped and that the door work only
 * ever reads the output of. Left inline they made `MyCodePage` a function with thirty
 * branches, which `make complexity` is right to refuse: a render nobody can check by
 * reading is a render where the next door block gets added to the wrong arm.
 * </p>
 *
 * <p>
 * Nothing about the behaviour moved. Every comment below was written where it was found.
 * </p>
 */

/**
 * The generate endpoint sits behind the API's auth rate-limit bucket, which is shared
 * with login — and, until forwarded headers are honoured, shared by everyone behind the
 * club's gateway. This gap bounds what one open page can cost it: at most one call
 * every ten seconds, whatever the server says a code's lifetime is.
 */
const MIN_REFRESH_GAP_MS = 10_000;

/** How long before expiry the next code is fetched. Ten seconds covers a slow fetch with room to spare. */
export const PREFETCH_LEAD_S = 10;

/**
 * The gap between re-polls when the server answered a pre-fetch with the code the page
 * already holds.
 *
 * <p>
 * A code that is about to die and a server that keeps handing it back is the whole of
 * the dead-QR window: waiting {@link MIN_REFRESH_GAP_MS} between attempts guarantees
 * the code reaches zero first. The server mints a fresh one once the current has less
 * than the lead time left, so in practice this fires at most once — but the page must
 * not depend on that, because a server that reuses is exactly what shipped.
 * </p>
 */
const NOT_ROTATED_GAP_MS = 2_000;

/**
 * How many times in a row the page will chase a code the server would not rotate.
 * Bounded, so a server that will never rotate costs a handful of requests per code
 * rather than one every two seconds for as long as the page is open.
 */
const MAX_NOT_ROTATED_TRIES = 3;

export type MemberCode = {
  qr: MyQrCode | null;
  secondsLeft: number;
  loading: boolean;
  error: string | null;
  /** The club has barred this member. The page stops asking by itself; the member can. */
  barred: string | null;
  /** On: ask for an ident code outright, whatever bookings the member has. */
  walkUp: boolean;
  /** Ask for a code now. Refresh, Try again and the barred card's Check again all mean this. */
  refetch: () => void;
  /** The same, awaitable — the self-diagnosis waits for both its reads to settle. */
  refetchAsync: () => Promise<void>;
  chooseWalkUp: (next: boolean) => void;
};

export function useMemberCode(): MemberCode {
  const [qr, setQr] = useState<MyQrCode | null>(null);
  const [deadline, setDeadline] = useState<Deadline | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Seeded from the session rather than from `false`. A member who turned it on at the
   * desk, put the phone away and opened the page again found it off and their booking
   * code back — the switch having silently undone the decision they had just made. See
   * `readWalkUpChoice`.
   */
  const [walkUp, setWalkUp] = useState(readWalkUpChoice);
  const [barred, setBarred] = useState<string | null>(null);
  /** `barred`, read inside the fetch — state is a frame stale there, and which card is on
   *  screen decides how a failure is worded. See `describeCourtCodeFetchFailure`. */
  const barredNow = useRef<string | null>(null);
  const lastFetchAt = useRef(0);
  const inflight = useRef(false);
  /** The code a pre-fetch was last made for, so the same code is not pre-fetched over and over as it runs out. */
  const prefetchedFor = useRef<string | null>(null);
  /** The code currently held, read inside the fetch — state would be a frame stale there. */
  const held = useRef<string | null>(null);
  /** Consecutive pre-fetches that answered with the code already held. See NOT_ROTATED_GAP_MS. */
  const notRotated = useRef(0);

  /** The half of a successful fetch that is bookkeeping, so the branch above stays readable. */
  const adopt = useCallback((next: MyQrCode, mode: "replace" | "prefetch") => {
    // Did anything actually change hands? The server is entitled to answer with the
    // code the page already holds — it reuses one that has not expired — and that
    // answer is not a rotation however healthy the request looked. Counting it lets
    // the pre-fetch effect chase it instead of declaring victory over a dying QR.
    const rotated = next.code !== held.current;
    notRotated.current = mode === "prefetch" && !rotated ? notRotated.current + 1 : 0;
    held.current = next.code;
    // One batch: code, deadline and countdown move together, so no render ever shows
    // the new code with the old clock or the old code with the new one. The deadline
    // is re-read even on a reused code: the server's remaining time is the truth, and
    // it is what makes the countdown honest about how little is left.
    setQr(next);
    setDeadline(deadlineFor(next.expires_in_seconds));
    setSecondsLeft(next.expires_in_seconds);
    setError(null);
    // doors: member — written on every success, with the lifetime resolved to an
    // absolute instant, so a cold start with no signal has something to paint and can
    // never paint it as live. See lib/lastKnown.ts.
    rememberQr(next);
    // A code in hand is the club saying the bar is lifted; without this the page would
    // render the suspension sentence over a perfectly good code. The dead end, other side.
    setBarred(null);
    barredNow.current = null;
  }, []);

  /** The other half: a refusal the club made, or a minute the network had. */
  const absorb = useCallback((e: unknown, mode: "replace" | "prefetch") => {
    // Surfaced on BOTH modes. A pre-fetch is silent about every other failure, but a
    // member suspended while this page was open must not go on holding a dead code.
    const refused = describeCourtCodeRefusal(e);
    if (refused !== null) {
      setBarred(refused);
      barredNow.current = refused;
      setQr(null);
      setDeadline(null);
      setError(null);
      return;
    }
    // Which card is asking decides the wording: see describeCourtCodeFetchFailure.
    if (mode === "replace") setError(describeCourtCodeFetchFailure(e, barredNow.current !== null ? "barred" : "code"));
  }, []);

  /**
   * Gets a code. "replace" is what the member sees happening — first load, the Refresh
   * button, the walk-up switch, or a code that died with nothing ready; "prefetch" is
   * silent, and a failure is left for the expiry path to surface, by which time it may
   * well have cleared.
   */
  const fetchCode = useCallback(async (mode: "replace" | "prefetch", kind: MyQrKind | undefined) => {
    if (inflight.current) return;
    inflight.current = true;
    lastFetchAt.current = Date.now();
    if (mode === "replace") {
      setLoading(true);
      setError(null);
    }
    try {
      adopt(await endpoints.meQrGenerate(kind), mode);
    } catch (e) {
      absorb(e, mode);
    } finally {
      inflight.current = false;
      if (mode === "replace") setLoading(false);
    }
  }, [adopt, absorb]);

  /** The switch. A different code is wanted now, so one is fetched now. */
  const chooseWalkUp = useCallback((next: boolean) => {
    setWalkUp(next);
    rememberWalkUpChoice(next);
    prefetchedFor.current = null;
    void fetchCode("replace", next ? "ident" : undefined);
  }, [fetchCode]);

  // The FIRST fetch has to honour the remembered choice too, and re-reads it rather than
  // closing over `walkUp`: this effect is a mount-only loader, and a reactive dependency
  // on the switch would re-run it on every toggle beside `chooseWalkUp`'s own fetch.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader, the house idiom
  useEffect(() => { void fetchCode("replace", readWalkUpChoice() ? "ident" : undefined); }, [fetchCode]);

  // The countdown is read off the clock, once a second while the page is visible and
  // again the moment it becomes visible. A tick that never fired — the phone was
  // locked — therefore costs nothing: the next read is right.
  useEffect(() => {
    if (!deadline) return;
    const read = () => setSecondsLeft(secondsUntil(deadline));
    const timer = setInterval(read, 1000);
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    window.addEventListener("pageshow", read);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("focus", read);
      window.removeEventListener("pageshow", read);
    };
  }, [deadline]);

  // The next code is fetched PREFETCH_LEAD_S before this one dies and swapped in at
  // once, so the member is never holding up a dead code. A code that has already died
  // — the pre-fetch failed, or the server handed one back already expired — is replaced
  // visibly. Both are paced so neither can turn into a request storm.
  useEffect(() => {
    if (!qr || loading || secondsLeft > PREFETCH_LEAD_S) return;
    const expired = secondsLeft === 0;
    // A pre-fetch answered with the code already on screen: nothing rotated, the member
    // is still holding one that is about to die, and waiting out the pacing gap is what
    // guarantees it dies. Try again on the short gap, a bounded number of times.
    const stalled = !expired && notRotated.current > 0;
    if (stalled && notRotated.current > MAX_NOT_ROTATED_TRIES) return;
    if (!expired && !stalled && prefetchedFor.current === qr.code) return;
    const gap = stalled ? NOT_ROTATED_GAP_MS : MIN_REFRESH_GAP_MS;
    const wait = Math.max(0, gap - (Date.now() - lastFetchAt.current));
    const kind = walkUp ? "ident" : undefined;
    const timer = setTimeout(() => {
      if (!expired) prefetchedFor.current = qr.code;
      void fetchCode(expired ? "replace" : "prefetch", kind);
    }, wait);
    return () => clearTimeout(timer);
  }, [qr, loading, secondsLeft, walkUp, fetchCode]);

  const refetchAsync = useCallback(
    () => fetchCode("replace", walkUp ? "ident" : undefined),
    [fetchCode, walkUp],
  );
  const refetch = useCallback(() => { void refetchAsync(); }, [refetchAsync]);

  return { qr, secondsLeft, loading, error, barred, walkUp, refetch, refetchAsync, chooseWalkUp };
}
