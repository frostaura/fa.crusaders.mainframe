import { formatMoney } from "./utils";
import type { AdjustReasonCode } from "./adminApi";

/**
 * The admin's hand movement of a member's money, in words.
 *
 * <p>
 * <b>The defect this module exists to close (D3-B08).</b> The form was ONE signed field —
 * "Amount (credits — positive adds, negative deducts)" — with a free-text box, whose only
 * guard was "non-zero", and with no statement anywhere of what the member's balance would be
 * afterwards. A volunteer typing <code>-100</code> where they meant <code>100</code> moves a
 * member R200.00 the wrong way, and the new balance appears only in the toast
 * afterwards, four seconds long, over a row that has already changed.
 * </p>
 *
 * <p>
 * <b>The fix is not validation; it is two paths.</b> Adding money and taking it back are
 * different decisions with different consequences and different audiences, so they are
 * different flows with different titles and different button tones. A sign is not a decision
 * a person makes — it is a character they type — and a comment telling them which way it goes
 * is how a member loses R200.00.
 * </p>
 *
 * <p>
 * <b>And the resulting balance is stated BEFORE the press.</b> Money deserves more than four
 * seconds, and a figure computed here from a balance fetched separately is two numbers read at
 * two different instants, which is not a movement — hence `balance_before_credits` on the
 * server's response, and hence the check step reads three figures rather than one.
 * </p>
 */

/**
 * Which direction this flow is going. Never inferred from the sign of a field.
 *
 * <p>
 * <b>The type name outlives the vocabulary on purpose.</b> `CreditDirection` is an identifier,
 * not a sentence a volunteer reads, and renaming it would churn every caller for nothing. What
 * changed is the WORDS: the product no longer has a thing called a credit, so "Take credit
 * back" beside a figure written "R100.00" showed a desk two vocabularies for one balance.
 * </p>
 */
export type CreditDirection = "add" | "take_back";

export function sheetTitle(direction: CreditDirection, name: string): string {
  return direction === "add" ? `Top up ${name}` : `Take money back from ${name}`;
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

export function revenueNote(code: AdjustReasonCode): string {
  return countsAsRevenue(code)
    ? "This counts as money the club took, and appears in the club's revenue."
    : "This does not count as money the club took, so it stays out of the club's revenue.";
}

// ---------------------------------------------------------------------------------------
// The figures, stated before the press
// ---------------------------------------------------------------------------------------

/**
 * "Thandi has R370.00. After +R100.00: R470.00."
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
    return `Couldn't read ${name}'s balance. You can still ${direction === "add" ? "add money" : "take money back"}, `
      + "but the figure below is not available — the club's system works out the result.";
  }
  if (amount === null || amount === 0) return `${name} has ${formatMoney(balance)}.`;
  const signed = direction === "add" ? amount : -amount;
  const after = balance + signed;
  const movement = `${signed > 0 ? "+" : "−"}${formatMoney(Math.abs(amount))}`;
  return `${name} has ${formatMoney(balance)}. After ${movement}: ${formatMoney(after)}.`;
}

/** The one thing a "take money back" must say that a top-up need not: it can go negative. */
export function overdraftWarning(balance: number | null, amount: number | null): string | null {
  if (balance === null || amount === null || amount <= 0) return null;
  const after = balance - amount;
  if (after >= 0) return null;
  return `That takes them to ${formatMoney(after)} — they would owe the club ${formatMoney(Math.abs(after))} `
    + "and cannot book until it is made up.";
}

/** The refusal when somebody types a minus into the amount on the ADD path. */
export const MINUS_REFUSED
  = "Use “Take money back” at the bottom to take money off. This field only adds.";

export const TAKE_BACK_LINK = "Take money back instead";
export const ADD_LINK = "Add money instead";

export const TAKE_BACK_CONSEQUENCE
  = "This reduces what they can spend, and they are emailed about it.";

/** The armed consequence on the confirm — the one sentence read last, before the press. */
export function confirmConsequence(
  name: string, balance: number | null, amount: number, direction: CreditDirection,
): string {
  const after = balance === null ? null : balance + (direction === "add" ? amount : -amount);
  const head = direction === "add"
    ? `Add ${formatMoney(amount)} to ${name}?`
    : `Take ${formatMoney(amount)} back from ${name}?`;
  const result = after === null ? "" : ` They end on ${formatMoney(after)}.`;
  return `${head}${result} This goes on the ledger and cannot be deleted.`;
}

/** The receipt, which stays on screen rather than being a four-second toast. */
export function doneSentence(name: string, balanceAfter: number): string {
  return `Done. ${name} now has ${formatMoney(balanceAfter)}.`;
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
export function validateAmount(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return "Enter an amount.";
  if (trimmed.startsWith("-") || trimmed.startsWith("−")) return MINUS_REFUSED;
  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || amount <= 0) return "Enter an amount greater than zero.";
  if (Math.round(amount * 100) !== amount * 100) return "Amounts go to two decimal places.";
  return null;
}

export function validateReason(code: AdjustReasonCode | null, freeText: string): string | null {
  if (code === null) return "Choose why this is happening.";
  if (!freeText.trim()) return "Say why this one, in a few words. The member sees it on their wallet.";
  return null;
}
