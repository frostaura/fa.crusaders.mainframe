import { useEffect, useMemo, useState } from "react";
import { playersEndpoints, type BookingDetail } from "@/lib/playersApi";

/** Who else is on one booking: first names, "loading", or "failed" — three states, not two. */
export type OthersState = readonly string[] | "loading" | "failed";

/**
 * Everybody on the booking but the member whose page this is — organiser included, unless the
 * row already names them — as full names.
 *
 * <p>
 * `withoutOrganiser` (review round 3, A-14): on the member's partner row the line already says
 * "Playing as Sam Naidoo's partner", and "with Sam" after it named the organiser a second time.
 * </p>
 */
export function everyoneOn(detail: BookingDetail, memberId: string, withoutOrganiser = false): string[] {
  const organiser = !withoutOrganiser && detail.organiser.user_id !== memberId && detail.organiser.name
    ? [detail.organiser.name] : [];
  const players = detail.players
    .filter((p) => p.user_id !== memberId && p.user_id !== detail.organiser.user_id && p.name)
    .map((p) => p.name as string);
  return [...organiser, ...players].map((name) => name.trim());
}

const first = (name: string) => name.split(/\s+/)[0];

/**
 * First names, unless two DIFFERENT people share one — anywhere in the list, or with the member
 * whose page this is. It was decided per booking (F3-13), so two different Sams on two rows both
 * read "with Sam" (review round 3, A-14). The same person on two rows is not a clash.
 */
export function shortenAcross(lists: ReadonlyArray<readonly string[]>, memberName?: string | null): (name: string) => string {
  const people = new Set([...lists.flat(), ...(memberName ? [memberName.trim()] : [])]);
  const counts = new Map<string, number>();
  for (const person of people) counts.set(first(person), (counts.get(first(person)) ?? 0) + 1);
  return (name) => ((counts.get(first(name)) ?? 0) > 1 ? name : first(name));
}

/** One booking's others, shortened against that booking alone. */
export function othersOn(detail: BookingDetail, memberId: string, memberName?: string | null): string[] {
  const full = everyoneOn(detail, memberId);
  return full.map(shortenAcross([full], memberName));
}

type Raw = readonly string[] | "loading" | "failed";

/**
 * D9 — the other players on each of a member's next bookings, for the admin Overview. The
 * member-detail answer carries no players, so each booking's own page is read (an admin may read
 * any; the list is capped at five by the server). Keyed by booking id; re-read when the set changes.
 */
export function useOthersOnCourt(
  rows: ReadonlyArray<{ booking_id: string; role?: string | null; organiser?: { name?: string | null } | null }>,
  memberId: string, memberName?: string | null,
): Record<string, OthersState> {
  // A partner row names its organiser in full ("Playing as Sam Naidoo's partner"); that name is
  // on the page too, so another Sam must not be shortened to "Sam" beside it.
  const named = rows.flatMap((r) => (r.role === "partner" && r.organiser?.name ? [r.organiser.name.trim()] : [])).join("|");
  const key = rows.map((r) => `${r.booking_id}:${r.role === "partner" ? "p" : ""}`).join(",");
  const [raw, setRaw] = useState<Record<string, Raw>>({});
  useEffect(() => {
    const entries = key ? key.split(",").map((part) => part.split(":")) : [];
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new set of bookings starts every row loading
    setRaw(Object.fromEntries(entries.map(([id]) => [id, "loading" as const])));
    for (const [id, partner] of entries) {
      playersEndpoints.detail(id)
        .then((d) => { if (live) setRaw((s) => ({ ...s, [id]: everyoneOn(d, memberId, partner === "p") })); })
        .catch(() => { if (live) setRaw((s) => ({ ...s, [id]: "failed" })); });
    }
    return () => { live = false; };
  }, [key, memberId]);
  return useMemo(() => {
    const lists = Object.values(raw).filter((v): v is readonly string[] => Array.isArray(v));
    const short = shortenAcross([...lists, named ? named.split("|") : []], memberName);
    return Object.fromEntries(Object.entries(raw).map(([id, v]) => [id, Array.isArray(v) ? v.map(short) : v])) as Record<string, OthersState>;
  }, [raw, memberName, named]);
}
