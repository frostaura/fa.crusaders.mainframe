import { ApiError, endpoints, OfflineError, type TopUpOptions, type TopUpStatus } from "./api";
import { writeOrReadBack, UnsureOutcome } from "./lostReply";
import { clubClock } from "./clubClock";
import { formatMoney } from "./utils";

/**
 * Review round 5, M5-2 (HIGH) — the member's own checkouts still waiting on PayFast.
 *
 * <p>
 * Back from PayFast twice (R200, R800) without paying, a member read "You've topped up R1000.00,
 * the most the club takes" with R0 paid, for up to an hour, and nothing on any screen could free
 * it: the cancel return only fires when PayFast's own Cancel is pressed. The options read now
 * lists the open checkouts and keeps paid money apart from money waiting; each checkout carries a
 * Cancel (`POST /credit/topup/{id}/cancel`), which frees the limit at once. A payment that did go
 * through after all is still credited — the club's record wins over the cancel.
 * </p>
 */

/** One checkout the club is still waiting on PayFast for (`open_checkouts` on the options read). */
export type OpenCheckout = { id: string; amount_zar: number; created_at: string; counts_until?: string };

/** The options with the M5-2 split. All optional: an older API sends none of them. */
export type TopUpSplit = { paid_zar?: number; waiting_zar?: number; open_checkouts?: OpenCheckout[] };

/** A status read with when the payment was started (M5-2). Absent from an older API. */
export type TopUpSnapshot = TopUpStatus & { created_at?: string; counts_until?: string };

export function openCheckoutsOf(o: TopUpOptions & TopUpSplit): OpenCheckout[] {
  return Array.isArray(o.open_checkouts) ? o.open_checkouts : [];
}

/** Paid and waiting, when the API keeps them apart; null for an older API that sends only the sum. */
export function splitOf(o: TopUpOptions & TopUpSplit): { paid: number; waiting: number } | null {
  if (typeof o.paid_zar !== "number" || typeof o.waiting_zar !== "number") return null;
  return { paid: o.paid_zar, waiting: o.waiting_zar };
}

export const OPEN_CHECKOUTS = {
  title: "Payments waiting on PayFast",
  help: "If you left PayFast without paying, cancel the payment here and that amount is free to top up again. If you did pay, leave it — it clears on its own.",
  line: (iso: string) => `Waiting on a payment you started at ${clubClock(iso)}`,
  cancel: "Cancel",
  cancelLabel: (amount: number, iso: string) => `Cancel the ${formatMoney(amount)} payment started at ${clubClock(iso)}`,
  statusCancel: "Cancel this payment",
} as const;

/** What a cancel ended in, in the member's words. Every branch says what the club's record shows. */
export const CANCEL_SAID = {
  cancelled: (amount: number) => `Cancelled. Nothing was charged, and ${formatMoney(amount)} of your limit is free again.`,
  completed: (amount: number) => `That ${formatMoney(amount)} payment went through after all, so it wasn't cancelled — the credits are in your wallet.`,
  lostLanded: (amount: number) => `The reply got lost, so the club's record was checked: the payment is cancelled and ${formatMoney(amount)} of your limit is free again.`,
  lostStillWaiting: "The reply got lost, so the club's record was checked: this payment is still waiting and nothing was cancelled. Try again.",
  lostUnknown: "The reply got lost and the club couldn't be checked either, so we can't say yet whether this was cancelled. Look again in a moment before trying again.",
  offline: "Cancelling needs a connection. Nothing was sent — try again when you're back online.",
  missing: "The club can't find that payment on your account any more. The list has been refreshed.",
  failed: "The club couldn't cancel that payment just now. Nothing was changed — try again in a moment.",
} as const;

/**
 * The limits line and the reached state in paid-and-waiting words (M5-2). "R500 of your R1000
 * used" counted a checkout nobody paid as used; unpaid money is "waiting", never "used".
 */
export const TOP_UP_SPLIT = {
  limits: (min: string, remaining: string, split: { paid: string; waiting: string | null }, max: string, block: string) =>
    split.waiting === null
      ? `Min ${min} · Up to ${remaining} more (${split.paid} of your ${max} paid) · Multiples of ${block} only`
      : `Min ${min} · Up to ${remaining} more (${split.paid} paid, ${split.waiting} waiting on PayFast, of your ${max}) · Multiples of ${block} only`,
  heldTitle: "Your limit is held by payments you haven't finished",
  held: (paid: string, waiting: string, max: string) =>
    `${paid} paid and ${waiting} waiting on payments you started at PayFast — the most the club takes from one member by card is ${max}. Cancel a payment you didn't finish, below, to top up again.`,
} as const;

/** How a cancel ended: the row as the club now holds it, and whether that came from a read-back. */
export type CancelResult = { status: TopUpSnapshot; proven: boolean };

/**
 * Cancels one checkout. A lost reply is read back (the cancel is idempotent and never overwrites a
 * completion): a row no longer Pending is the answer, a row still Pending means nothing landed, an
 * unreadable record is said as unknown. A refusal is re-thrown for {@link cancelSentence}.
 */
export function cancelOpenCheckout(id: string): Promise<CancelResult> {
  return writeOrReadBack<TopUpSnapshot>(
    () => endpoints.topupCancel(id),
    async () => {
      const now: TopUpSnapshot = await endpoints.topupStatus(id);
      return now.status === "Pending" ? null : now;
    },
  ).then(({ value, proven }) => ({ status: value, proven }));
}

/** The sentence for a finished cancel. */
export function cancelledSentence(result: CancelResult, amount: number): string {
  if (result.status.status === "Completed") return CANCEL_SAID.completed(amount);
  return result.proven ? CANCEL_SAID.lostLanded(amount) : CANCEL_SAID.cancelled(amount);
}

/** The sentence for a cancel that threw. */
export function cancelFailedSentence(error: unknown): string {
  if (error instanceof OfflineError) return CANCEL_SAID.offline;
  if (error instanceof UnsureOutcome) return error.checked ? CANCEL_SAID.lostStillWaiting : CANCEL_SAID.lostUnknown;
  if (error instanceof ApiError && error.status === 404) return CANCEL_SAID.missing;
  return CANCEL_SAID.failed;
}
