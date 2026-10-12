import { parseMinutesAmount } from "@/lib/amount";
import type { BookingDetail, DetailPlayer, SplitChange } from "@/lib/playersApi";
import { isLive } from "./detailModel";

/**
 * Pay what you can (players-and-splits.md §4) — the organiser's side. A partner paid only part of
 * their share; what they could not pay (`left_to_cover_minutes`) is the organiser's to cover until
 * the others decide how to split it. Pure: the "Split what's left" dialog edits one whole-minute
 * portion per player who can take some — the organiser and every other paying partner — and saves
 * it as an `amount` split through `PUT /bookings/{id}/split`, which clears the shortfall.
 */

/** What is left to cover on this booking — 0 from an older API. */
export function leftToCover(d: BookingDetail): number {
  return Math.max(0, d.money.left_to_cover_minutes ?? 0);
}

/** The partners who paid only part of their share, in seat order: their figure is locked at what they paid. */
export function shortPartners(d: BookingDetail): DetailPlayer[] {
  return d.players
    .filter((p) => isLive(p) && p.kind !== "organiser" && (p.shortfall_minutes ?? 0) > 0)
    .sort((a, b) => a.seat - b.seat);
}

/**
 * Who can take a portion: the organiser first, then every live paying partner who is not short —
 * never a guest (a guest plays free) nor a share the club recorded as paid by hand (it moves nothing).
 */
export function coverers(d: BookingDetail): DetailPlayer[] {
  const organiser = d.players.filter((p) => p.kind === "organiser");
  const partners = d.players
    .filter((p) => isLive(p) && p.kind !== "organiser" && p.kind !== "guest" && !p.settled_outside
      && (p.shortfall_minutes ?? 0) === 0 && p.participant_id !== null)
    .sort((a, b) => a.seat - b.seat);
  return [...organiser, ...partners];
}

/** A portion's key: the seat's participant id, or "organiser" (an organiser read without a seat row). */
export function portionKey(p: DetailPlayer): string {
  return p.kind === "organiser" ? "organiser" : p.participant_id ?? `seat:${p.seat}`;
}

/**
 * The opening portions: the shortfall split equally, each partner rounded down to whole minutes and
 * the organiser keeping the remainder — the house rounding rule (§2), so they always sum to it.
 */
export function equalPortions(shortfall: number, people: readonly DetailPlayer[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (people.length === 0) return out;
  const each = Math.floor(shortfall / people.length);
  for (const p of people) out[portionKey(p)] = String(each);
  const organiser = people.find((p) => p.kind === "organiser");
  const first = organiser ?? people[0];
  out[portionKey(first)] = String(shortfall - each * (people.length - 1));
  return out;
}

/** One typed portion, read as whole minutes (0 allowed), or null while it cannot be read. */
export function portionOf(text: string | undefined): number | null {
  const parsed = parseMinutesAmount(text ?? "", { allowZero: true });
  return parsed.ok ? parsed.value : null;
}

/** What the portions assign so far — unreadable ones count as nothing — and whether every one reads. */
export function assigned(portions: Record<string, string>, people: readonly DetailPlayer[]): { total: number; readable: boolean } {
  let total = 0;
  let readable = true;
  for (const p of people) {
    const value = portionOf(portions[portionKey(p)]);
    if (value === null) readable = false;
    else total += value;
  }
  return { total, readable };
}

/** Save is allowed only once every portion reads and together they are exactly what is left. */
export function portionsReady(shortfall: number, portions: Record<string, string>, people: readonly DetailPlayer[]): boolean {
  const { total, readable } = assigned(portions, people);
  return readable && shortfall > 0 && total === shortfall;
}

/**
 * The body of `PUT /bookings/{id}/split`: an `amount` split naming every live paying partner — a
 * short one at what they paid (their share now), every other at their share plus their portion. The
 * organiser is never named: they take the remainder, which is their share less what they gave away
 * (they were covering all of it). Null until the portions are ready.
 */
export function leftoverChange(d: BookingDetail, portions: Record<string, string>): SplitChange | null {
  const people = coverers(d);
  if (!portionsReady(leftToCover(d), portions, people)) return null;
  const seats: SplitChange["seats"] = [];
  const partners = d.players
    .filter((p) => isLive(p) && p.kind !== "organiser" && p.kind !== "guest" && p.participant_id !== null)
    .sort((a, b) => a.seat - b.seat);
  for (const p of partners) {
    const extra = people.includes(p) ? portionOf(portions[portionKey(p)]) ?? 0 : 0;
    seats.push({ participantId: p.participant_id as string, amount: p.share_minutes + extra });
  }
  return { mode: "amount", seats };
}

/** The shares the save should leave (partners'), for the lost-reply read-back (`splitOrProve`). */
export function leftoverExpected(change: SplitChange, d: BookingDetail): { seat: number; share_minutes: number }[] {
  return change.seats.flatMap((s) => {
    const seat = d.players.find((p) => p.participant_id === s.participantId)?.seat;
    return seat === undefined || s.amount === undefined ? [] : [{ seat, share_minutes: s.amount }];
  });
}
