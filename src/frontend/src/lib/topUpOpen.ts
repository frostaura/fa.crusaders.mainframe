import { ApiError, endpoints, OfflineError, type OpenCheckout, type PurchaseStatus } from "./api";
import { writeOrReadBack, UnsureOutcome } from "./lostReply";
import { clubClock } from "./clubClock";
import { minutesCompact } from "./minutes";
import { formatMoney } from "./utils";

/**
 * The member's own purchases still waiting on PayFast, and their Cancel (review round 5, M5-2;
 * P13 §3.4, §3.6).
 *
 * <p>
 * PayFast sends no ITN for a cancel or an abandoned page, so a member who came back without
 * paying (by Back, not PayFast's own Cancel) left a Pending row for up to an hour. The shelf read
 * lists those (`open_checkouts`, newest first, with `expires_at`); each carries a Cancel, which is
 * the cancel return (`POST /minutes/purchase/{id}/cancel`): own row only, idempotent, and never
 * overwrites a completion — a payment that went through after all is still credited.
 * </p>
 *
 * <p>
 * P13 removed the spend cap, so nothing here talks about a limit any more: an open checkout holds
 * nothing back. Cancelling one is tidiness and certainty ("did I pay or not?"), never a way to
 * free money.
 * </p>
 */

export type { OpenCheckout };

/** What a checkout is called in a sentence: "5 hours (5 h) for R550.00". */
export function checkoutWhat(c: { package_name: string; minutes: number; amount_zar: number }): string {
  return `${c.package_name} (${minutesCompact(c.minutes)}) for ${formatMoney(c.amount_zar)}`;
}

export const OPEN_CHECKOUTS = {
  title: "Purchases waiting on PayFast",
  help: "If you left PayFast without paying, cancel it here — nothing was charged. If you did pay, leave it: it clears on its own and the minutes land in your wallet.",
  line: (iso: string) => `Started at ${clubClock(iso)}`,
  expires: (iso: string) => `Closes by itself at ${clubClock(iso)} if PayFast never confirms it`,
  cancel: "Cancel",
  cancelLabel: (c: OpenCheckout) => `Cancel the ${checkoutWhat(c)} purchase started at ${clubClock(c.created_at)}`,
  statusCancel: "Cancel this purchase",
} as const;

/** What a cancel ended in, in the member's words. Every branch says what the club's record shows. */
export const CANCEL_SAID = {
  cancelled: "Cancelled. Nothing was charged.",
  completed: (minutes: number) => `That payment went through after all, so it wasn't cancelled — ${minutesCompact(minutes)} are in your wallet.`,
  lostLanded: "The reply got lost, so the club's record was checked: the purchase is cancelled and nothing was charged.",
  lostStillWaiting: "The reply got lost, so the club's record was checked: this purchase is still waiting and nothing was cancelled. Try again.",
  lostUnknown: "The reply got lost and the club couldn't be checked either, so we can't say yet whether this was cancelled. Look again in a moment before trying again.",
  offline: "Cancelling needs a connection. Nothing was sent — try again when you're back online.",
  missing: "The club can't find that purchase on your account any more. The list has been refreshed.",
  failed: "The club couldn't cancel that purchase just now. Nothing was changed — try again in a moment.",
} as const;

/** How a cancel ended: the row as the club now holds it, and whether that came from a read-back. */
export type CancelResult = { status: PurchaseStatus; proven: boolean };

/**
 * Cancels one checkout. A lost reply is read back (the cancel is idempotent and never overwrites a
 * completion): a row no longer Pending is the answer, a row still Pending means nothing landed, an
 * unreadable record is said as unknown. A refusal is re-thrown for {@link cancelFailedSentence}.
 */
export function cancelOpenCheckout(id: string): Promise<CancelResult> {
  return writeOrReadBack<PurchaseStatus>(
    () => endpoints.minutesPurchaseCancel(id),
    async () => {
      const now = await endpoints.minutesPurchaseStatus(id);
      return now.status === "Pending" ? null : now;
    },
  ).then(({ value, proven }) => ({ status: value, proven }));
}

/** The sentence for a finished cancel. */
export function cancelledSentence(result: CancelResult): string {
  if (result.status.status === "Completed") return CANCEL_SAID.completed(result.status.minutes);
  return result.proven ? CANCEL_SAID.lostLanded : CANCEL_SAID.cancelled;
}

/** The sentence for a cancel that threw. */
export function cancelFailedSentence(error: unknown): string {
  if (error instanceof OfflineError) return CANCEL_SAID.offline;
  if (error instanceof UnsureOutcome) return error.checked ? CANCEL_SAID.lostStillWaiting : CANCEL_SAID.lostUnknown;
  if (error instanceof ApiError && error.status === 404) return CANCEL_SAID.missing;
  return CANCEL_SAID.failed;
}
