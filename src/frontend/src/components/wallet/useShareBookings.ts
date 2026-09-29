import { useEffect, useState } from "react";
import { playersEndpoints, type BookingDetail } from "@/lib/playersApi";

/**
 * What a share line needs to know about its booking that the ledger row does not carry: the
 * court, the day of the game, and who was on it.
 *
 * <p>
 * <b>A ledger row names the booking and nothing else about it</b> — its counterparty is "Club
 * treasury" and its comment "Share of a split booking" (`LedgerRowMapper`), so "Court 1 · Tue
 * 30 Sep" and "from Sam" have to come from the booking itself. Each booking is read once per
 * page view, and a read that fails (a declined or removed seat reads the booking as a stranger
 * does — 404) is remembered as `null`: the line then says "a split booking", which is true.
 * </p>
 */
export type ShareBooking = {
  courtName: string | null;
  startsAt: string;
  organiserId: string | null;
  organiserName: string | null;
  /** Members on the booking other than the organiser, with what they have paid. */
  partners: { userId: string; name: string | null; paid: number }[];
};

/** The most bookings one page will look up — a page of 100 rows rarely names more than a handful. */
export const SHARE_LOOKUP_LIMIT = 20;

export function summariseBooking(detail: BookingDetail): ShareBooking {
  return {
    courtName: detail.court_name,
    startsAt: detail.starts_at,
    organiserId: detail.organiser.user_id,
    organiserName: detail.organiser.name,
    partners: detail.players
      .filter((p) => p.kind === "member" && p.user_id && p.user_id !== detail.organiser.user_id)
      .map((p) => ({ userId: p.user_id as string, name: p.name, paid: p.paid_credits })),
  };
}

/** bookingId → its summary, `null` once a read failed, absent while it is being read. */
export type ShareBookings = Readonly<Record<string, ShareBooking | null>>;

export function useShareBookings(bookingIds: readonly string[]): ShareBookings {
  const [known, setKnown] = useState<ShareBookings>({});
  const wanted = bookingIds.slice(0, SHARE_LOOKUP_LIMIT).join(",");

  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    for (const id of wanted.split(",")) {
      // The effect only starts reads; state is set from each promise, never in the body.
      playersEndpoints.detail(id)
        .then((detail) => summariseBooking(detail))
        .catch(() => null)
        .then((summary) => {
          if (live) setKnown((current) => (id in current ? current : { ...current, [id]: summary }));
        });
    }
    return () => { live = false; };
  }, [wanted]);

  return known;
}
