import { formatMoney } from "./utils";
import { minutesSpoken } from "./minutes";
import {
  ADJUSTMENT_REASON_CODES, TOP_UP_REASON_CODES, type AdjustmentReasonCode, type SellReasonCode,
} from "./adminApi";
import { parseAmount, parseMinutesAmount } from "./amount";
import { amountProblemSentence } from "./amountCopy";
import { savesWords } from "./packagesCopy";
import { ApiError } from "./api";

/**
 * The desk's two ways of moving a member's minutes by hand, in words (P13 contract §3.7).
 *
 * <p>
 * <b>Sell a package</b> is how the club takes money at the desk: the member pays cash, EFT or a
 * card offline, and gets one package off THEIR shelf — their group's packages and the club's at
 * their discount, exactly what the app would sell them. It posts an `AdminTopUp` row of the
 * package's minutes and the rand received, which is what reaches the revenue report.
 * </p>
 *
 * <p>
 * <b>Adjust minutes</b> is goodwill and corrections — no money changes hands, so nothing here asks
 * for rand. It is still two paths, never one signed field (D3-B08): adding minutes and taking them
 * back are different decisions with different consequences, so they are different flows with
 * different titles and button tones. A sign is a character somebody types, not a decision.
 * </p>
 *
 * <p>
 * <b>The resulting balance is stated BEFORE the press</b> on both, and the receipt stays on screen:
 * money deserves more than a four-second toast.
 * </p>
 */

// ---------------------------------------------------------------------------------------
// Adjust minutes — goodwill and corrections (`POST /admin/minutes/{id}/adjust`)
// ---------------------------------------------------------------------------------------

/** Which direction an adjustment is going. Never inferred from the sign of a field. */
export type MinutesDirection = "add" | "take_back";

export function sheetTitle(direction: MinutesDirection, name: string): string {
  return direction === "add" ? `Add minutes for ${name}` : `Take minutes back from ${name}`;
}

/**
 * Why an adjustment is happening — the four codes `/adjust` takes (§3.7). The free-text reason
 * stays required as well: the code says what KIND, the reason says why THIS one.
 */
export const REASON_CHOICES: ReadonlyArray<{ code: AdjustmentReasonCode; label: string; forDirection: MinutesDirection | "both" }> = [
  { code: "goodwill", label: "Goodwill — something went wrong", forDirection: "add" },
  { code: "correction", label: "Correcting a mistake", forDirection: "both" },
  { code: "refund_outside_system", label: "Refunded outside the system", forDirection: "take_back" },
  { code: "other", label: "Something else", forDirection: "both" },
];

export function reasonChoicesFor(direction: MinutesDirection) {
  return REASON_CHOICES.filter((c) => c.forDirection === "both" || c.forDirection === direction);
}

/** How the desk took the money for a package it sold (§3.7) — the three `/sell` codes. */
export const PAYMENT_CHOICES: ReadonlyArray<{ code: SellReasonCode; label: string }> = [
  { code: "top_up_cash", label: "Cash paid at the desk" },
  { code: "top_up_eft", label: "EFT received" },
  { code: "top_up_card_offline", label: "Card paid at the desk" },
];

/** Every desk reason code — an adjustment's or a sale's — in words; the code itself if unknown. */
export function reasonLabel(code: string): string {
  return REASON_CHOICES.find((c) => c.code === code)?.label
    ?? PAYMENT_CHOICES.find((c) => c.code === code)?.label
    ?? code;
}

/** Whether a stored reason code is one of the desk's (the change record words them, §4.5). */
export function isDeskReasonCode(code: string): boolean {
  return (TOP_UP_REASON_CODES as readonly string[]).includes(code)
    || (ADJUSTMENT_REASON_CODES as readonly string[]).includes(code);
}

/** An adjustment never counts as money the club took — said on the check step, every time. */
export const NOT_REVENUE = "No money changes hands, so this stays out of the club's revenue.";

/** "+1 hour 30 minutes" / "−45 minutes" — the direction carries the sign, never a typed character. */
export function signedAmount(direction: MinutesDirection, amount: number): string {
  return `${direction === "add" ? "+" : "−"}${minutesSpoken(Math.abs(amount))}`;
}

/**
 * "Thandi has 6 hours 10 minutes. After +1 hour 40 minutes: 7 hours 50 minutes."
 *
 * <p>
 * A balance the console could not read is <b>not</b> zero. The sheet still works, because an
 * adjustment is a delta and the server computes the result — so the sentence says what it can and
 * refuses to do arithmetic on a number it does not have.
 * </p>
 */
