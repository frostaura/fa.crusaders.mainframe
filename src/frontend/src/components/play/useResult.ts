import { useCallback } from "react";
import { memberReads } from "@/lib/offline/memberReads";
import { useCachedRead } from "@/lib/offline/useCachedRead";
import type { BookingResultView, MatchResult } from "@/lib/playApi";

/**
 * A booking's result, read and re-read (§6.1) — the card's three states kept apart.
 *
 * <p>
 * <b>A re-read keeps what is on screen</b>, as the booking detail does: every action ends in a
 * re-read, and blanking the score to a skeleton after a confirm would make the card jump under
 * the thumb that pressed it. <b>An action's own answer is shown at once</b> ({@link ResultRead.adopt}):
 * the server returns the result as it now stands, so the card need not wait for the re-read to
 * say "Confirmed".
 * </p>
 */
export type ResultRead = {
  data: BookingResultView | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  /** Show an action's answer now; the re-read that follows fills in the permissions. */
  adopt: (result: MatchResult) => void;
};

/**
 * `first` — a read of THIS booking's result the page already started (perf: beside the booking's
 * own read, not a round trip after it). Used for the first read only; every re-read asks again.
 */
/** A result read a page started early, and which booking it is for. */
export type EarlyResult = { bookingId: string; read: Promise<BookingResultView> };

export function useResult(bookingId: string, first?: EarlyResult | null): ResultRead {
  // R4 wave B — kept by `lib/offline` (`result:<id>`), so the card draws at once on a revisit and
  // from the phone offline. The page's early read (`first`) goes through the same cache
  // (`BookingDetail`'s `useEarlyResult`), so the card's first read JOINS it rather than repeating
  // it — `first` is only the page saying it started one; every re-read asks the club.
  void first;
  const load = useCallback(() => memberReads.bookingResult(bookingId).load(), [bookingId]);
  const cached = useCachedRead(memberReads.bookingResult(bookingId).key, load, { foreground: false });
  const { patch, reload } = cached;
  const adopt = useCallback((result: MatchResult) => {
    patch((prev) => ({ ...prev, result }));
    reload();
  }, [patch, reload]);
  return { data: cached.data, error: cached.error, loading: cached.loading, reload, adopt };
}
