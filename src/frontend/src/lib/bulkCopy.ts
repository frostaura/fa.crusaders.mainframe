import { formatCredits } from "./utils";
import { describeBookingError } from "./bookingErrors";
import { ApiError } from "./api";
import type { BulkRow, CancelTotals } from "./bulkResults";

/**
 * Every sentence the multi-select surfaces say — items 5 and 13.
 *
 * <p>
 * <b>The result is a screen, not a toast.</b> `Toast` is a four-second `role="status"` and the
 * toast viewport deliberately carries no live region of its own. Four seconds is not enough to
 * read six outcomes, and a toast cannot say "11 cancelled, 1 was already gone" and stay
 * readable — so the sentences below are written to be READ, on a sheet the admin closes when
 * they are finished with it.
 * </p>
 *
 * <p>
 * <b>Every refusal decodes through `describeBookingError`.</b> One decoder, so the sentence a
 * failed row carries is the same sentence the single-slot dialog would have shown — a `Thandi
 * has reached 4 slots for Tuesday` here and a different wording there is how two screens end
 * up describing one rule two ways.
 * </p>
 */

export function selectionCount(free: number, booked: number): string {
  if (free && booked) return `${free} free · ${booked} booked`;
  if (booked) return `${booked} ${booked === 1 ? "booking" : "bookings"} selected`;
  return `${free} ${free === 1 ? "slot" : "slots"} selected`;
}

export function bookButtonLabel(free: number): string {
  return `Book ${free} ${free === 1 ? "slot" : "slots"}`;
}

export function cancelButtonLabel(booked: number): string {
  return `Cancel ${booked} ${booked === 1 ? "booking" : "bookings"}`;
}

/** The muted line under the count, so the admin can sanity-check the span without scrolling. */
export function selectionSpan(courts: readonly string[], dayLabel: string, from: string | null, to: string | null): string {
  const where = courts.length === 1 ? courts[0] : `${courts.length} courts`;
  const when = from && to && from !== to ? `${from}–${to}` : from ?? "";
  return [where, dayLabel, when].filter(Boolean).join(" · ");
}

export function bulkHeading(done: number, total: number): string {
  return `${done} of ${total} done.`;
}

/** The determinate progress line. This one genuinely knows its denominator. */
export function bulkProgress(mode: "book" | "cancel", total: number): string {
  return mode === "book" ? `Booking ${total} ${total === 1 ? "slot" : "slots"}…` : `Cancelling ${total}…`;
}

/**
 * What a whole cancel batch moved, in the order it costs somebody money.
 *
 * <p>
 * The last clause is the *"nothing back once the lights have been on"* invariant, said out loud
 * at the moment it costs a member their court fee — rather than discovered in a ledger later.
 * Each clause appears only when it actually happened; a line reading "0.00 cr is kept as a
 * penalty" on a free cancellation is noise that teaches an admin to stop reading.
 * </p>
 */
export function cancelTotalsSentence(totals: CancelTotals): string {
  const parts = [`${formatCredits(totals.refundCredits - totals.penaltyCredits)} goes back.`];
  if (totals.penaltyCredits > 0) parts.push(`${formatCredits(totals.penaltyCredits)} is kept as a late-cancellation penalty.`);
  if (totals.nothingBack > 0) {
    parts.push(`${totals.nothingBack} ${totals.nothingBack === 1 ? "booking gets" : "bookings get"} nothing back — the lights had already been on.`);
  }
  return parts.join(" ");
}

/** The armed consequence on the destructive confirm. It states what cannot be taken back. */
export function cancelConsequence(refundCredits: number, members: number): string {
  const who = members === 1 ? "1 member is emailed" : `${members} members are emailed`;
  return `${formatCredits(refundCredits)} goes back. ${who}. This cannot be undone.`;
}

/**
 * <b>There is no Undo, and one button that honestly says what it does.</b>
 *
 * <p>
 * D3 §4.6's reasoning, kept verbatim in behaviour: a refund is already a ledger row, and
 * "undoing" it would mean re-booking at today's price into slots that may have been re-sold,
 * posting a second pair of movements to explain. So the sheet says so BEFORE the fact rather
 * than offering a magic word afterwards.
 * </p>
 */
export const NO_UNDO_LINE = "Cancelling is final. There is no undo — re-booking would be a new booking at today's price, into a slot somebody else may have taken.";

export function bookMoneyLine(total: number, payerName: string | null, before: number | null, after: number | null): string {
  const cost = `${formatCredits(total)}`;
  if (!payerName || before === null) return `${cost} in total.`;
  const afterText = after === null ? "" : ` After this: ${formatCredits(after)}.`;
  return `${cost} in total. ${payerName} has ${formatCredits(before)}.${afterText}`;
}

/** The written-in-name path charges nobody, and the sheet says so in those words. */
export function guestMoneyLine(count: number): string {
  return `Nobody is charged for ${count === 1 ? "this slot" : `these ${count} slots`}.`;
}

/**
 * One failed row's reason, through the single decoder the whole booking journey uses.
 *
 * <p>
 * The row's `error` is the same stable snake_case token a single-slot refusal carries, so it
 * is wrapped back into an `ApiError` rather than decoded a second way. Two decoders is how one
 * rule ends up described two ways on two screens.
 * </p>
 */
export function rowReason(row: BulkRow): string {
  if (row.ok) return "";
  if (!row.error) return "That one didn't go through.";
  return describeBookingError(new ApiError(409, { error: row.error }), "That one didn't go through.");
}

/** What a successful row says it did. */
export function rowOutcome(row: BulkRow, mode: "book" | "cancel", payerName: string | null): string {
  if (mode === "cancel") {
    if (row.status === "already_cancelled") return "Was already cancelled";
    if (row.status === "block_lifted") return "Club hold lifted";
    if (row.nothingBack) return "Cancelled — nothing back, the lights had been on";
    const penalty = row.penaltyCredits > 0 ? `, ${formatCredits(row.penaltyCredits)} penalty kept` : "";
    return `Cancelled — ${formatCredits(row.refundCredits - row.penaltyCredits)} back${penalty}`;
  }
  if (row.status === "duplicate") return "Already booked under this batch";
  if (row.status === "blocked") return "Held for your written-in name";
  return payerName ? `Booked for ${payerName}` : "Booked";
}

/** The halt, and the one thing that gets past it (D2 §5.3). */
export function haltSentence(reason: string | null, payerName: string | null): string | null {
  if (reason !== "insufficient_balance") return reason ? "The batch stopped part-way." : null;
  const who = payerName ?? "That member";
  return `${who} ran out of credit part-way through, so the rest were not attempted. `
    + "You can book the rest anyway and leave them owing.";
}

export const RETRY_OVERDRAWN_LABEL = "Book the rest anyway";
export const RETRY_FAILED_LABEL = "Try the ones that failed";

/** The bar's own announcements, debounced by the caller so a sweep speaks once. */
export function selectedAnnouncement(where: string, count: number): string {
  return `${where}, selected. ${count} ${count === 1 ? "slot" : "slots"} selected.`;
}
