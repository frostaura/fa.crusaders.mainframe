import type { UnsureReason, UnsureWords } from "./lostReply";

/**
 * The words for a write whose reply was lost (see `lib/lostReply.ts`), built from the screen's
 * own phrases so every surface says the three outcomes the same way:
 *
 * - proven: the screen's own success sentence, then that the reply was lost and we looked;
 * - checked: what the record still shows, and that nothing changed;
 * - unchecked: that we cannot tell, and where to look before pressing again.
 */
/**
 * R17 X17-1 — the lead of every conflict_retry sentence: the club answered, to say another change
 * to the same thing landed at that instant and this one gave way. Asking again NOW is right.
 */
export const CONFLICT_LEAD = (what = "this") => `Someone else was changing ${what} at the same moment`;

const conflictChecked = (stillTrue: string) => `${CONFLICT_LEAD()}, so we checked: ${stillTrue} — nothing changed. Try again now.`;
const conflictUnchecked = (whether: string, lookAt = "the page") =>
  `${CONFLICT_LEAD()} and we couldn't check either, so we can't tell whether ${whether}. Refresh ${lookAt} before trying again.`;

/**
 * R18 (BE18s) — the lead of every `503 service_busy` sentence: the club answered, too busy to take
 * the write (every database connection in use) — not silent, not down; the wait is a moment.
 */
export const BUSY_LEAD = "The club's system was too busy to take this just now";

const busyChecked = (stillTrue: string) => `${BUSY_LEAD}, so we checked: ${stillTrue} — nothing changed. Try again in a moment.`;
const busyUnchecked = (whether: string, lookAt = "the page") =>
  `${BUSY_LEAD} and we couldn't check either, so we can't tell whether ${whether}. Refresh ${lookAt} before trying again in a moment.`;

/**
 * R19 X19-2 — the lead of every sentence for a write the club's system answered with an error (a
 * plain 500): it DID answer, so never "didn't answer"; whether the write landed before the error is
 * still unknown, so it is read back like any other 5xx. No promise of "a moment" — an error is not
 * a busy spell.
 */
export const ERROR_LEAD = "The club's system hit an error";

const errorChecked = (stillTrue: string) => `${ERROR_LEAD}, so we checked: ${stillTrue} — nothing changed. Try again, and tell the club committee if it keeps happening.`;
const errorUnchecked = (whether: string, lookAt = "the page") =>
  `${ERROR_LEAD} and we couldn't check either, so we can't tell whether ${whether}. Refresh ${lookAt} before trying again.`;

/** R19 — what a reply that arrived said, before the record proved the write landed anyway. */
export const PROVEN_LEAD: Record<Exclude<UnsureReason, "silent">, string> = {
  error: "The club's system hit an error",
  busy: "The club's system said it was too busy",
  conflict: "The club said someone else was changing the same thing",
};

export const LOST_REPLY = {
  /**
   * R19 — with why the outcome was unsure: a reply that DID arrive (an error, busy, a clash) is said
   * as what it said, then that the record shows the write went through; silence keeps its words.
   */
  proven: (done: string, why?: UnsureReason) => (why && why !== "silent"
    ? `${done} ${PROVEN_LEAD[why]}, but we checked its record: it went through.`
    : `${done} The club's reply didn't arrive, so we checked its record.`),
  checked: (stillTrue: string) => `The club didn't answer, so we checked: ${stillTrue} — nothing changed. Try again in a moment.`,
  unchecked: (whether: string, lookAt = "the page") =>
    `The club didn't answer and we couldn't check either, so we can't tell whether ${whether}. Refresh ${lookAt} before trying again.`,
  conflictChecked,
  conflictUnchecked,
  busyChecked,
  busyUnchecked,
  errorChecked,
  errorUnchecked,
  /** R19 — for a hand-written pair that carries no error words of its own. */
  errorGeneric: {
    checked: errorChecked("it is as it was"),
    unchecked: errorUnchecked("it went through"),
  },
  /** R18 — for a hand-written pair that carries no busy words of its own. */
  busyGeneric: {
    checked: `${BUSY_LEAD}, so we checked: it is as it was — nothing changed. Try again in a moment.`,
    unchecked: busyUnchecked("it went through"),
  },
  /** For a hand-written pair that carries no conflict words of its own. */
  conflictGeneric: {
    checked: `${CONFLICT_LEAD()}, so we checked: it is as it was — nothing changed. Try again now.`,
    unchecked: conflictUnchecked("it went through"),
  },
} as const;

/** One write's pair: "{still true}" after a look, "{whether}" when the look failed — and the same for a conflict_retry. */
export function unsureWords(stillTrue: string, whether: string, lookAt?: string): UnsureWords {
  return {
    checked: LOST_REPLY.checked(stillTrue),
    unchecked: LOST_REPLY.unchecked(whether, lookAt),
    conflict: { checked: conflictChecked(stillTrue), unchecked: conflictUnchecked(whether, lookAt) },
    busy: { checked: busyChecked(stillTrue), unchecked: busyUnchecked(whether, lookAt) },
    error: { checked: errorChecked(stillTrue), unchecked: errorUnchecked(whether, lookAt) },
  };
}
