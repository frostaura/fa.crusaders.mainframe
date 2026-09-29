import type { BookingDetail, DetailPlayer } from "@/lib/playersApi";
import { MAX_SEATS } from "@/lib/playersApi";
import { clubClock } from "@/lib/clubClock";
import { DETAIL_COPY, PLAYERS_COPY, STATUS_WORD, firstName, playersWhen } from "@/lib/playersCopy";

/**
 * The booking page's pure reading of `GET /bookings/{id}`: which seat is where, what word each
 * chip says, and which hands the viewer holds. No React here — the chips, the money panel and
 * the admin menu all read the same answers, so they cannot disagree about a seat.
 */

/** Only these two statuses hold a seat. */
export function isLive(p: DetailPlayer): boolean {
  return p.status === "invited" || p.status === "accepted";
}

const GONE = new Set<string>(["declined", "withdrawn", "removed"]);

/** R1 F2.10 — a cancelled booking: nothing on it is still being asked of anyone. */
export function isCancelled(d: Pick<BookingDetail, "status">): boolean {
  return d.status === "cancelled";
}

/**
 * The STATUS_WORD key a chip shows — always a word, never colour alone. On a cancelled game a
 * live seat was in (or its invite closed): "In" and "Invited" would say the game is still on.
 */
export function statusKey(p: DetailPlayer, cancelled = false): string {
  if (p.kind === "organiser") return "organiser";
  if (p.settled_outside) return "settled_outside";
  if (GONE.has(p.status)) return p.status;
  if (p.lapsed || p.status === "lapsed") return "lapsed";
  if (p.kind === "guest") return "guest";
  if (cancelled) return p.status === "accepted" ? "was_in" : "invite_closed";
  return liveKey(p);
}

/** A live seat on a game that is still on: waiting, asked again, agreed to nothing, in, or paid. */
function liveKey(p: DetailPlayer): string {
  if (p.kind === "open_link") return "open_link";
  if (p.status === "invited") return "invited";
  // Accepted for them by the club (no consent recorded): nothing agreed, so nothing "asked again".
  if (p.needs_consent) return p.consented_credits <= 0 ? "not_agreed" : "needs_consent";
  return p.share_credits > 0 && p.unpaid_credits <= 0 && p.paid_credits > 0 ? "paid" : "accepted";
}

export function statusWord(p: DetailPlayer, cancelled = false): string {
  return STATUS_WORD[statusKey(p, cancelled)] ?? p.status;
}

export type ChipTone = "neutral" | "success" | "info" | "warning" | "brand";

const TONE: Record<string, ChipTone> = {
  organiser: "brand", paid: "success", accepted: "info", needs_consent: "warning",
  invited: "neutral", settled_outside: "info", guest: "neutral", open_link: "neutral", was_in: "info",
  not_agreed: "warning",
};

export function statusTone(p: DetailPlayer, cancelled = false): ChipTone {
  return TONE[statusKey(p, cancelled)] ?? "neutral";
}

/** Only the game's own players are ever shown its result (§3.4) — and a cancelled game has none to record. */
export function showsResult(d: BookingDetail): boolean {
  return d.viewer.role !== "admin" && d.status !== "cancelled" && d.status !== "blocked";
}

/** Whether another member on the booking has the same first name (R1 F2.13). */
function firstNameShared(p: DetailPlayer, players: readonly DetailPlayer[]): boolean {
  const mine = firstName(p.name).toLowerCase();
  return players.some((o) => o !== p && o.participant_id !== p.participant_id && o.kind !== "guest" && o.kind !== "open_link"
    && (o.name ?? "").trim() !== (p.name ?? "").trim() && firstName(o.name).toLowerCase() === mine);
}

/**
 * A seat's name as a chip says it: first names between members, a guest as named, an open seat.
 * Given the booking's players, two members who share a first name are told apart by their full
 * names (R1 F2.13) — "Sam" twice on one court says nothing about who paid.
 */
