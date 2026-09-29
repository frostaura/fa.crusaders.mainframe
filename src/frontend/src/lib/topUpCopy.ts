import { formatCredits, formatMoney } from "./utils";
import type { AdjustReasonCode } from "./adminApi";
import { parseAmount } from "./amount";
import { amountProblemSentence } from "./amountCopy";
import { ApiError } from "./api";

/**
 * The admin's hand movement of a member's credit, in words.
 *
 * <p>
 * <b>The defect this module exists to close (D3-B08).</b> The form was ONE signed field —
 * "Amount (credits — positive adds, negative deducts)" — with a free-text box, whose only
 * guard was "non-zero", and with no statement anywhere of what the member's balance would be
 * afterwards. A volunteer typing <code>-100</code> where they meant <code>100</code> moves a
 * member two hundred credits the wrong way, and the new balance appears only in the toast
 * afterwards, four seconds long, over a row that has already changed.
 * </p>
 *
 * <p>
 * <b>The fix is not validation; it is two paths.</b> Adding credit and taking it back are
 * different decisions with different consequences and different audiences, so they are
 * different flows with different titles and different button tones. A sign is not a decision
 * a person makes — it is a character they type — and a comment telling them which way it goes
 * is how a member loses two hundred credits.
 * </p>
 *
 * <p>
 * <b>And the resulting balance is stated BEFORE the press.</b> Money deserves more than four
 * seconds, and a figure computed here from a balance fetched separately is two numbers read at
 * two different instants, which is not a movement — hence `balance_before_credits` on the
 * server's response, and hence the check step reads three figures rather than one.
 * </p>
 */

/** Which direction this flow is going. Never inferred from the sign of a field. */
export type CreditDirection = "add" | "take_back";

export function sheetTitle(direction: CreditDirection, name: string): string {
  return direction === "add" ? `Top up ${name}` : `Take credit back from ${name}`;
}

/**
 * Why this movement is happening — the closed set, and which ledger type each posts to.
 *
 * <p>
 * <b>This is a reporting fix, not tidiness.</b> Revenue is top-ups net of reversals, so an
 * admin taking R200 in cash at the desk and adjusting the member up posts an
 * `AdminAdjustment`, which sits in the adjustment bucket and is NOT counted — the club's own
 * revenue figure is wrong by every cash top-up it takes. The three top-up codes post
 * `AdminTopUp`, in the funding bucket beside a PayFast top-up; the four adjustment codes post
 * `AdminAdjustment`, as today.
 * </p>
 *
 * <p>
 * The free-text reason stays required as well. The code says what KIND, the reason says why
 * THIS one, and month-end needs both.
 * </p>
 */
export const REASON_CHOICES: ReadonlyArray<{ code: AdjustReasonCode; label: string; forDirection: CreditDirection | "both" }> = [
  { code: "top_up_cash", label: "Cash paid at the desk", forDirection: "add" },
  { code: "top_up_eft", label: "EFT received", forDirection: "add" },
  { code: "top_up_card_offline", label: "Card paid at the desk", forDirection: "add" },
  { code: "goodwill", label: "Goodwill — something went wrong", forDirection: "add" },
  { code: "correction", label: "Correcting a mistake", forDirection: "both" },
  { code: "refund_outside_system", label: "Refunded outside the system", forDirection: "take_back" },
  { code: "other", label: "Something else", forDirection: "both" },
];

export function reasonChoicesFor(direction: CreditDirection) {
  return REASON_CHOICES.filter((c) => c.forDirection === "both" || c.forDirection === direction);
}

export function reasonLabel(code: AdjustReasonCode): string {
  return REASON_CHOICES.find((c) => c.code === code)?.label ?? code;
}

/**
 * Whether a code posts to the funding bucket, which is the half that reaches the revenue
 * report. Shown on the check step, because a volunteer choosing "Goodwill" for a cash payment
 * is making a bookkeeping decision without knowing it.
 */
export function countsAsRevenue(code: AdjustReasonCode): boolean {
  return code === "top_up_cash" || code === "top_up_eft" || code === "top_up_card_offline";
}

export function revenueNote(code: AdjustReasonCode, zarReceived?: number | null): string {
  if (!countsAsRevenue(code)) {
    return "This does not count as money the club took, so it stays out of the club's revenue.";
  }
  // F3.4: the revenue figure is the rand the desk says it RECEIVED, never the credits — a
  // promise of revenue with no rand beside it was a sentence the reports could not keep.
  return typeof zarReceived === "number"
    ? `${formatMoney(zarReceived)} counts as money the club took, and appears in the club's revenue.`
    : "This counts as money the club took — say how much was received, and that is what the club's revenue shows.";
}

// ---------------------------------------------------------------------------------------
// The figures, stated before the press
// ---------------------------------------------------------------------------------------

/**
 * "Thandi has 370.00 cr. After +100.00 cr: 470.00 cr."
 *
 * <p>
 * Three arms, and the third is the one that matters: a balance the console could not read is
 * <b>not</b> zero. The sheet still works, because an adjustment is a delta and the server
 * computes the result — so the sentence says what it can and refuses to arithmetic on a
 * number it does not have.
 * </p>
 */
export function balanceSentence(
  name: string, balance: number | null, amount: number | null, direction: CreditDirection,
): string {
  if (balance === null) {
    return `Couldn't read ${name}'s balance. You can still ${direction === "add" ? "add credit" : "take credit back"}, `
      + "but the figure below is not available — the club's system works out the result.";
  }
  if (amount === null || amount === 0) return `${name} has ${formatCredits(balance)}.`;
  const signed = direction === "add" ? amount : -amount;
  const after = balance + signed;
  const movement = `${signed > 0 ? "+" : "−"}${formatCredits(Math.abs(amount))}`;
  return `${name} has ${formatCredits(balance)}. After ${movement}: ${formatCredits(after)}.`;
}

