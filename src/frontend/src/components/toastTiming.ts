/**
 * How long a toast's words take to read (R4, X4-8): 1.5 s to notice it, then ~60 ms a character —
 * about 180 words a minute, the slow end of reading on a phone — capped at 20 s. A lost-reply
 * explanation is two sentences and got the same 4 s as "Saved."; the floor stays the caller's
 * duration (4 s by default). Its own file so `Toast.tsx` exports only what it already did.
 */
export function toastReadingMs(text: string): number {
  return Math.min(20_000, 1_500 + 60 * text.trim().length);
}