export function seatName(p: DetailPlayer, players?: readonly DetailPlayer[]): string {
  if (p.kind === "open_link") return PLAYERS_COPY.openSeat;
  if (p.kind === "guest") return (p.name ?? "").trim() || PLAYERS_COPY.guest;
  if (players && firstNameShared(p, players)) return (p.name ?? "").trim() || PLAYERS_COPY.someone;
  return firstName(p.name);
}

export type SeatPosition = { seat: number; player: DetailPlayer | null };

/** Seats 1–4, each with its live player or nobody. Dead seats never hold a position. */
export function positions(d: BookingDetail): SeatPosition[] {
  const out: SeatPosition[] = [];
  for (let seat = 1; seat <= MAX_SEATS; seat += 1) {
    out.push({ seat, player: d.players.find((p) => p.seat === seat && isLive(p)) ?? null });
  }
  return out;
}

/** The dead seats — declined, pulled out, removed, lapsed. The API shows these to the organiser and admins only. */
export function formerPlayers(d: BookingDetail): DetailPlayer[] {
  return d.players.filter((p) => !isLive(p));
}

export function liveCount(d: BookingDetail): number {
  return d.players.filter(isLive).length;
}

/** The viewer's own seat, when they have one. */
export function mySeat(d: BookingDetail): DetailPlayer | null {
  const id = d.viewer.participant_id;
  return id ? d.players.find((p) => p.participant_id === id) ?? null : null;
}

/** "Court 1 · Tue 30 Sep, 18:00–18:45", in the club's zone. */
export function detailTitle(d: BookingDetail): string {
  return DETAIL_COPY.when(d.court_name ?? DETAIL_COPY.someCourt, playersWhen(d.starts_at), clubClock(d.ends_at));
}

/** The organiser's first name as the viewer reads it — null when the viewer IS the organiser. */
export function organiserName(d: BookingDetail): string | null {
  if (d.viewer.role === "organiser") return null;
  const seat = d.players.find((p) => p.kind === "organiser");
  return seat ? seatName({ ...seat, name: d.organiser.name ?? seat.name }, d.players) : firstName(d.organiser.name);
}

/* ─────────────────────────────── the organiser's hands ─────────────────────────────── */

/** A reminder has something to say: an unanswered invite, an unpaid share, a share asked again. */
export function canNudge(p: DetailPlayer): boolean {
  if (p.kind !== "member" || !isLive(p) || p.settled_outside) return false;
  return p.status === "invited" || p.unpaid_credits > 0 || p.needs_consent;
}

/** An open seat, or a member still to answer, can be sent a (new) link. */
export function canShareLink(p: DetailPlayer): boolean {
  if (!isLive(p) || !p.participant_id) return false;
  return p.kind === "open_link" || (p.kind === "member" && p.status === "invited");
}

export function canRemove(p: DetailPlayer): boolean {
  return p.kind !== "organiser" && isLive(p) && p.participant_id !== null;
}

/* ─────────────────────────────── the admin's hands ─────────────────────────────── */

export type AdminAct = "remove" | "accept" | "settle" | "collect";

/** What an admin collect would take: the unpaid share of a live seat, or what a lapsed one never paid. */
export function collectable(p: DetailPlayer): number {
  if (p.kind !== "member" || p.settled_outside) return 0;
  if (p.status === "accepted") return Math.max(p.unpaid_credits, p.target_credits - p.paid_credits, 0);
  if (p.status === "lapsed" || p.lapsed) return Math.max(p.share_credits - p.paid_credits, 0);
  return 0;
}

/** The god-mode actions that mean something on this seat, in menu order. */
export function adminActs(p: DetailPlayer): AdminAct[] {
  if (p.kind === "organiser" || !p.participant_id) return [];
  const acts: AdminAct[] = [];
  if (p.kind === "member" && p.status === "invited") acts.push("accept");
  if (p.kind === "member" && p.status === "accepted" && !p.settled_outside) acts.push("settle");
  if (collectable(p) > 0) acts.push("collect");
  if (isLive(p)) acts.push("remove");
  return acts;
}
