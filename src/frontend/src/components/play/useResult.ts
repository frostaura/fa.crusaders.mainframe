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

export function useResult(bookingId: string): ResultRead {
  const [nonce, setNonce] = useState(0);
  const [held, setHeld] = useState<Held>(EMPTY);
  const asked = `${bookingId}:${nonce}`;

  useEffect(() => {
    let live = true;
    playEndpoints.bookingResult(bookingId).then(
      (data) => { if (live) setHeld({ key: asked, id: bookingId, data, error: null }); },
      (error: unknown) => {
        if (!live) return;
        setHeld((prev) => ({ key: asked, id: bookingId, data: prev.id === bookingId ? prev.data : null, error }));
      },
    );
    return () => { live = false; };
  }, [asked, bookingId]);

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