export function balanceSentence(
  name: string, balance: number | null, amount: number | null, direction: MinutesDirection,
): string {
  if (balance === null) {
    return `Couldn't read ${name}'s balance. You can still ${direction === "add" ? "add minutes" : "take minutes back"}, `
      + "but the figure below is not available — the club's system works out the result.";
  }
  if (amount === null || amount === 0) return `${name} has ${minutesSpoken(balance)}.`;
  const after = balance + (direction === "add" ? amount : -amount);
  return `${name} has ${minutesSpoken(balance)}. After ${signedAmount(direction, amount)}: ${minutesSpoken(after)}.`;
}

/** The one thing a "take minutes back" must say that adding need not: it can go negative. */
export function overdraftWarning(balance: number | null, amount: number | null): string | null {
  if (balance === null || amount === null || amount <= 0) return null;
  const after = balance - amount;
  if (after >= 0) return null;
  return `That takes them to ${minutesSpoken(after)} — they would owe the club ${minutesSpoken(Math.abs(after))} `
    + "and cannot book until it is made up.";
}

/** The refusal when somebody types a minus into the amount on the ADD path. */
export const MINUS_REFUSED = "Use “Take minutes back” at the bottom to remove minutes. This field only adds.";

export const TAKE_BACK_LINK = "Take minutes back instead";
export const ADD_LINK = "Add minutes instead";
export const TAKE_BACK_CONSEQUENCE = "This reduces what they can spend, and they are emailed about it.";

/** The armed consequence on the confirm — the one sentence read last, before the press. */
export function confirmConsequence(
  name: string, balance: number | null, amount: number, direction: MinutesDirection,
): string {
  const after = balance === null ? null : balance + (direction === "add" ? amount : -amount);
  const head = direction === "add"
    ? `Add ${minutesSpoken(amount)} to ${name}?`
    : `Take ${minutesSpoken(amount)} back from ${name}?`;
  const result = after === null ? "" : ` They end on ${minutesSpoken(after)}.`;
  // R6 J6-8: the debt is said again where the press is armed, not only on the amount step.
  const owes = after !== null && after < 0
    ? ` They would owe the club ${minutesSpoken(-after)} and cannot book until it is made up.`
    : "";
  return `${head}${result}${owes} This goes on the ledger and cannot be deleted.`;
}

/**
 * The header over the receipt, frozen at the press (F3.5) — past tense, from the balance the
 * admin confirmed against, never re-derived from the balance the server has since sent back.
 */
export function receiptHeader(name: string, before: number | null, amount: number, direction: MinutesDirection): string {
  const movement = signedAmount(direction, amount);
  if (before === null) return `${movement} for ${name}.`;
  const after = before + (direction === "add" ? amount : -amount);
  return `${name} had ${minutesSpoken(before)}. ${movement} → ${minutesSpoken(after)}.`;
}

/** Null where the balance could not be re-read after a lost reply — never a made-up figure. */
export function doneSentence(name: string, balanceAfter: number | null): string {
  if (balanceAfter === null) return `Done. It is on ${name}'s ledger.`;
  return `Done. ${name} now has ${minutesSpoken(balanceAfter)}.`;
}

/**
 * A press whose reply never came back (review round 2, F3-2). The ledger is read to find out, so
 * each sentence says what the ledger showed — never "didn't go through" over minutes that landed.
 */
export const LOST_REPLY = {
  landed: "The reply got lost on the way back, so the club's ledger was checked: this went through, once.",
  absent: "The reply got lost, so the club's ledger was checked: nothing arrived and nothing was added. You can try again.",
  unknown: (name: string) =>
    `The reply got lost and the ledger couldn't be read either, so it isn't known yet whether this went through. Open ${name}'s ledger before trying again.`,
  refused: "The club refused that. Nothing was changed.",
} as const;

/**
 * What the confirm's live region says when a press did not end on a receipt (review round 3,
 * I-6): the full sentence is on the toast; this is the short line heard at the button.
 */
export const LIVE_SAID = {
  refused: "That didn't go through. Nothing was changed.",
  absent: "Nothing arrived, and nothing was added.",
  unknown: "It isn't known yet whether this went through.",
  reused: "An earlier press of this already went through. Nothing more was added.",
} as const;

/** `409 idempotency_key_reused`: an earlier press of this movement already landed, and the server says what. */
function keyReusedSentence(stored: unknown): string {
  const row = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
  const amount = typeof row.amount_minutes === "number" ? row.amount_minutes : null;
  const what = amount === null ? "An earlier press of this already went through"
    : `An earlier press already went through: ${amount < 0 ? "−" : "+"}${minutesSpoken(Math.abs(amount))}`;
  const why = typeof row.reason === "string" && row.reason.trim() ? ` (“${row.reason.trim()}”)` : "";
  return `${what}${why}. Nothing more was added — check the ledger before adding anything else.`;
}

