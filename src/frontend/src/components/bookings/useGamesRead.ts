import { useEffect, useRef, useState } from "react";

/**
 * A list of the member's games (upcoming, recent), read again whenever `refreshKey` changes.
 *
 * <p>
 * Three states, never two: loading, ready (possibly empty) and failed. A re-read keeps the list
 * it had rather than flashing empty under a member's thumb.
 * </p>
 */
export type GamesState<T> =
  | { status: "loading" }
  | { status: "ready"; items: T[]; timezone: string | undefined }
  | { status: "error" };

export function useGamesRead<T>(read: () => Promise<{ timezone?: string; items?: T[] }>, refreshKey: unknown) {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; state: GamesState<T> } | null>(null);
  const latest = useRef(read);
  useEffect(() => { latest.current = read; });
  const key = `${String(refreshKey)}|${attempt}`;
  useEffect(() => {
    let live = true;
    latest.current().then(
      (res) => { if (live) setAnswer({ key, state: { status: "ready", items: res.items ?? [], timezone: res.timezone } }); },
      () => { if (live) setAnswer({ key, state: { status: "error" } }); },
    );
    return () => { live = false; };
  }, [key]);
  const state: GamesState<T> = answer ? answer.state : { status: "loading" };
  return { state, retry: () => setAttempt((n) => n + 1) };
}
