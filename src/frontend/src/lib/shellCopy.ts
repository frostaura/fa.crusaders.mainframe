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
  failedBody: "Its code couldn't be fetched. Check your connection and try again.",
  retry: "Retry",
  myCode: "Go to My Code",
} as const;
