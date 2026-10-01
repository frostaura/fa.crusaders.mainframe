/**
 * The words for reads shown from the phone and writes refused offline (R4 wave B). Tests query
 * these constants, never the sentences.
 */

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const DAY_TIME = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** "14:02" today, "Tue 29 Sep, 14:02" before today — in the phone's own clock, which is the member's. */
export function asOfLabel(at: number, now = Date.now()): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? TIME.format(at) : DAY_TIME.format(at);
}

export const OFFLINE_COPY = {
  /** After "Couldn't <action> — ". Known not to have happened: nothing left the phone. */
  writeCause: "this needs a connection, and this phone is offline. Nothing was sent — try again once you have signal.",
  /** The stale banner's heading. */
  staleTitle: "You're offline",
  /** The stale banner's line: what is on screen and when it was true. */
  staleLine: (at: number) => `Showing what we had at ${asOfLabel(at)}. It updates by itself when you're back online.`,
  /** The same, when the club answered with a failure rather than not at all. */
  refreshFailedTitle: "Couldn't refresh",
  refreshFailedLine: (at: number) => `Showing what we had at ${asOfLabel(at)}.`,
  /** The grid's reason booking is off while it is the phone's copy. */
  gridStale: "Booking needs a connection. This is the grid as it was — a slot shown free may have gone since.",
  /** A Book press on a remembered grid. */
  bookNeedsConnection: "Booking needs a connection — this grid is from earlier and may have changed. Try again once you have signal.",
} as const;
