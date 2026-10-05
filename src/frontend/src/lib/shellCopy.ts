/**
 * The shell's own sentences — what the frame around every page says when a page cannot be shown.
 * Tests query these constants.
 */
export const CHUNK_COPY = {
  /**
   * F4.3 — no signal, and this page's code is not on the phone. R16 X16-1: never "hasn't opened this
   * page before" — the phone cannot tell that apart from an install or an update that had not
   * finished fetching (the wallet was such a page on every fresh install), so it says only what is true.
   */
  offlineTitle: "You're offline — this page opens when you're back online",
  offlineBody: "This page isn't on this phone yet, so it needs signal once. Your code still works on My Code.",
  /** Online, and the page's code still would not arrive (after the one reload a new build earns). */
  failedTitle: "This page didn't load",
  /** IX-L (F4-6): said while ONLINE, so never "check your connection" — the phone's is fine. */
  failedBody: "Its code couldn't be fetched from the club — the app may have just been updated. Try again in a moment.",
  retry: "Retry",
  myCode: "Go to My Code",
} as const;

/**
 * The screen shown while a stored session exists and the club has not confirmed it
 * (`SessionScreens.ConnectionLost`). V-10: a 429 is the club answering "busy", not an outage, so
 * it gets its own heading and the rate-limit sentence from `lib/errors` — never "the connection".
 */
export const CONNECTION_COPY = {
  unreachableTitle: "Can't reach the club right now",
  unreachableBody: "You're still signed in. This is usually a brief interruption — we'll keep trying, and the page will carry on by itself once the connection is back.",
  busyTitle: "The club is busy right now",
  /** Follows `rateLimitedSentence(…)`. */
  busyBody: "You're still signed in, and nothing is wrong with your connection — we'll ask again by ourselves.",
  retry: "Try again now",
  /** R14 X14-3 — the phone itself says it has no connection: the member's signal, not the club. */
  offlineTitle: "You're offline",
  offlineBody: "This page needs a connection — what it shows isn't kept on this phone. You're still signed in, and it loads by itself once you're back online.",
} as const;
