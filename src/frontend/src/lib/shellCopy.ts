/**
 * The shell's own sentences — what the frame around every page says when a page cannot be shown.
 * Tests query these constants.
 */
export const CHUNK_COPY = {
  /** F4.3 — no signal, and this phone has never fetched this page's code. */
  offlineTitle: "You're offline — this page opens when you're back online",
  offlineBody: "This phone hasn't opened this page before, so it needs signal once. Your code still works on My Code.",
  /** Online, and the page's code still would not arrive (after the one reload a new build earns). */
  failedTitle: "This page didn't load",
  /** IX-L (F4-6): said while ONLINE, so never "check your connection" — the phone's is fine. */
  failedBody: "Its code couldn't be fetched from the club — the app may have just been updated. Try again in a moment.",
  retry: "Retry",
  myCode: "Go to My Code",
} as const;
