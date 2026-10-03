import { api, type CancellationQuote, type ScheduleSlot } from "./api";
import type { ClockWindow, ViewerRules } from "./gridRules";

/**
 * The Bookings screen's own reads beyond `/schedule` (review round 1): the member's upcoming
 * games (contract §2), the member an admin is booking for (F1.6), and the split-cancel figures
 * (contract §3). A module of its own so `lib/api.ts` — which every lane touches — is not widened;
 * it rides the same `api` client, so timeouts, the 401 handler and the club-zone sniffing apply.
 *
 * <p>Answers are snake_case, as the rest of the API's are.</p>
 */

/* ─────────────────────────────── upcoming games (§2) ─────────────────────────────── */

/**
 * One seat on a listed game. `name` is null for a seat nobody has claimed yet — an invite link
 * still open (R3 V-1: `p.name.split` on one crashed the whole Bookings page). `status` is the
 * seat's own ("accepted", "invited", …): only accepted seats are named as players (R3 M-3).
 */
export type UpcomingPlayer = { name: string | null; photo_url: string | null; status: string };

export type UpcomingGame = {
  booking_id: string;
  court_name: string;
  starts_at: string;
  ends_at: string;
  /**
   * Whether the caller booked it or holds an accepted partner's seat on it — or (R7 E7-5) paid for
   * it at the court box, which shows it to them read-only.
   */
  role: "organiser" | "partner" | "payer";
  /** R7 E7-6 — the end it was sold to; `ends_at` is cut short by the no-show sweep. */
  sold_ends_at?: string;
  /** R9 J9-5 — the desk made this booking for the member (absent on an older server: read as false). */
  booked_by_club?: boolean;
  status: string;
  players: UpcomingPlayer[];
  /** The caller's share of the price — the whole price for an organiser with nobody else paying. */
  my_share_minutes: number | null;
  /** Something is waiting on the caller: an answer, a payment. */
  needs_action: boolean;
  /**
   * R3 M-3 — what the game has cost the caller so far, off their own wallet, net (an organiser's
   * charge less the shares partners have paid back). Absent from an older server.
   */
  my_paid_minutes?: number;
  /** R3 M-3 — what a partner still owes on their seat; 0 for the organiser. Absent from an older server. */
  my_owing_minutes?: number;
};

export type UpcomingGames = { timezone?: string; items: UpcomingGame[] };

/* ─────────────────────────────── recent games (C3, R2 F1-1) ─────────────────────────────── */

export type RecentResultStatus = "none" | "pending" | "confirmed" | "disputed";

/**
 * A game that ended within the result window (the last 7 days) — the upcoming item's shape, plus
 * where its result stands and whether the caller may record one. Newest first, at most 50.
 */
export type RecentGame = UpcomingGame & { result_status: RecentResultStatus; can_record: boolean };

export type RecentGames = { timezone?: string; items: RecentGame[] };

/** What a recent game asks of the viewer, if anything: record it, or confirm the other side's. */
export function recentAction(game: RecentGame): "record" | "confirm" | null {
  if (game.result_status === "none" && game.can_record) return "record";
  if (game.result_status === "pending" && game.needs_action) return "confirm";
  return null;
}

/* ─────────────────────────────── booking for a member (F1.6) ─────────────────────────────── */

/** Enough of a member for the "Booking for …" bar: who, what they may spend, what they pay. */
export type BookingForMember = {
  userId: string;
  name: string;
  /** Raw balance less held and owed back — the figure the booking is checked against. */
  spendable: number;
  /** Held for or owed back to partners; 0 when nothing is. */
  reserved: number;
  groups: string[];
  /**
   * Their group hours on the day being booked (R2 F1-3) — what the grid draws for the desk, so a
   * cell the member's groups would refuse is locked before Continue rather than refused after.
   * Null when the rules could not be read: unknown is never a refusal.
   */
  windows: MemberWindows | null;
};

/** The member's own window facts, as `/admin/members/{id}/booking-rules` answers them. */
export type MemberWindows = {
  day: string;
  groups: { id: string; name: string }[];
  /** `null` = the server did not say; `[]` with `emptyGroups` = the groups never overlap. */
  allowed: ClockWindow[] | null;
  emptyGroups: string[] | null;
};

type DetailWire = {
  full_name: string | null; email?: string; balance_minutes: number;
  held_minutes?: number; owed_back_minutes?: number;
};

type RulesWire = {
  groups?: Array<{ id?: string; name: string }>;
  day?: string;
  allowed_windows?: Array<{ start?: unknown; end?: unknown }> | null;
  empty_window_groups?: string[] | null;
};

