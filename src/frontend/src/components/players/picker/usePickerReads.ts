import { useCallback, useEffect, useMemo, useState } from "react";
import { playersEndpoints, type PublicMember, type RecentPartner } from "@/lib/playersApi";

/**
 * The picker's reads: favourites, recent partners and the directory search, each as the same
 * three honest states (reading · failed · the answer), plus the star state the rows share.
 *
 * <p>
 * <b>Keyed, derived state</b> — the pattern `bookFlow.useAdminQuote` set. A read's state is the
 * answer on hand IF it is the answer to the current key, otherwise "reading"; so a slow search for
 * "sa" that lands after the search for "sam" is dropped, and no loading flag is ever set by hand.
 * </p>
 */

export type ReadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: unknown };

type Answer<T> = { key: string; ok: true; data: T } | { key: string; ok: false; error: unknown };

/** Reads `fetcher(key)` whenever `key` changes; null = nothing to read. */
export function useKeyedRead<T>(key: string | null, fetcher: (key: string) => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  const requestKey = key === null ? null : `${key}#${attempt}`;

  useEffect(() => {
    if (key === null || requestKey === null) return undefined;
    let live = true;
    fetcher(key).then(
      (data) => { if (live) setAnswer({ key: requestKey, ok: true, data }); },
      (error: unknown) => { if (live) setAnswer({ key: requestKey, ok: false, error }); },
    );
    return () => { live = false; };
    // `fetcher` is a module-level endpoint at every call site, so it never re-runs this.
  }, [key, requestKey, fetcher]);

  let state: ReadState<T>;
  if (requestKey === null) state = { status: "idle" };
  else if (!answer || answer.key !== requestKey) state = { status: "loading" };
  else state = answer.ok ? { status: "ready", data: answer.data } : { status: "error", error: answer.error };
  return { state, retry: () => setAttempt((n) => n + 1) };
}

const readFavourites = () => playersEndpoints.favourites().then((r) => r.items ?? []);
const readRecent = () => playersEndpoints.recent().then((r) => r.items ?? []);
const searchDirectory = (q: string) => playersEndpoints.directory(q).then((r) => r.items ?? []);

export function useRecent() {
  return useKeyedRead<RecentPartner[]>("recent", readRecent);
}

/** The shortest query the directory answers (D13) — and the debounce before one is sent. */
export const MIN_QUERY = 2;
export const SEARCH_DEBOUNCE_MS = 300;

/** The query, `SEARCH_DEBOUNCE_MS` after the member stopped typing it. */
export function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** The directory search: nothing is asked below two characters, and nothing mid-typing. */
export function useDirectory(query: string) {
  const term = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const read = useKeyedRead<PublicMember[]>(term.length >= MIN_QUERY ? term : null, searchDirectory);
  const typing = query.trim() !== term;
  return { ...read, term, typing };
}

/**
 * Favourites, with the stars changed on this screen laid over the list as read — so a star
 * lands at once (optimistic) and a failed one rolls back, without re-reading the list.
 */
export function useFavourites() {
  const read = useKeyedRead<PublicMember[]>("favourites", readFavourites);
  const [changed, setChanged] = useState<Map<string, PublicMember | null>>(() => new Map());

  const listed = useMemo(() => {
    const base = read.state.status === "ready" ? read.state.data : [];
    const kept = base.filter((m) => changed.get(m.user_id) !== null);
    const added = [...changed.values()].filter((m): m is PublicMember => m !== null && !base.some((b) => b.user_id === m.user_id));
    return [...kept, ...added];
  }, [read.state, changed]);

  const isStarred = useCallback((userId: string) => listed.some((m) => m.user_id === userId), [listed]);

  /** Sets the shown state of one star — the optimistic apply, and the rollback. */
  const show = useCallback((member: PublicMember, starred: boolean) => {
    setChanged((prev) => new Map(prev).set(member.user_id, starred ? member : null));
  }, []);

  return { state: read.state, retry: read.retry, listed, isStarred, show };
}

export type Favourites = ReturnType<typeof useFavourites>;
