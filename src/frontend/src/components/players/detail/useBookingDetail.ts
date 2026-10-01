import { useCallback, useEffect } from "react";
import { ApiError } from "@/lib/api";
import { memberReads } from "@/lib/offline/memberReads";
import { dropQuery } from "@/lib/offline/queryCache";
import { useCachedRead, useDataOwner } from "@/lib/offline/useCachedRead";
import type { BookingDetail } from "@/lib/playersApi";

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
 *
 * <p>
 * R4 wave B — kept by `lib/offline` (`booking:<id>`): a revisit or a warm start draws the last
 * answer at once, and an offline open draws the phone's copy with its "as of" (`stale`). A 404
 * also forgets the copy — on this phone as well as on screen.
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
  /** `data` is what the phone last had, shown because the club could not be reached. */
  stale: boolean;
  /** ...and the club could not be reached at all (as opposed to answering with a failure). */
  offline?: boolean;
  reload: () => void;
};

export function useBookingDetail(bookingId: string): DetailRead {
  const key = memberReads.booking(bookingId).key;
  const load = useCallback(() => memberReads.booking(bookingId).load(), [bookingId]);
  const cached = useCachedRead(key, load, { foreground: false });
  const { who } = useDataOwner();
  const notFound = cached.error instanceof ApiError && cached.error.status === 404;
  useEffect(() => { if (notFound) dropQuery(who, key); }, [notFound, who, key]);
  return {
    data: notFound ? null : cached.data,
    error: cached.error,
    loading: cached.loading,
    notFound,
    readAt: notFound ? null : cached.readAt,
    stale: cached.stale,
    offline: cached.offline,
    reload: cached.reload,
  };
}
