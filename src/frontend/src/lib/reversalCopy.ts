import { ApiError } from "./api";
import { minutesSpoken } from "./minutes";
import { formatMoney } from "./utils";
import type { ReversalKind } from "./adminApi";

/**
 * Words for the desk's "Refund or chargeback" (BM-6): rand the club gave back for a purchase — cash
 * at the desk, an EFT, a refund on PayFast's own dashboard — or a card chargeback it recorded.
 *
 * <p>
 * Money words, said plainly: the rand back is what the club's revenue loses, the minutes taken back
 * are what the member's balance loses, and the two are asked separately because they are separate
 * (a member refunded for a court they could not use keeps nothing; one refunded a goodwill amount
 * may keep every minute).
 * </p>
 */
export const REVERSAL_COPY = {
  menu: "Refund or chargeback",
  titleFor: (name: string) => `Refund or chargeback for ${name}`,
  description: "Record rand the club gave back for one of their purchases. It takes the money out of the club's revenue.",
  steps: ["Purchase", "Amounts", "Check"] as const,
  pickLabel: (name: string) => `Which of ${name}'s purchases?`,
  pickMissing: "Choose the purchase the money went back for.",
  loadAction: "read their purchases",
  emptyTitle: "No purchases to give money back for",
  emptyHint: "Only purchases that took rand — a PayFast checkout or a desk sale — can be refunded or charged back.",
  nothingLeft: "Already given back in full",
  purchaseLine: (paid: string, minutes: number) => `${paid} for ${minutesSpoken(minutes)}`,
  leftLine: (zar: string, minutes: number) => `${zar} and ${minutesSpoken(minutes)} can still be given back`,
  kindLabel: "What happened?",
  kinds: {
    refund: { title: "The club refunded them", hint: "Cash, an EFT, or a refund on PayFast's dashboard." },
    chargeback: { title: "Their bank charged it back", hint: "The card holder disputed the payment and the bank took the money back." },
  } satisfies Record<ReversalKind, { title: string; hint: string }>,
  zarLabel: "Rand given back",
  zarHelp: (left: string) => `Up to ${left}.`,
  zarMissing: "Say how much rand went back.",
  zarTooMuch: (left: string) => `That is more than this purchase has left to give back (${left}).`,
  zarNotCents: "Give the amount in rand and whole cents.",
  minutesLabel: "Minutes taken back",
  minutesHelp: (left: number) => `0 when they keep their minutes. Up to ${minutesSpoken(left)}.`,
  minutesTooMany: (left: number) => `That is more than this purchase has left to take back (${minutesSpoken(left)}).`,
  minutesInvalid: "Give the minutes as a whole number, 0 or more.",
  noteLabel: "Note",
  notePlaceholder: "e.g. Court 2 lights failed, refunded by EFT",
  noteHint: "Kept on the club's change record. The member's email names the purchase, not this note.",
  noteMissing: "Say why — it is kept on the change record.",
  next: "Next",
  back: "Back",
  cancel: "Cancel",
  done: "Done",
  balanceNow: "Balance now",
  takenBack: "Taken back",
  balanceAfter: "Balance after",
  zarRow: "Rand given back",
  purchaseRow: "Purchase",
  revenueLine: (zar: string) => `${zar} comes off the club's revenue for the day it is recorded.`,
  mailLine: "They are emailed that the money went back, and what it did to their balance.",
  overdraws: "This takes their balance below zero — they will need to buy minutes before booking again.",
  idleFor: (kind: ReversalKind, zar: string) => (kind === "refund" ? `Record refund of ${zar}` : `Record chargeback of ${zar}`),
  confirmFor: (kind: ReversalKind, name: string, zar: string, minutes: number) => {
    const what = kind === "refund" ? "refund" : "chargeback";
    const taken = minutes > 0 ? ` and take back ${minutesSpoken(minutes)}` : "";
    return `Record a ${what} of ${zar} to ${name}${taken}? This goes on the ledger and cannot be deleted.`;
  },
  sending: (name: string) => `Recording the money given back to ${name}…`,
  doneSentence: (kind: ReversalKind, zar: string, balanceAfter: number | null) =>
    `${kind === "refund" ? "Refund" : "Chargeback"} of ${zar} recorded.${balanceAfter === null ? "" : ` Balance now ${minutesSpoken(balanceAfter)}.`}`,
  receiptLeft: (zar: string, minutes: number) => `${zar} and ${minutesSpoken(minutes)} can still be given back on that purchase.`,
} as const;

/** What the press's lost reply turned out to be, in the desk's words (the adjust path's rule). */
export const REVERSAL_LOST = {
  landed: "The reply got lost on the way back, so the purchase was read again: the money went back, once.",
  absent: "The reply got lost, so the purchase was read again: nothing was recorded. You can try again — it cannot be counted twice.",
  unknown: (name: string) =>
    `The reply got lost and the purchase couldn't be read either, so it isn't known yet whether this was recorded. Open ${name}'s ledger before trying again.`,
} as const;

/** A refusal the server sent, in words — or null when it is not one of this route's. */
export function reversalRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  switch (err.code) {
    case "reversal_exceeds_payment": {
      const zar = Number(err.detail("zar_left"));
      const minutes = Number(err.detail("minutes_left"));
      return Number.isFinite(zar) && Number.isFinite(minutes)
        ? `Somebody gave money back on this purchase meanwhile: only ${formatMoney(zar)} and ${minutesSpoken(minutes)} are left. Nothing was recorded.`
        : "That is more than this purchase has left to give back. Nothing was recorded.";
    }
    case "entry_not_reversible":
      return "That purchase did not take rand, so there is nothing to give back. Nothing was recorded.";
    case "entry_not_found":
      return "That purchase is no longer on their ledger. Nothing was recorded.";
    case "zar_reversed_out_of_range":
    case "zar_reversed_not_whole_cents":
      return "The rand given back is not an amount the club's system accepts. Nothing was recorded.";
    case "minutes_out_of_range":
      return "The minutes taken back are not an amount the club's system accepts. Nothing was recorded.";
    case "idempotency_key_reused":
      return "An earlier press of this was already recorded with different amounts. Nothing more was recorded — check their ledger.";
    default:
      return null;
  }
}