function windowsOf(rules: RulesWire, day: string): MemberWindows {
  const allowed = Array.isArray(rules.allowed_windows)
    ? rules.allowed_windows
      .filter((w): w is ClockWindow => typeof w?.start === "string" && typeof w?.end === "string")
      .map((w) => ({ start: w.start, end: w.end }))
    : null;
  const empty = Array.isArray(rules.empty_window_groups) && rules.empty_window_groups.length ? rules.empty_window_groups : null;
  return {
    day: typeof rules.day === "string" ? rules.day : day,
    groups: (rules.groups ?? []).map((g) => ({ id: g.id ?? g.name, name: g.name })),
    allowed,
    emptyGroups: empty,
  };
}

function positive(value: number | undefined): number {
  return typeof value === "number" && value > 0 ? value : 0;
}

export async function readBookingFor(userId: string, day: string): Promise<BookingForMember> {
  const base = `/api/v1/admin/members/${encodeURIComponent(userId)}`;
  const [detail, rules] = await Promise.all([
    api.get<DetailWire>(base),
    // The rules are a nicety: a member whose rules cannot be read is still bookable.
    api.get<RulesWire>(`${base}/booking-rules?day=${encodeURIComponent(day)}`).catch(() => null),
  ]);
  const reserved = positive(detail.held_minutes) + positive(detail.owed_back_minutes);
  return {
    userId,
    name: detail.full_name?.trim() || detail.email || "This member",
    spendable: detail.balance_minutes - reserved,
    reserved,
    groups: (rules?.groups ?? []).map((g) => g.name),
    windows: rules ? windowsOf(rules, day) : null,
  };
}

/**
 * The grid's rules while the desk books FOR a member (R2 F1-3): the member's group windows —
 * god mode lifts the balance check and the daily cap, never a group's window — and nothing else. Null
 * when their windows are unknown, and the grid stays the admin's (every cell offered).
 */
export function memberGridRules(member: BookingForMember | null): ViewerRules | null {
  const w = member?.windows;
  if (!w || (w.allowed === null && w.emptyGroups === null)) return null;
  return {
    known: true, adminExempt: false, groups: w.groups, allowedWindows: w.allowed, clubHours: null,
    maxSlotsPerDay: null, maxMinutesPerDay: null,
    bookedSlotsToday: null, bookedMinutesToday: null, remainingToday: null,
    emptyWindow: w.emptyGroups ? { groups: w.emptyGroups, day: w.day } : null,
    clubDay: w.day,
  };
}

/** "Naledi" from "Naledi Khumalo" — how the grid names the member it is booking for. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/* ─────────────────────────────── the split cancel (§3) ─────────────────────────────── */

/** P13 §3.2 — `partner_refunds[]` is `{user_id, name, minutes}`. */
export type PartnerRefund = { userId?: string; name: string; minutes: number };

/** What a split booking's cancel sends back to partners, and what the organiser keeps. */
export type SplitCancel = { net: number; partners: PartnerRefund[] };

function partnersOf(raw: unknown): PartnerRefund[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => (p && typeof p === "object" ? p as Record<string, unknown> : {}))
    .filter((p) => typeof p.name === "string" && typeof p.minutes === "number" && p.minutes > 0)
    .map((p) => ({
      ...(typeof p.user_id === "string" ? { userId: p.user_id } : {}),
      name: p.name as string,
      minutes: p.minutes as number,
    }));
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
  const net = raw.net_minutes ?? raw.netMinutes;
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
  recent: () => api.get<RecentGames>("/api/v1/me/bookings/recent"),
  bookingFor: readBookingFor,
};

/* ─────────────────────────────── held parts (C4) ─────────────────────────────── */

/** One share deadline's held minutes (contract C4; P13 §3.2): `held_parts`, soonest first, summing to held. */
export type HeldPart = { minutes: number; until: string };

/**
 * The held parts off whatever carries them — a wallet read, a stream frame or the balance
 * context's figures (`held_parts` on the wire, `parts` once parsed). Soonest first; empty when the
 * server predates C4, and the single `held_until` line stands.
 */
export function heldPartsOf(source: unknown): HeldPart[] {
  if (!source || typeof source !== "object") return [];
  const raw = (source as Record<string, unknown>).parts ?? (source as Record<string, unknown>).held_parts;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => (p && typeof p === "object" ? p as Record<string, unknown> : {}))
    .filter((p) => typeof p.minutes === "number" && p.minutes > 0 && typeof p.until === "string")
    .map((p) => ({ minutes: p.minutes as number, until: p.until as string }))
    .sort((a, b) => Date.parse(a.until) - Date.parse(b.until));
}
