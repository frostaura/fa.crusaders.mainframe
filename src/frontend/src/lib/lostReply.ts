import { UnsureOutcome, outcomeUnknown } from "./bookingOutcome";

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
export type UnsureWords = { checked: string; unchecked: string };

/** The sentence for an {@link UnsureOutcome}, or null for anything else (a refusal says itself). */
export function unsureSentence(error: unknown, words: UnsureWords): string | null {
  if (!(error instanceof UnsureOutcome)) return null;
  return error.checked ? words.checked : words.unchecked;
}

export { UnsureOutcome, outcomeUnknown };
