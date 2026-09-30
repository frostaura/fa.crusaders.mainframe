import type { UnsureWords } from "./lostReply";

/**
 * The words for a write whose reply was lost (see `lib/lostReply.ts`), built from the screen's
 * own phrases so every surface says the three outcomes the same way:
 *
 * - proven: the screen's own success sentence, then that the reply was lost and we looked;
 * - checked: what the record still shows, and that nothing changed;
 * - unchecked: that we cannot tell, and where to look before pressing again.
 */
export const LOST_REPLY = {
  proven: (done: string) => `${done} The club's reply didn't arrive, so we checked its record.`,
  checked: (stillTrue: string) => `The club didn't answer, so we checked: ${stillTrue} — nothing changed. Try again in a moment.`,
  unchecked: (whether: string, lookAt = "the page") =>
    `The club didn't answer and we couldn't check either, so we can't tell whether ${whether}. Refresh ${lookAt} before trying again.`,
} as const;

/** One write's pair: "{still true}" after a look, "{whether}" when the look failed. */
export function unsureWords(stillTrue: string, whether: string, lookAt?: string): UnsureWords {
  return { checked: LOST_REPLY.checked(stillTrue), unchecked: LOST_REPLY.unchecked(whether, lookAt) };
}
