import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NetworkError, OfflineError, tokenStore } from "../api";
import { useOptionalAuth } from "../useAuth";
import { onForeground } from "./foreground";
import { fetchQuery, getDataOwner, peekQuery, subscribeDataOwner, subscribeQuery, updateQuery } from "./queryCache";

/**
 * One member read, stale-while-revalidate (R4 wave B, "offline & instant").
 *
 * <p>
 * What the club last said for this key is drawn AT ONCE — from memory on a revisit, from the
 * phone on a warm start or with no signal — with its "as of", and the read goes to the club behind
 * it. Three states are still three: no data and in flight is loading; no data and failed is the
 * failure; data is data, and a refresh that failed is said BESIDE it (`stale`), never instead of it.
 * </p>
 */

/** A read this young (ms) — a nav-link prefetch that just landed — is the page's first read. */
export const JOIN_MS = 2_000;
/** Back in the foreground, what is older than this is read again. */
export const FOREGROUND_STALE_MS = 10_000;

export type DataOwner = {
  /** Whose reads these are — null when nobody is signed in on this phone (nothing is cached). */
  who: string | null;
  /** The club may be asked now. False while it cannot be reached, or under a forced password change. */
  live: boolean;
  /** The session check could not reach the club: draw what the phone has. */
  offline: boolean;
  /**
   * R5 V5-2 — and it failed because the club was never reached (no network, a dropped or timed-out
   * connection), as opposed to a club that answered with a failure (a 5xx, a 429). Only this is
   * worded "You're offline"; the other is "Couldn't refresh".
   */
  unreachable: boolean;
  /** The session check is still out (the phone's member is drawn meanwhile, P4-1). */
  checking: boolean;
};

/**
 * Whose reads, and whether to ask the club. While the session check is out (P4-1) or cannot reach
 * the club, the member is the one this phone last CONFIRMED (`lib/auth`), and only with a token —
 * the same two conditions `RequireAuth` lets an offline-capable route render on.
 */
export function useDataOwner(): DataOwner {
  const auth = useOptionalAuth();
  const stored = useSyncExternalStore(subscribeDataOwner, getDataOwner, getDataOwner);
  // No session provider at all (a hook on its own): nobody's reads, kept nowhere, asked freely.
  if (!auth) return { who: null, live: true, offline: false, unreachable: false, checking: false };
  const checking = auth.status === "loading";
  if (auth.status === "authenticated") return { who: auth.userId, live: !auth.mustChangePassword, offline: false, unreachable: false, checking };
  const offline = auth.status === "offline";
  const unreachable = auth.status === "offline" && (auth.cause === undefined || isConnectionFailure(auth.cause));
  if ((checking || offline) && stored && tokenStore.get()) {
    return { who: stored, live: checking, offline, unreachable, checking };
  }
  // Nobody this phone can vouch for yet: a signed-out page asks freely, anything else waits for the check.
  return { who: null, live: auth.status === "anonymous", offline, unreachable, checking };
}

export type CachedRead<T> = {
  data: T | null;
  /** The latest attempt's failure — kept beside data it could not refresh. */
  error: unknown;
  /** An attempt is in flight. */
  loading: boolean;
  /** When `data` was true at the club (ms): the "as of". */
  readAt: number | null;
  /** `data` is the phone's copy and no read in this tab has confirmed it yet. */
  stored: boolean;
  /**
   * `data` is the last-known answer and the club did not confirm it: the session check could not
   * reach the club, or the latest read failed — offline, a 5xx, a 429. Say so with `readAt`
   * (`StaleNotice`); never blank what is on screen for it.
   */
  stale: boolean;
  /**
   * The club could not be reached at all — no network, or the read (or the session check) never
   * got an answer — as opposed to answering with a failure. R5 V5-2: a 503 from the session check
   * is the club answering, so it is NOT offline (it read "You're offline" on three pages while
   * Bookings and Wallet said "Couldn't refresh" for the same outage).
   */
  offline: boolean;
  reload: () => void;
  /** A write's answer applied to what is held, at once (a re-read follows if the caller wants one). */
  patch: (update: (current: T) => T) => void;
};

