import { ApiError } from "@/lib/api";
import { UnsureOutcome, landedOn, outcomeUnknown, type Payer, type Reread } from "@/lib/bookingOutcome";
import { BOOK_SHEET, RESULT_WORD } from "@/lib/bookingsCopy";
import { slotKey, type BookAs, type BookRun } from "./bookFlow";
import type { SelectedSlot } from "./types";
import { answerReasonOf, type ProvenBy } from "@/lib/lostReply";

/**
 * A booking whose answer was lost, or that was refused as "taken" (review round 1, F1.1).
 *
 * <p>
 * Both are resolved the same way: re-read the day and look. A 5xx or a timeout that had in fact
 * booked shows the slots in the payer's name — that IS the outcome, and the sheet shows it as
 * booked. A `slot_taken` on a slot that turns out to be the payer's own is "you already have
 * this", never "someone just took that slot". Anything else is left as it was: a slot still free
 * after a lost answer becomes `UnsureOutcome(checked)`, a failed re-read `UnsureOutcome(unchecked)`.
 * </p>
 */

type Face = (slot: SelectedSlot) => string;

function payerOf(who: BookAs): Payer {
  if (who.kind === "hold") return { kind: "hold" };
  if (who.kind === "member" && who.userId) return { kind: "member", userId: who.userId };
  return { kind: "self" };
}

function isTaken(e: unknown): boolean {
  return e instanceof ApiError && (e.code === "slot_taken" || e.code === "duplicate_request");
}

/** Worth a look: the answer was lost, or the club says the slot is somebody's. */
export function worthRereading(e: unknown): boolean {
  return outcomeUnknown(e) || isTaken(e);
}

/** The run the schedule proves: what is there in the payer's name, and what is not. */
function provenRun(sent: readonly SelectedSlot[], landed: readonly SelectedSlot[], face: Face, hold: boolean, proven: ProvenBy): BookRun {
  const ok = new Set(landed.map(slotKey));
  return {
    rows: sent.map((s) => {
      const mine = ok.has(slotKey(s));
      return {
        key: slotKey(s), courtName: s.courtName, when: face(s), ok: mine,
        word: mine ? RESULT_WORD.replayed : RESULT_WORD.refused,
        detail: mine ? BOOK_SHEET.confirmedFromSchedule : BOOK_SHEET.notOnSchedule,
      };
    }),
    booked: [...landed], balanceAfter: null, halted: null, hold, proven,
  };
}

/**
 * After `error`: the run the schedule proves, or a rethrow — the original refusal when the look
 * says it stands, an `UnsureOutcome` when the answer was lost.
 */
export async function recoverBooking(
  error: unknown, sent: readonly SelectedSlot[], who: BookAs, face: Face, reread: Reread | undefined,
): Promise<BookRun> {
  if (!reread || !worthRereading(error)) throw error;
  const day = await reread();
  if (!day) throw outcomeUnknown(error) ? new UnsureOutcome(error, false) : error;
  const landed = sent.filter((s) => landedOn(day, s, payerOf(who)));
  if (landed.length > 0) return provenRun(sent, landed, face, who.kind === "hold", answerReasonOf(error));
  throw outcomeUnknown(error) ? new UnsureOutcome(error, true) : error;
}
