import { useCallback, useEffect, useState } from "react";
import { playEndpoints, type BookingResultView, type MatchResult } from "@/lib/playApi";

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

type Held = { key: string; id: string; data: BookingResultView | null; error: unknown };

const EMPTY: Held = { key: "", id: "", data: null, error: null };

/**
 * `first` — a read of THIS booking's result the page already started (perf: beside the booking's
 * own read, not a round trip after it). Used for the first read only; every re-read asks again.
 */
/** A result read a page started early, and which booking it is for. */
export type EarlyResult = { bookingId: string; read: Promise<BookingResultView> };

export function useResult(bookingId: string, first?: EarlyResult | null): ResultRead {
  const [nonce, setNonce] = useState(0);
  const [held, setHeld] = useState<Held>(EMPTY);
  const asked = `${bookingId}:${nonce}`;
  const early = nonce === 0 && first?.bookingId === bookingId ? first.read : null;

  useEffect(() => {
    let live = true;
    (early ?? playEndpoints.bookingResult(bookingId)).then(
      (data) => { if (live) setHeld({ key: asked, id: bookingId, data, error: null }); },
      (error: unknown) => {
        if (!live) return;
        setHeld((prev) => ({ key: asked, id: bookingId, data: prev.id === bookingId ? prev.data : null, error }));
      },
    );
    return () => { live = false; };
  }, [asked, bookingId, early]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const adopt = useCallback((result: MatchResult) => {
    setHeld((prev) => (prev.data ? { ...prev, data: { ...prev.data, result } } : prev));
    setNonce((n) => n + 1);
  }, []);
  const same = held.id === bookingId;
  return {
    data: same ? held.data : null,
    error: held.key === asked ? held.error : null,
    loading: held.key !== asked,
    reload,
    adopt,
  };
}
