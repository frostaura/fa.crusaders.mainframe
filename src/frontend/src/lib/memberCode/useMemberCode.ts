import { useCallback, useEffect, useRef, useState } from "react";
import { readLastIdentity, useAuth } from "../auth";
import { STEP_MS } from "./clubDay";
import { DayKeyCache, memberCodeAt, stepAt, type MemberCodeAt } from "./derive";
import type { MemberCodeRecord } from "./keyStore";
import { loadFor, syncMemberCode, type SyncFailure } from "./lifecycle";

/**
 * The member's rotating code on screen — the key's lifecycle and the clock that turns it into a
 * token every thirty seconds.
 *
 * <p>
 * <b>The code never waits for the network.</b> A key already on the phone renders at once, from
 * the phone's own clock corrected by the last offset the club measured; the exchange with the
 * club runs beside it and only ever refreshes that offset or replaces the key. That is D1's
 * whole promise — a member at a door with no signal has a working code — and it is why the
 * failure of that exchange is a badge, not an error.
 * </p>
 *
 * <p>
 * <b>Whose key.</b> Signed in, the member the server confirmed. With the club unreachable, the
 * member this device last confirmed (`readLastIdentity`) — the same rule the route guard uses to
 * let `/my-code` render offline at all — and a key stored for anybody else is wiped on sight.
 * </p>
 */

export type MemberCodePhase =
  /** Nothing to show yet: the store is being read, or a first enrolment is in flight. */
  | "loading"
  /** A key is on the phone and a code is (or is about to be) on screen. */
  | "ready"
  /** No key, and the club could not be reached — the first visit needs signal. */
  | "needs-signal"
  /** The club's server has no member codes (it predates them). */
  | "unavailable"
  /** Signed out (the session lapsed) and no key on this phone — only signing in can make one. */
  | "signed-out"
  /** The club has barred the member; the key is gone. */
  | "barred"
  /** Anything else — a refusal we do not recognise, a bad answer, a phone that cannot do the maths. */
  | "failed";

export type MemberCodeView = {
  phase: MemberCodePhase;
  /** The token for the current step, or null until the first one is computed. */
  code: MemberCodeAt | null;
  /** Milliseconds left in the current 30-second step, on the club's clock. */
  remainingMs: number;
  /** A code is on screen but the last attempt to reach the club found no answer. */
  offline: boolean;
  /** An exchange with the club is in flight. */
  checking: boolean;
  /** Set when {@link phase} is `barred` — the server's reason code. */
  barredCode: string | null;
  /** Set when {@link phase} is `failed`. Never contains key material. */
  error: unknown;
  /** Ask the club again now. Resolves when the exchange has settled. */
  resync: () => Promise<void>;
  /**
   * F4.1 — the session lapsed and the page is showing the code from the key on this phone for
   * the member it last confirmed. Nothing is asked of the club (there is no session to ask with).
   */
  signedOut: boolean;
};

/** How stale the last exchange may be before a page coming back into view asks again. */
const RESYNC_ON_VISIBLE_MS = 5 * 60_000;

/**
 * Whose key, and whether the club may be asked about it. Signed out, the member this device last
 * confirmed — a lapsed session leaves the key on the phone (F4.1: only a sign-out wipes it) —
 * with no exchange, because there is no session to make one with.
 */