export const LIVE_PUSH_NOTE
  = "They are emailed, and their phone shows the new balance within a few seconds without them reloading anything.";

/** The largest by-hand movement the server accepts (§3.7: `|amountMinutes| ≤ 999999`). */
export const ADJUST_MAX_MINUTES = 999_999;

/** The typed minutes as a whole number, or null — through the one shared parser, no decimals. */
export function parseMinutes(text: string): number | null {
  const parsed = parseMinutesAmount(text, { max: ADJUST_MAX_MINUTES });
  return parsed.ok ? parsed.value : null;
}

/** What is wrong with the amount, or null. Positive-only on BOTH paths: the direction carries the sign. */
export function validateAmount(text: string): string | null {
  const parsed = parseMinutesAmount(text, { max: ADJUST_MAX_MINUTES });
  if (parsed.ok) return null;
  if (parsed.problem.kind === "negative") return MINUS_REFUSED;
  return amountProblemSentence(parsed.problem, "minutes");
}

/**
 * What a refused desk movement says, by the server's code — or null for the generic sentence.
 * Covers both routes: `amount_out_of_range` carries the ceiling (`max_minutes`, or `max`).
 */
export function adjustRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError) || typeof err.payload !== "object" || err.payload === null) return null;
  const payload = err.payload as Record<string, unknown>;
  const say = typeof payload.error === "string" ? REFUSALS[payload.error] : undefined;
  return say ? say(payload) : null;
}

/** One sentence per refusal code the desk's two routes answer (§3.7), each from its own payload. */
const REFUSALS: Record<string, (payload: Record<string, unknown>) => string> = {
  amount_out_of_range: (payload) => {
    const max = typeof payload.max_minutes === "number" ? payload.max_minutes
      : typeof payload.max === "number" ? payload.max : ADJUST_MAX_MINUTES;
    return `That is more than one movement can be — the most is ${minutesSpoken(max)}. Nothing was changed.`;
  },
  amount_zero: () => "Enter an amount greater than zero. Nothing was changed.",
  idempotency_key_reused: (payload) => keyReusedSentence(payload.stored),
  reason_required: () => "Say why, in a few words. Nothing was changed.",
  zar_received_out_of_range: (payload) => {
    const max = typeof payload.max === "number" ? ` — the most is ${formatMoney(payload.max)}` : "";
    return `That amount of money received can't be right${max}. Nothing was changed.`;
  },
  zar_received_not_whole_cents: () => "The money received has to be in whole cents. Nothing was changed.",
  package_unavailable: () => SELL_COPY.unavailable,
};

export const REASON_MISSING = {
  code: "Choose why this is happening.",
  detail: "Say why this one, in a few words. The member sees it on their wallet.",
} as const;

/** What the reason step's two fields are missing, each for its own field (review round 3, A-4). */
export function reasonComplaints(code: string | null, freeText: string): { code?: string; detail?: string } {
  return {
    code: code === null ? REASON_MISSING.code : undefined,
    detail: freeText.trim() ? undefined : REASON_MISSING.detail,
  };
}

/** The adjust sheet's own words. */
export const ADJUST_SHEET = {
  steps: ["Amount", "Reason", "Check"] as const,
  /** The quick amounts, in whole minutes: a quarter, half an hour, an hour, two. */
  quick: [15, 30, 60, 120] as const,
  quickLabel: "Quick amounts",
  amountLabel: "Another amount, in minutes",
  amountPlaceholder: "e.g. 45",
  /** The typed minutes said back as the club says an amount — "90" → "= 1 h 30 min". */
  amountEcho: (minutes: number) => `= ${minutesSpoken(minutes)}`,
  reasonLabel: "Reason",
  reasonDescription: "The member sees this on their wallet.",
  reasonPlaceholder: "Choose a reason",
  detailLabel: "And why this one?",
  detailPlaceholder: "e.g. Lights failed on court 2 at 19:00",
  next: "Next",
  back: "Back",
  cancel: "Cancel",
  done: "Done",
  balanceNow: "Balance now",
  thisMovement: "This",
  balanceAfter: "Balance after",
  unreadable: "Couldn't read it",
  serverWorksItOut: "the club's system works it out",
  reasonLine: (label: string, text: string) => `Reason: ${label} — “${text}”`,
  failed: "That didn't go through.",
  idleAdd: (minutes: number) => `Add ${minutesSpoken(minutes)}`,
  idleTakeBack: (minutes: number) => `Take back ${minutesSpoken(minutes)}`,
  /** R5 I5-3: said while a movement is on its way — and again on each refused way out. */
  sending: (name: string) => `Waiting for the club to answer about ${name}'s minutes. This stays open until it does.`,
} as const;

