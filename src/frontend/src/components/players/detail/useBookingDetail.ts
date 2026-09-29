import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { playersEndpoints, type BookingDetail } from "@/lib/playersApi";

/**
 * The booking detail, read and re-read.
 *
 * <p>
 * <b>Unlike `useRead`, a re-read keeps what is on screen.</b> Every action on this page ends in a
 * re-read, and blanking the players to a skeleton after each reminder would make the page jump
 * under the organiser's thumb. What was last read stays until the new answer lands; a failed
 * re-read is said beside it rather than replacing it — except a 404, which means the viewer is
 * no longer on the game at all (they pulled out, or were taken off) and wins over old data.
 * </p>
 */
export type DetailRead = {
  data: BookingDetail | null;
  error: unknown;
  /** The first read, or a re-read, is in flight. */
  loading: boolean;
  /** The API answered 404 — not on it, not there, or not yours to see. */
  notFound: boolean;
  /** When `data` was read, ms since epoch. */
  readAt: number | null;
  reload: () => void;
};

type Held = { key: string; id: string; data: BookingDetail | null; error: unknown; at: number | null };

const EMPTY: Held = { key: "", id: "", data: null, error: null, at: null };

export function useBookingDetail(bookingId: string): DetailRead {
  const [nonce, setNonce] = useState(0);
  const [held, setHeld] = useState<Held>(EMPTY);
  const asked = `${bookingId}:${nonce}`;

  useEffect(() => {
    let live = true;
    playersEndpoints.detail(bookingId).then(
      (data) => { if (live) setHeld({ key: asked, id: bookingId, data, error: null, at: Date.now() }); },
      (error: unknown) => {
        if (!live) return;
        setHeld((prev) => ({ key: asked, id: bookingId, data: prev.id === bookingId ? prev.data : null, error, at: prev.at }));
      },
    );
    return () => { live = false; };
  }, [asked, bookingId]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const same = held.id === bookingId;
  const error = held.key === asked ? held.error : null;
  const notFound = error instanceof ApiError && error.status === 404;
  return {
    data: same && !notFound ? held.data : null,
    error,
    loading: held.key !== asked,
    notFound,
    readAt: same ? held.at : null,
    reload,
  };
}