function useIdentity(): { userId: string | null; canAsk: boolean; signedOut: boolean } {
  const auth = useAuth();
  if (auth.status === "authenticated") return { userId: auth.userId, canAsk: true, signedOut: false };
  if (auth.status === "offline") return { userId: readLastIdentity(), canAsk: true, signedOut: false };
  if (auth.status === "anonymous") return { userId: readLastIdentity(), canAsk: false, signedOut: true };
  return { userId: null, canAsk: false, signedOut: false };
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * The phase, derived rather than stored — so it cannot disagree with what the page holds.
 * A key wins over every failure except a bar, because a key makes a good code.
 */
function phaseOf(record: MemberCodeRecord | null, failure: SyncFailure | null, computeFailed: boolean, signedOutEmpty = false): MemberCodePhase {
  if (failure?.kind === "barred") return "barred";
  if (computeFailed) return "failed";
  if (record) return "ready";
  if (signedOutEmpty) return "signed-out";
  if (!failure) return "loading";
  if (failure.kind === "network") return "needs-signal";
  if (failure.kind === "unavailable") return "unavailable";
  return "failed";
}

/** The key and the exchange with the club: load, sync, re-sync on signal and on return. */
function useKey(userId: string | null, canAsk: boolean) {
  const [record, setRecord] = useState<MemberCodeRecord | null>(null);
  /** The phone's store has been read for `userId` — until then "no key" is not known. */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [failure, setFailure] = useState<SyncFailure | null>(null);
  const [checking, setChecking] = useState(false);
  const inflight = useRef<Promise<void> | null>(null);
  const lastSync = useRef(0);
  const current = useRef<MemberCodeRecord | null>(null);

  const sync = useCallback((who: string): Promise<void> => {
    if (inflight.current) return inflight.current;
    setChecking(true);
    const run = (async () => {
      try {
        const result = await syncMemberCode(who, current.current);
        current.current = result.record;
        setRecord(result.record);
        setFailure("failure" in result ? result.failure : null);
        lastSync.current = Date.now();
      } finally {
        inflight.current = null;
        setChecking(false);
      }
    })();
    inflight.current = run;
    return run;
  }, []);

  // Load what the phone holds, paint it, THEN ask the club — in that order, so a member with no
  // signal is never kept waiting on a request that will not come back.
  useEffect(() => {
    if (!userId) return;
    let live = true;
    void (async () => {
      const stored = await loadFor(userId);
      if (!live) return;
      current.current = stored;
      setRecord(stored);
      setLoadedFor(userId);
      if (canAsk) await sync(userId);
    })();
    return () => { live = false; };
  }, [userId, canAsk, sync]);

  // Signal came back, or the member came back to the page after a while: ask again.
  useEffect(() => {
    if (!userId || !canAsk) return;
    const onOnline = () => { void sync(userId); };
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastSync.current > RESYNC_ON_VISIBLE_MS) void sync(userId);
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId, canAsk, sync]);

  const resync = useCallback(() => (userId && canAsk ? sync(userId) : Promise.resolve()), [userId, canAsk, sync]);
  const signedOutEmpty = !canAsk && !record && userId !== null && loadedFor === userId;
  return { record, failure, checking, resync, signedOutEmpty };
}

/**
 * Wall-clock milliseconds, re-read on every whole second of the CLUB's clock and whenever the
 * page comes back into view. Read off the clock rather than counted: a phone locked in a pocket
 * fires no timers, and must wake showing the code for now, not for when it slept.
 */
function useSecondClock(offsetMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const corrected = Date.now() + offsetMs;
      timer = setTimeout(() => { setNow(Date.now()); schedule(); }, 1000 - (((corrected % 1000) + 1000) % 1000) + 5);
    };
    const read = () => setNow(Date.now());
    schedule();
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    window.addEventListener("pageshow", read);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("focus", read);
      window.removeEventListener("pageshow", read);
    };
  }, [offsetMs]);
  return now;
}

export function useMemberCode(): MemberCodeView {
  const { userId, canAsk, signedOut } = useIdentity();
  const { record, failure, checking, resync, signedOutEmpty } = useKey(userId, canAsk);
  const now = useSecondClock(record?.offsetMs ?? 0);
  const corrected = now + (record?.offsetMs ?? 0);
  const step = stepAt(corrected);
  const [computed, setComputed] = useState<{ code: MemberCodeAt; record: MemberCodeRecord } | null>(null);
  const [computeFailed, setComputeFailed] = useState(false);
  const cache = useRef(new DayKeyCache());

  useEffect(() => {
    if (!record) return;
    let live = true;
    memberCodeAt(record.key, record.ref, record.tz, step, cache.current).then(
      (code) => { if (live) { setComputed({ code, record }); setComputeFailed(false); } },
      () => { if (live) setComputeFailed(true); },
    );
    return () => { live = false; };
  }, [record, step]);

  // A code computed from a key the page no longer holds is not shown — not for one frame. The
  // SAME key under a refreshed record (a new clock offset, a new zone) keeps its code on screen
  // while the next one is made: blanking it on every exchange with the club told the self-check,
  // and the member, that the code had run out.
  const sameKey = !!record && !!computed && computed.record.key === record.key && computed.record.ref === record.ref;
  const code = sameKey ? computed!.code : null;
  return {
    phase: phaseOf(record, failure, computeFailed, signedOutEmpty),
    code,
    remainingMs: STEP_MS - (((corrected % STEP_MS) + STEP_MS) % STEP_MS),
    offline: !!record && (failure?.kind === "network" || isOffline()),
    checking,
    barredCode: failure?.kind === "barred" ? failure.code : null,
    error: failure?.kind === "failed" ? failure.error : null,
    resync,
    signedOut,
  };
}