// ---------------------------------------------------------------------------------------
// Sell a package — the desk takes money (`POST /admin/minutes/{id}/sell`)
// ---------------------------------------------------------------------------------------

/** The rand the desk says it received. Defaults to the member's price; it may differ (§3.7). */
export function parseZar(text: string): number | null {
  const parsed = parseAmount(text, { allowZero: true, max: 1_000_000 });
  return parsed.ok ? parsed.value : null;
}

export function validateZar(text: string): string | null {
  const parsed = parseAmount(text, { allowZero: true, max: 1_000_000 });
  return parsed.ok ? null : amountProblemSentence(parsed.problem, "rand");
}

/** Basis points as a percentage: 1000 → "10%", 1250 → "12.5%", 0 → "0%" (a group's package discount, §3.8). */
export function percentOfBps(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** The rand as the field shows it, without the symbol: 495 → "495.00". */
export function zarField(value: number): string {
  return value.toFixed(2);
}

const ON_THE_LEDGER = "This goes on the ledger and cannot be deleted.";
const SELL_REVENUE = (zar: string) => `${zar} counts as money the club took, and appears in the club's revenue.`;
const SELL_NO_REVENUE = "No money changes hands, so the club's revenue does not change.";

export const SELL_COPY = {
  title: (name: string) => `Sell ${name} a package`,
  steps: ["Package", "Payment", "Check"] as const,
  shelfLabel: (name: string) => `${name}'s packages`,
  shelfHint: "What the app would sell them: their groups' packages, and the club's at their discount.",
  shelfAction: "read this member's packages",
  shelfEmptyTitle: "Nothing to sell yet",
  shelfEmptyHint: "The club has no packages this member can buy. Add one under Packages.",
  shelfEmptyAction: "Open Packages",
  discountLine: (pct: string, group: string) => `${pct} off the club's packages, from ${group}.`,
  listPrice: (price: string) => `was ${price}`,
  saving: (zar: string, pct: number | null) => savesWords(zar, pct),
  fromGroup: (group: string) => `${group} package`,
  pickPackage: "Choose a package.",
  paymentLabel: "How was it paid?",
  paymentPlaceholder: "Choose how",
  /** R7 J7-6 — said under "How was it paid?", so it names the payment, not a reason. */
  paymentMissing: "Choose how it was paid.",
  /**
   * R7 J7-10 — a package that costs this member nothing (a 100% discount, contract §3.7/§3.4
   * `package_price_zero`) has no payment to record; this stands where the payment questions were.
   */
  freeNote: "This package costs them nothing, so there is nothing to pay and no money to record.",
  zarLabel: "Money received",
  zarHelp: (price: string) => `In rand, exactly as handed over. Their price is ${price}; if they paid something else, say what.`,
  zarDiffers: (price: string) => `Not their price of ${price} — the club's revenue shows what you enter here.`,
  detailLabel: "Note",
  detailPlaceholder: "e.g. Receipt 0412",
  detailHint: "The member sees this on their wallet, with the package's name.",
  revenue: SELL_REVENUE,
  /** R7 J7-10 — the revenue line by amount: R0.00 is not "money the club took". */
  revenueFor: (zar: number) => (zar > 0 ? SELL_REVENUE(formatMoney(zar)) : SELL_NO_REVENUE),
  balanceNow: "Balance now",
  adds: "Package",
  balanceAfter: "Balance after",
  zarRow: "Money received",
  idle: (minutes: number) => `Sell ${minutesSpoken(minutes)}`,
  confirm: (name: string, pkg: string, zar: string) => `Sell ${pkg} to ${name} for ${zar}? This goes on the ledger and cannot be deleted.`,
  /** R7 J7-10 — the confirm by amount: a free package is given, not sold for R0.00. */
  confirmFor: (name: string, pkg: string, zar: number) => (zar > 0
    ? `Sell ${pkg} to ${name} for ${formatMoney(zar)}? ${ON_THE_LEDGER}`
    : `Give ${pkg} to ${name} at no charge? ${ON_THE_LEDGER}`),
  receipt: (name: string, pkg: string, minutes: number) => `${pkg} sold — ${minutesSpoken(minutes)} added for ${name}.`,
  unavailable: "That package isn't on this member's shelf any more — it was changed or retired. Their packages were read again; choose again.",
  sending: (name: string) => `Waiting for the club to answer about ${name}'s package. This stays open until it does.`,
  next: "Next",
  back: "Back",
  cancel: "Cancel",
  done: "Done",
} as const;
