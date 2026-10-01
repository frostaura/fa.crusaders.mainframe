import { useCachedRead } from "@/lib/offline/useCachedRead";

/**
 * A list of the member's games (upcoming, recent), read again whenever `refreshKey` changes.
 *
 * <p>
 * Three states, never two: loading, ready (possibly empty) and failed. A re-read keeps the list
 * it had rather than flashing empty under a member's thumb.
 * </p>
 *
 * <p>
 * R4 wave B — kept by `lib/offline` under `key`: a revisit draws the last list at once, a warm
 * start and an offline open draw the phone's copy. The Bookings page re-reads on return itself
 * (`useScheduleLiveness` bumps `refreshKey`), so this does not add its own foreground read.
 * </p>
 */
export type GamesState<T> =
  | { status: "loading" }
  | { status: "ready"; items: T[]; timezone: string | undefined }
  | { status: "error" };

export function useGamesRead<T>(read: () => Promise<{ timezone?: string; items?: T[] }>, refreshKey: unknown, key: string) {
  const cached = useCachedRead(key, read, { foreground: false, refresh: refreshKey });
  const { data, error } = cached;
  const state: GamesState<T> = data
    ? { status: "ready", items: data.items ?? [], timezone: data.timezone }
    : error ? { status: "error" } : { status: "loading" };
  return { state, retry: cached.reload };
}
