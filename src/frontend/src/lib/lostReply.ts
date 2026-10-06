import { UnsureOutcome, isConflictRetry, outcomeUnknown } from "./bookingOutcome";
import { LOST_REPLY } from "./lostReplyCopy";
import { ApiError } from "./api";

/**
 * A write whose reply was lost, read back before anything is said (review round 3, lane F2).
 *
 * <p>
 * <b>A 5xx, a timeout or a dropped connection is not a "no".</b> The club may have done the
 * thing and the reply died on the way back — the reviewer removed a player (DELETE landed,
 * refund posted) and was told "Couldn't remove that player" beside a list still showing them as
 * Paid. So an unknown outcome is looked up: the caller's `readBack` reads the club's record and
 * returns the proof that the write landed, `null` when the record shows it did NOT land, or
 * rejects when the record cannot be read either.
 * </p>
 *
 * <ul>
 *   <li>landed → `{ value, proven: true }` — the caller says what happened, as it would for an
 *   answer, and may prefix that the reply was lost.</li>
 *   <li>read and not landed → {@link UnsureOutcome} with `checked: true`: nothing changed.</li>
 *   <li>unreadable → {@link UnsureOutcome} with `checked: false`: "we can't tell".</li>
 * </ul>
 *
 * <p>
 * <b>Never a silent re-send.</b> Pressing again is the member's call, made on the sentence we
 * show. A refusal (any 4xx) is the club's answer and is re-thrown untouched.
 * </p>
 *
 * The same shape as `useAcceptFlow`'s accept (R2 F2-1), `cancelFlow`'s cancel and the desk's
 * `adjustmentAttempt`; this is the generic form for a screen with a record to read back.
 */
export type Landed<T> = { value: T; proven: boolean };

export async function writeOrReadBack<T>(
  write: () => Promise<T>,
  readBack: () => Promise<T | null>,
): Promise<Landed<T>> {
  try {
    return { value: await write(), proven: false };
  } catch (error) {
    if (!outcomeUnknown(error)) throw error;
    let found: T | null;
    try {
      found = await readBack();
    } catch {
      throw new UnsureOutcome(error, false);
    }
    if (found === null || found === undefined) throw new UnsureOutcome(error, true);
    return { value: found, proven: true };
  }
}

/** The two sentences an unknown outcome is said in: after a look that worked, and after one that did not. */
export type UnsurePair = { checked: string; unchecked: string };

/**
 * An unknown outcome's words. `conflict` (R17 X17-1) is the same pair for a write the club answered
 * `503 conflict_retry` — someone else was changing the same thing — built by `unsureWords`; a
 * hand-written pair without it gets {@link LOST_REPLY}'s generic conflict pair, never "didn't answer".
 */
export type UnsureWords = UnsurePair & { conflict?: UnsurePair; busy?: UnsurePair; error?: UnsurePair };

/**
 * Why an outcome is unknown, as the sentence must say it: the club too busy to take it (R18
 * `503 service_busy`), someone else changing the same thing (R17 `503 conflict_retry`), the club's
 * system answering with an error (R19 X19-2: a plain 500), or silence.
 */
export type UnsureReason = "busy" | "conflict" | "error" | "silent";

/**
 * The three-way cause the players hooks index their own sentences by (`{ busy, conflict, silent }`).
 * <b>Transitional (R19 X19-2):</b> an `error` is folded into `silent` here only so those callers keep
 * compiling until they carry an error sentence of their own and move to {@link unsureReasonOf} — the
 * ask is in the R19 FE19x report. Every `unsureSentence` caller already says the error.
 */
export type UnsureCause = "busy" | "conflict" | "silent";

export function unsureCauseOf(error: UnsureOutcome): UnsureCause {
  const reason = unsureReasonOf(error);
  return reason === "error" ? "silent" : reason;
}

/**
 * R19 X19-2 — "didn't answer" is true only when NOTHING answered: the connection failed, the request
 * timed out or was torn (`NetworkError`, an abort), or the gateway in front of the club's system said
 * the system did not answer it — 502, 504, and a 503 carrying no code of the club's own (down or
 * restarting, as `describeFailure` words it; R17 pinned it as silence). Any other 5xx is the club's
 * system answering — with an error — and a 500 said as silence sent a member to "try again in a
 * moment" over a fault that will not pass.
 */
const SILENT_STATUSES = new Set([502, 503, 504]);

export function unsureReasonOf(error: UnsureOutcome): UnsureReason {
  const original = error.original;
  if (isServiceBusy(original)) return "busy";
  if (isConflictRetry(original)) return "conflict";
  if (original instanceof ApiError && original.status >= 500 && !SILENT_STATUSES.has(original.status)) return "error";
  return "silent";
}

/** R18 (BE18s) — `503 { error: "service_busy" }`: the club answered, too busy for a moment. */
export function isServiceBusy(e: unknown): boolean {
  return e instanceof ApiError && e.code === "service_busy";
}

/** The sentence for an {@link UnsureOutcome}, or null for anything else (a refusal says itself). */
export function unsureSentence(error: unknown, words: UnsureWords): string | null {
  if (!(error instanceof UnsureOutcome)) return null;
  const pair = pairFor(unsureReasonOf(error), words);
  return error.checked ? pair.checked : pair.unchecked;
}

/** The pair a reason is said in — the screen's own twin when it has one, the generic one when not. */
function pairFor(reason: UnsureReason, words: UnsureWords): UnsurePair {
  if (reason === "busy") return words.busy ?? LOST_REPLY.busyGeneric;
  if (reason === "conflict") return words.conflict ?? LOST_REPLY.conflictGeneric;
  if (reason === "error") return words.error ?? LOST_REPLY.errorGeneric;
  return words;
}

export { UnsureOutcome, isConflictRetry, outcomeUnknown };
