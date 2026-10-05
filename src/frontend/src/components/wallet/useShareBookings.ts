import type { ShareBookingSummary, SharePlaceWire, WalletResponse } from "@/lib/api";
import type { BookingDetail } from "@/lib/playersApi";

/**
 * What a share line needs to know about its booking that the ledger row does not carry: the
 * court, the day of the game, and who was on it.
 *
 * <p>
 * <b>A ledger row names the booking and nothing else about it</b> — its counterparty is "Club
 * treasury" and its comment "Share of a split booking" (`LedgerRowMapper`), so "Court 1 · Tue
 * 30 Sep" and "from Sam" have to come from the booking itself — summarised by the club on the
 * wallet read (`share_bookings`); a booking the member can no longer read (a declined or removed
 * seat) is `null`, and the line then says "a split booking", which is true.
 * </p>
 */
export type ShareBooking = {
  courtName: string | null;
  startsAt: string;
  organiserId: string | null;
  organiserName: string | null;
  /** Members on the booking other than the organiser, with what they have paid. */
  partners: { userId: string; name: string | null; paid: number }[];
  /**
   * R14 E14-7 — the member can no longer read this booking (its summary was null) and only its
   * place is known (`share_places`): the line names the court and day, and offers no link.
   */
  gone?: true;
};

export function summariseBooking(detail: BookingDetail): ShareBooking {
  return {
    courtName: detail.court_name,
    startsAt: detail.starts_at,
    organiserId: detail.organiser.user_id,
    organiserName: detail.organiser.name,
    partners: detail.players
      .filter((p) => p.kind === "member" && p.user_id && p.user_id !== detail.organiser.user_id)
      .map((p) => ({ userId: p.user_id as string, name: p.name, paid: p.paid_minutes })),
  };
}

/** bookingId → its summary; `null` when the member can no longer read it, or the club did not say. */
export type ShareBookings = Readonly<Record<string, ShareBooking | null>>;

/** One wire summary (`share_bookings` on the wallet read) as a share line reads it. */
export function shareBookingFromWire(wire: ShareBookingSummary): ShareBooking {
  return {
    courtName: wire.court_name,
    startsAt: wire.starts_at,
    organiserId: wire.organiser.user_id,
    organiserName: wire.organiser.name,
    partners: wire.partners.map((p) => ({ userId: p.user_id, name: p.name, paid: p.paid_minutes })),
  };
}

/**
 * The page's share lines, from the wallet read itself (perf round, 2026-09-30). They used to be one
 * `GET /bookings/{id}` per booking on the page — up to 20 after the ledger, 1.7 s of Wallet on a
 * slow phone — and are now the `share_bookings` the read carries. A booking the club did not
 * summarise reads as `null`, so its line says "a split booking", which is true.
 */
export function shareBookingsFrom(wire: WalletResponse["share_bookings"], places?: WalletResponse["share_places"]): ShareBookings {
  const out: Record<string, ShareBooking | null> = {};
  for (const [id, summary] of Object.entries(wire ?? {})) out[id] = summary ? shareBookingFromWire(summary) : goneAt(places?.[id]);
  return out;
}

/** R14 E14-7 — a booking the member is off: its place alone (`share_places`), else null as before. */
function goneAt(place: SharePlaceWire | undefined): ShareBooking | null {
  if (!place?.starts_at) return null;
  return { courtName: place.court_name, startsAt: place.starts_at, organiserId: null, organiserName: null, partners: [], gone: true };
}
