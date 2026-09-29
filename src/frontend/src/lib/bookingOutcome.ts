import { ApiError, NetworkError, type ScheduleDay, type ScheduleSlot } from "./api";
import { isPartnerSlot } from "./bookingsApi";

/**
 * What to believe when a booking or a cancellation got no answer (review round 1, F1.1/F1.2).
 *
 * <p>
 * <b>A 5xx, a timeout or a dropped connection is not a "no".</b> The request may well have reached
 * the club and been committed before the reply was lost — a 504 from the gateway after the API
 * had already booked and charged is the ordinary case. The sheet used to say "Nothing was booked
 * and no credit was taken" to every one of them, went on offering the slot, and the member's
 * second try was told "someone just took that slot" — about their own booking. The same happened
 * in reverse on a cancel the server had refunded.
 * </p>
 *
 * <p>
 * So an unanswered write is an UNKNOWN outcome: the caller re-reads the day and looks. What is on
 * the schedule is the answer — booked in the payer's name, still free, gone — and only when the
 * re-read itself fails does the sheet say it cannot tell.
 * </p>
 */

/** A write whose effect is unknown: the club may have done it, we were not told. */
export function outcomeUnknown(e: unknown): boolean {
  if (e instanceof NetworkError) return true;
  if (e instanceof ApiError) return e.status >= 500;
  // A fetch aborted underneath the client (a page hide, a torn socket) — never a refusal.
  return e instanceof DOMException && e.name === "AbortError";
}

/**
 * The unanswered write, after the day was re-read. `checked` is whether that re-read worked:
 * false means the sheet cannot tell and must say so, true means the schedule showed the write
 * had NOT landed.
 */
export class UnsureOutcome extends Error {
  constructor(readonly original: unknown, readonly checked: boolean) {
    super(checked ? "The write did not land." : "The write's outcome is unknown.");
    this.name = "UnsureOutcome";
  }
}

/** Re-reads the day on screen; null when that read failed too. */
export type Reread = () => Promise<ScheduleDay | null>;

/** Whose name a booking lands in: the viewer's own, a member's, or a club hold. */
export type Payer = { kind: "self" } | { kind: "member"; userId: string } | { kind: "hold" };

type SlotLike = { courtId: string; startsAt: string };

/** The slot on `day` that covers `at` on that court, if one does. */
function covering(day: ScheduleDay, courtId: string, atMs: number): ScheduleSlot | undefined {
  return day.slots.find((s) => s.courtId === courtId
    && Date.parse(s.startsAtUtc) <= atMs && atMs < Date.parse(s.endsAtUtc));
}

function isPayers(slot: ScheduleSlot, payer: Payer): boolean {
  if (payer.kind === "hold") return slot.status === "adminblock";
  if (slot.status === "adminblock") return false;
  if (payer.kind === "self") return slot.isMine && isOrganiser(slot);
  return slot.ownerUserId === payer.userId;
}

/** A partner's seat on someone else's game is `isMine` too (contract §2) — but not their booking. */
function isOrganiser(slot: ScheduleSlot): boolean {
  return !isPartnerSlot(slot);
}

/** Did `slot` land on the schedule in the payer's name? */
export function landedOn(day: ScheduleDay, slot: SlotLike, payer: Payer): boolean {
  const found = covering(day, slot.courtId, Date.parse(slot.startsAt));
  return Boolean(found && isPayers(found, payer));
}

/** Is the booking gone from the schedule — cancelled, as far as the grid can tell? */
export function goneFrom(day: ScheduleDay, bookingId: string): boolean {
  return !day.slots.some((s) => s.bookingId === bookingId);
}
