import { api, type CancellationQuote, type ScheduleSlot } from "./api";

/**
 * The Bookings screen's own reads beyond `/schedule` (review round 1): the member's upcoming
 * games (contract §2), the member an admin is booking for (F1.6), and the split-cancel figures
 * (contract §3). A module of its own so `lib/api.ts` — which every lane touches — is not widened;
 * it rides the same `api` client, so timeouts, the 401 handler and the club-zone sniffing apply.
 *
 * <p>Answers are snake_case, as the rest of the API's are.</p>
 */

/* ─────────────────────────────── upcoming games (§2) ─────────────────────────────── */

export type UpcomingPlayer = { name: string; photo_url: string | null; status: string };

export type UpcomingGame = {
  booking_id: string;
  court_name: string;
  starts_at: string;
  ends_at: string;
  /** Whether the caller booked it or holds an accepted partner's seat on it. */
  role: "organiser" | "partner";
  status: string;
  players: UpcomingPlayer[];
  /** The caller's share of the price — the whole price for an organiser with nobody else paying. */
  my_share_credits: number | null;
  /** Something is waiting on the caller: an answer, a payment. */
  needs_action: boolean;
};

export type UpcomingGames = { timezone?: string; items: UpcomingGame[] };

/* ─────────────────────────────── booking for a member (F1.6) ─────────────────────────────── */

/** Enough of a member for the "Booking for …" bar: who, what they may spend, what they pay. */
export type BookingForMember = {
  userId: string;
  name: string;
  /** Raw balance less held and owed back — the figure the booking is checked against. */
  spendable: number;
  /** Held for or owed back to partners; 0 when nothing is. */
  reserved: number;
  /** Their price for one slice, from their groups; null when the rules could not say. */
  slicePrice: number | null;
  groups: string[];
};

type DetailWire = {
  full_name: string | null; email?: string; balance_credits: number;
  held_credits?: number; owed_back_credits?: number;
};

type RulesWire = { slice_price_credits?: number | null; groups?: Array<{ name: string }> };

function positive(value: number | undefined): number {
  return typeof value === "number" && value > 0 ? value : 0;
}

export async function readBookingFor(userId: string, day: string): Promise<BookingForMember> {
  const base = `/api/v1/admin/members/${encodeURIComponent(userId)}`;
  const [detail, rules] = await Promise.all([
    api.get<DetailWire>(base),
    // The price is a nicety: a member whose rules cannot be read is still bookable.
    api.get<RulesWire>(`${base}/booking-rules?day=${encodeURIComponent(day)}`).catch(() => null),
  ]);
  const reserved = positive(detail.held_credits) + positive(detail.owed_back_credits);
  return {
    userId,
    name: detail.full_name?.trim() || detail.email || "This member",
    spendable: detail.balance_credits - reserved,
    reserved,
    slicePrice: typeof rules?.slice_price_credits === "number" ? rules.slice_price_credits : null,
    groups: (rules?.groups ?? []).map((g) => g.name),
  };
}

/* ─────────────────────────────── the split cancel (§3) ─────────────────────────────── */

export type PartnerRefund = { name: string; credits: number };

/** What a split booking's cancel sends back to partners, and what the organiser keeps. */
export type SplitCancel = { net: number; partners: PartnerRefund[] };

function partnersOf(raw: unknown): PartnerRefund[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => (p && typeof p === "object" ? p as Record<string, unknown> : {}))
    .filter((p) => typeof p.name === "string" && typeof p.credits === "number" && p.credits > 0)
    .map((p) => ({ name: p.name as string, credits: p.credits as number }));
}

/**
 * The §3 fields off a cancellation quote or a cancel's answer — spelled either way, since the
 * quote is a camelCase record and the contract names them snake_case. Null when none of a
 * booking's money goes to partners, which is every booking without players.
 */
export function splitCancelOf(source: CancellationQuote | Record<string, unknown> | null | undefined): SplitCancel | null {
  if (!source) return null;
  const raw = source as Record<string, unknown>;
  const partners = partnersOf(raw.partner_refunds ?? raw.partnerRefunds);
  const net = raw.net_credits ?? raw.netCredits;
  if (partners.length === 0 || typeof net !== "number") return null;
  return { net, partners };
}

/* ─────────────────────────────── the grid's partner games (§2) ─────────────────────────────── */

/** A day cell the caller holds a partner's seat on — theirs to open, never to cancel. */
export function isPartnerSlot(slot: ScheduleSlot): boolean {
  return slot.isMine && slot.role === "partner";
}

export const bookingsApi = {
  upcoming: () => api.get<UpcomingGames>("/api/v1/me/bookings/upcoming"),
  bookingFor: readBookingFor,
};
