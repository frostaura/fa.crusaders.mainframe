import { clubRowTime } from "../clubClock";

/**
 * The words for reads shown from the phone and writes refused offline (R4 wave B). Tests query
 * these constants, never the sentences.
 */

/**
 * "14:02" today, "Tue 29 Sep, 14:02" before today — in the CLUB's clock and day (R18 X18-3), the
 * zone kept on the phone with its reads (R17 X17-5). It was the phone's own, so a member abroad
 * read "showing what we had at 22:31" over kept bookings at 13:15 club time. Before the club has
 * ever said its zone, `clubRowTime` falls back to the reader's — never a guess.
 */
export function asOfLabel(at: number, now = Date.now()): string {
  return clubRowTime(at, now);
}

/** R15 X15-3 — see {@link OFFLINE_COPY.backOnlineTail}. */
const OFFLINE_TAIL = /(?:It|They|This page) loads? by (?:itself|themselves) once you're back online/;

export const OFFLINE_COPY = {
  /**
   * After "Couldn't <action> — ". Known not to have happened: nothing left the phone. R15 X15-3 —
   * true whether the phone has no network or has one that cannot reach the club (it read "this
   * phone is offline" on Wi-Fi without internet).
   */
  writeCause: "this needs a connection to the club, and this phone can't reach it right now. Nothing was sent — try again in a moment.",
  /** The stale banner's heading. */
  staleTitle: "You're offline",
  /** The stale banner's line: what is on screen and when it was true. */
  /** After "You're offline — ", so it starts lower-case (R17 X17-6). */
  staleLine: (at: number) => `showing what we had at ${asOfLabel(at)}. It updates by itself when you're back online.`,
  /**
   * R15 X15-3 — the read never reached the club but the phone says it HAS a network (Wi-Fi
   * without internet, the club's system down): never "You're offline", which only
   * `navigator.onLine === false` may say.
   */
  unreachableTitle: "Can't reach the club",
  unreachableLine: (at: number) => `showing what we had at ${asOfLabel(at)}. Try again in a moment.`,
  /** R15 X15-3 — the pass's badge in the same case; the code works at the door either way. */
  unreachableBadge: "Can't reach the club — your code still works",
  /**
   * R15 X15-3 — a nothing-kept line's "comes back by itself once you're back online" tail, and
   * what it reads when the phone is online but the club cannot be reached (only a fresh read,
   * on returning to the page or a retry, brings it back then).
   */
  backOnlineTail: OFFLINE_TAIL,
  unreachableTail: "Try again in a moment",
  /** A nothing-kept line as said when the phone is online but the club cannot be reached. */
  unreachableNothingKept: (line: string) => line.replace(OFFLINE_TAIL, "Try again in a moment"),
  /** The same, when the club answered with a failure rather than not at all. */
  refreshFailedTitle: "Couldn't refresh",
  refreshFailedLine: (at: number) => `showing what we had at ${asOfLabel(at)}.`,
  /** The grid's reason booking is off while it is the phone's copy. */
  gridStale: "Booking needs a connection. This is the grid as it was — a slot shown free may have gone since.",
  /** A Book press on a remembered grid. */
  /** R15 X15-3 — true whether the phone has no network or one that cannot reach the club. */
  bookNeedsConnection: "Booking needs a connection to the club — this grid is from earlier and may have changed. Try again in a moment.",
  /**
   * R6 X6-4 — offline, and this page was never drawn on this phone, so nothing is kept to show.
   * After {@link OFFLINE_COPY.staleTitle}: what is missing, and that it loads by itself.
   */
  nothingKept: {
    inbox: "Your notifications haven't been opened on this phone yet, so there's nothing kept to show. They load by themselves once you're back online.",
    activity: "This period hasn't been opened on this phone yet, so there's nothing kept to show. It loads by itself once you're back online — or pick a period you've looked at before.",
    /** R7 X7-3 (FD1's pages): Invites, a booking's detail, Profile's My game. */
    invites: "Your invites haven't been opened on this phone yet, so there's nothing kept to show. They load by themselves once you're back online.",
    booking: "This booking hasn't been opened on this phone yet, so there's nothing kept to show. It loads by itself once you're back online.",
    myGame: "Your game hasn't been opened on this phone yet, so there's nothing kept to show. It loads by itself once you're back online.",
    /** R8 X8-2 (FD1b) — Bookings on a cold start with no signal: no day kept, so no grid and no games. */
    schedule: "This day hasn't been opened on this phone yet, so there's no schedule or games kept to show. They load by themselves once you're back online.",
    /** R8 X8-2 — the Wallet on a cold start with no signal. */
    wallet: "Your wallet hasn't been opened on this phone yet, so there's nothing kept to show. It loads by itself once you're back online.",
    /** R10 X10-1 — Profile on a cold start with no signal (it read red "couldn't be reached"). */
    profile: "Your profile hasn't been opened on this phone yet, so there's nothing kept to show. It loads by itself once you're back online.",
  },
  /**
   * R9 X9-6 — a first read with nothing kept that has not answered after a few seconds (a stalled
   * connection: accepted, never answered). Said like the session splash's second line, beside the
   * skeleton, until the read lands or fails into the offline notice.
   */
  stillTrying: "Still trying — the connection is slow. This page fills in as soon as the club answers.",
  /** R6 X6-4 — `/wallet/buy` offline: nothing to show from the phone, and nothing to buy without the club. */
  buyNeedsConnection: "Buying minutes needs a connection: the packages and their prices come from the club, and you pay at PayFast. Nothing was sent. This page loads by itself once you're back online.",
} as const;
