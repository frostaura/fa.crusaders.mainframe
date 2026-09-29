import { useEffect, useState } from "react";
import { playersEndpoints, type BookingDetail } from "@/lib/playersApi";

/** Who else is on one booking: first names, "loading", or "failed" — three states, not two. */
export type OthersState = readonly string[] | "loading" | "failed";

/** Everybody on the booking but the member whose page this is — organiser included — first names. */
export function othersOn(detail: BookingDetail, memberId: string): string[] {
  const organiser = detail.organiser.user_id !== memberId && detail.organiser.name ? [detail.organiser.name] : [];
  const players = detail.players
    .filter((p) => p.user_id !== memberId && p.user_id !== detail.organiser.user_id && p.name)
    .map((p) => p.name as string);
  return [...organiser, ...players].map((name) => name.trim().split(/\s+/)[0]);
}

/**
 * D9 — the other players on each of a member's next bookings, for the admin Overview. The
 * member-detail answer carries no players, so each booking's own page is read (an admin may read
 * any; the list is capped at five by the server). Keyed by booking id; re-read when the set changes.
 */
export function useOthersOnCourt(bookingIds: readonly string[], memberId: string): Record<string, OthersState> {
  const key = bookingIds.join(",");
  const [state, setState] = useState<Record<string, OthersState>>({});
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new set of bookings starts every row loading
    setState(Object.fromEntries(ids.map((id) => [id, "loading" as const])));
    for (const id of ids) {
      playersEndpoints.detail(id)
        .then((d) => { if (live) setState((s) => ({ ...s, [id]: othersOn(d, memberId) })); })
        .catch(() => { if (live) setState((s) => ({ ...s, [id]: "failed" })); });
    }
    return () => { live = false; };
  }, [key, memberId]);
  return state;
}