export type CachedReadOptions = {
  /** Keep it on the phone too (default true). Memory-only otherwise. */
  persist?: boolean;
  /** Re-read on return to the foreground when older than {@link FOREGROUND_STALE_MS} (default true). */
  foreground?: boolean;
  /** Any value; a change reads again at once (a page's own "something changed" counter). */
  refresh?: unknown;
  /**
   * Ask the club while the session check is still out (default true: a page's own reads, which a
   * direct load starts beside its code anyway). False for app-wide readers — the profile — that
   * must not queue beside `whoami` on a cold My Code; they draw the phone's copy meanwhile.
   */
  whileChecking?: boolean;
};

/** The club did not answer at all — as opposed to answering with a refusal. */
export function isConnectionFailure(error: unknown): boolean {
  return error instanceof NetworkError || error instanceof OfflineError;
}

type Answer<T> = { base: string; asked: string; error: unknown; has: boolean; value: T | null; at: number | null };

const noop = () => undefined;

/** What an offline screen with nothing on the phone fails with — one instance, so it is stable across renders. */
const UNREACHABLE = new NetworkError("unreachable");

/**
 * @param key what is read, member-independent ("wallet:page"); null reads nothing.
 * @param load the read itself. The latest is used; it need not be stable.
 */
export function useCachedRead<T>(key: string | null, load: () => Promise<T>, options: CachedReadOptions = {}): CachedRead<T> {
  const { persist = true, foreground = true, refresh = null, whileChecking = true } = options;
  const owner = useDataOwner();
  const { who, offline, unreachable: ownerUnreachable } = owner;
  const live = owner.live && (whileChecking || !owner.checking);
  const subscribe = useCallback((fn: () => void) => (key ? subscribeQuery(who, key, fn) : noop), [who, key]);
  const snapshot = useCallback(() => (key ? peekQuery(who, key) : undefined), [who, key]);
  const entry = useSyncExternalStore(subscribe, snapshot, snapshot);
  const latest = useRef(load);
  useEffect(() => { latest.current = load; });
  const [nonce, setNonce] = useState(0);
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  const base = `${who ?? ""}\u0000${key ?? ""}`;
  const asked = `${base}\u0000${nonce}\u0000${String(refresh)}`;
  // Only the page's FIRST read may take one a link press started a moment ago; a reload or a
  // change the page announced always goes to the club.
  const firstRefresh = useRef(refresh);

  useEffect(() => {
    if (!key || !live) return undefined;
    let alive = true;
    const first = nonce === 0 && Object.is(refresh, firstRefresh.current);
    fetchQuery(who, key, () => latest.current(), { persist, reuseWithinMs: first ? JOIN_MS : 0 }).then(
      (value) => { if (alive) setAnswer({ base, asked, error: null, has: true, value, at: Date.now() }); },
      (error: unknown) => {
        if (!alive) return;
        setAnswer((prev) => (prev && prev.base === base ? { ...prev, asked, error } : { base, asked, error, has: false, value: null, at: null }));
      },
    );
    return () => { alive = false; };
  }, [asked, base, key, live, nonce, persist, refresh, who]);

  // Back in view (or back online): read again what has gone old.
  const ageRef = useRef<number | null>(null);
  const at = entry?.at ?? (answer?.base === base ? answer.at : null);
  useEffect(() => { ageRef.current = at; }, [at]);
  useEffect(() => {
    if (!foreground || !key || !live) return undefined;
    return onForeground(() => {
      const last = ageRef.current;
      if (last === null || Date.now() - last > FOREGROUND_STALE_MS) setNonce((n) => n + 1);
    });
  }, [foreground, key, live]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const patch = useCallback((update: (current: T) => T) => {
    if (!key) return;
    if (who) { updateQuery<T>(who, key, update); return; }
    setAnswer((prev) => (prev && prev.has && prev.value !== null ? { ...prev, value: update(prev.value) } : prev));
  }, [who, key]);

  const mine = answer && answer.base === base ? answer : null;
  const settled = mine && mine.asked === asked ? mine : null;
  const data = key ? (entry ? (entry.value as T) : who ? null : mine?.has ? mine.value : null) : null;
  const failure = settled?.error ?? null;
  const unreachable = offline && data === null && key !== null ? UNREACHABLE : null;
  return {
    data,
    error: failure ?? unreachable,
    // Waiting on the session check is waiting too: the page's skeleton, not an empty page.
    loading: Boolean(key) && (live || owner.checking) && settled === null,
    readAt: data === null ? null : at,
    stored: entry?.source === "stored",
    stale: data !== null && (offline || failure !== null),
    offline: ownerUnreachable || isConnectionFailure(failure),
    reload,
    patch,
  };
}