/** The one thing a "take credit back" must say that a top-up need not: it can go negative. */
export function overdraftWarning(balance: number | null, amount: number | null): string | null {
  if (balance === null || amount === null || amount <= 0) return null;
  const after = balance - amount;
  if (after >= 0) return null;
  return `That takes them to ${formatCredits(after)} — they would owe the club ${formatCredits(Math.abs(after))} `
    + "and cannot book until it is made up.";
}

/** The refusal when somebody types a minus into the amount on the ADD path. */
export const MINUS_REFUSED
  = "Use “Take credit back” at the bottom to remove credit. This field only adds.";

export const TAKE_BACK_LINK = "Take credit back instead";
export const ADD_LINK = "Add credit instead";

export const TAKE_BACK_CONSEQUENCE
  = "This reduces what they can spend, and they are emailed about it.";

/** The armed consequence on the confirm — the one sentence read last, before the press. */
export function confirmConsequence(
  name: string, balance: number | null, amount: number, direction: CreditDirection,
): string {
  const after = balance === null ? null : balance + (direction === "add" ? amount : -amount);
  const head = direction === "add"
    ? `Add ${formatCredits(amount)} to ${name}?`
    : `Take ${formatCredits(amount)} back from ${name}?`;
  const result = after === null ? "" : ` They end on ${formatCredits(after)}.`;
  return `${head}${result} This goes on the ledger and cannot be deleted.`;
}

/** The receipt, which stays on screen rather than being a four-second toast. */
/**
 * The header over the receipt, frozen at the press (F3.5) — past tense, from the balance the
 * admin confirmed against, never re-derived from the balance the server has since sent back.
 */
export function receiptHeader(name: string, before: number | null, amount: number, direction: CreditDirection): string {
  const movement = `${direction === "add" ? "+" : "−"}${formatCredits(amount)}`;
  if (before === null) return `${movement} for ${name}.`;
  const after = before + (direction === "add" ? amount : -amount);
  return `${name} had ${formatCredits(before)}. ${movement} → ${formatCredits(after)}.`;
}

export function doneSentence(name: string, balanceAfter: number): string {
  return `Done. ${name} now has ${formatCredits(balanceAfter)}.`;
}

export const LIVE_PUSH_NOTE
  = "They are emailed, and their phone shows the new balance within a few seconds without "
  + "them reloading anything.";

// ---------------------------------------------------------------------------------------
// Validation, in the desk's words
// ---------------------------------------------------------------------------------------

/**
 * What is wrong with the amount, or null.
 *
 * <p>
 * Positive-only by construction on BOTH paths — the direction carries the sign, so there is
 * no field anywhere in this flow whose sign is a decision. That is the whole of D3-B08.
 * </p>
 */
/**
 * The largest by-hand movement the server accepts — `WalletEndpoints.MaxAdjustmentCredits`.
 * Said at the field (F3.17): 99999999999 used to be accepted here and refused vaguely later.
 */
export const ADJUST_MAX_CREDITS = 99_999_999.99;

/** The typed credits as a number, or null — through the one shared parser (F3.18). */
export function parseCredits(text: string): number | null {
  const parsed = parseAmount(text, { max: ADJUST_MAX_CREDITS });
  return parsed.ok ? parsed.value : null;
}

export function validateAmount(text: string): string | null {
  const parsed = parseAmount(text, { max: ADJUST_MAX_CREDITS });
  if (parsed.ok) return null;
  // The desk's own sentence for a minus: this flow has a way to take credit back.
  if (parsed.problem.kind === "negative") return MINUS_REFUSED;
  return amountProblemSentence(parsed.problem, "credits");
}

/** The rand the desk says it received, for a top-up that counts as revenue (F3.4). */
export const ZAR_RECEIVED = {
  label: "How much money was received?",
  help: "In rand, exactly as handed over or paid in. This is what the club's revenue shows.",
  placeholder: "e.g. 150",
  row: "Money received",
} as const;

export function parseZar(text: string): number | null {
  const parsed = parseAmount(text);
  return parsed.ok ? parsed.value : null;
}

export function validateZar(text: string): string | null {
  const parsed = parseAmount(text);
  return parsed.ok ? null : amountProblemSentence(parsed.problem, "rand");
}

/**
 * What a refused adjustment says, by the server's code — or null for the generic sentence.
 * `amount_out_of_range` carries the ceiling (`max_credits`, or `max` per the round-1 contract).
 */
export function adjustRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError) || typeof err.payload !== "object" || err.payload === null) return null;
  const payload = err.payload as Record<string, unknown>;
  switch (payload.error) {
    case "amount_out_of_range": {
      const max = typeof payload.max_credits === "number" ? payload.max_credits
        : typeof payload.max === "number" ? payload.max : ADJUST_MAX_CREDITS;
      return `That is more than one movement can be — the most is ${formatCredits(max)}. Nothing was changed.`;
    }
    case "amount_not_whole_cents": return "Credits go to two decimal places. Nothing was changed.";
    case "zar_received_required": return "Say how much money was received — a top-up that counts as revenue needs it. Nothing was changed.";
    default: return null;
  }
}

export function validateReason(code: AdjustReasonCode | null, freeText: string): string | null {
  if (code === null) return "Choose why this is happening.";
  if (!freeText.trim()) return "Say why this one, in a few words. The member sees it on their wallet.";
  return null;
}
