import { useEffect, useState } from "react";
import { playersEndpoints, type BookingDetail } from "@/lib/playersApi";

/** Who else is on one booking: first names, "loading", or "failed" — three states, not two. */
export type OthersState = readonly string[] | "loading" | "failed";

/** Everybody on the booking but the member whose page this is — organiser included — first names. */
export function othersOn(detail: BookingDetail, memberId: string, memberName?: string | null): string[] {
  const organiser = detail.organiser.user_id !== memberId && detail.organiser.name ? [detail.organiser.name] : [];
  const players = detail.players
    .filter((p) => p.user_id !== memberId && p.user_id !== detail.organiser.user_id && p.name)
    .map((p) => p.name as string);
  const full = [...organiser, ...players].map((name) => name.trim());
  const first = (name: string) => name.split(/\s+/)[0];
  // First names, unless two people on the court share one — or share it with the member whose
  // page this is: "Booked by the member with Sam" named nobody when there were two Sams (F3-13).
  const firsts = [...full, ...(memberName ? [memberName.trim()] : [])].map(first);
  const clash = (name: string) => firsts.filter((f) => f === first(name)).length > 1;
  return full.map((name) => (clash(name) ? name : first(name)));
}

/**
 * D9 — the other players on each of a member's next bookings, for the admin Overview. The
 * member-detail answer carries no players, so each booking's own page is read (an admin may read
 * any; the list is capped at five by the server). Keyed by booking id; re-read when the set changes.
 */
export function useOthersOnCourt(bookingIds: readonly string[], memberId: string, memberName?: string | null): Record<string, OthersState> {
  const key = bookingIds.join(",");
  const [state, setState] = useState<Record<string, OthersState>>({});
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new set of bookings starts every row loading
    setState(Object.fromEntries(ids.map((id) => [id, "loading" as const])));
    for (const id of ids) {
      playersEndpoints.detail(id)
        .then((d) => { if (live) setState((s) => ({ ...s, [id]: othersOn(d, memberId, memberName) })); })
        .catch(() => { if (live) setState((s) => ({ ...s, [id]: "failed" })); });
    }
    return () => { live = false; };
  }, [key, memberId, memberName]);
  return state;
}
