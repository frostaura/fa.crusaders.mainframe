/**
 * Every sentence on My Code that is about the code itself (D1 — the single rotating member
 * code). The door sentences stay in `memberDoorCopy.ts`; tests query by these constants.
 *
 * <p>
 * <b>One code, so no name for "which one".</b> The page used to carry a booking code and a member
 * code under two tabs, and half its copy existed to say which of the two was on screen and what
 * the other would have done. There is one code now; it opens the door, lights the member's court
 * (or one they are an accepted partner on) and pays for somebody else's court at the box. So the
 * copy says what it is FOR, once, and never names a kind.
 * </p>
 */

export const MY_CODE = {
  /**
   * R4 form factor — the wallet beside the pass on a wide screen (SPEC 3.2): the figure a member
   * spends, and the way to add to it, without leaving the page they open at the court.
   */
  wallet: {
    label: "Your wallet",
    spendable: "You can spend",
    open: "Open wallet",
  },
  /** F4-13 — the page is called what the nav calls it; "Your code" beside a "My Code" tab was two names. */
  title: "My Code",
  /** The pass card's accessible name. */
  passLabel: "Your member pass",
  overline: "MEMBER",
  /** The club's name on the pass band — the same words the crest link carries. */
  clubName: "Crusaders Squash",
  /** The accessible name of the element whose text is the whole token. */
  codeLabel: "Your code",
  fullScreenTrigger: "Show your code full screen",
  fullScreenHint: "Tap the code to fill the screen",
  /** Under the full-screen code — a scanner reads a bright screen, and a phone may be dimmed. */
  brightnessHint: "Turn your screen brightness up — scanners read a bright screen best.",
  /** The badge when the club could not be reached and the code is being made from the key on this phone. */
  offlineBadge: "Offline — your code still works",
  loading: "Getting your code…",
  tryAgain: "Try again",
  checkAgain: "Check again",
  /** R15 X15-3 — the phone says it has no network (`navigator.onLine === false`). */
  needsSignal: {
    title: "Your code needs signal the first time",
    body: "This phone hasn't set up your code yet, and it can only do that while it can reach the club. "
      + "Open this page once with signal — after that your code works with no signal at all.",
  },
  /** R15 X15-3 — the phone has a network but the club could not be reached: never "needs signal". */
  needsClub: {
    title: "Your code needs the club the first time",
    body: "This phone hasn't set up your code yet, and it can only do that while it can reach the club — it can't "
      + "right now. Try again in a moment; after that your code works with no signal at all.",
  },
  /**
   * F4.1 — the session lapsed; the code is still made from the key on this phone. Said once,
   * above the pass, with the way back in — never as an error, because the code is good.
   */
  signedOut: {
    body: "You're signed out, but your code still works from this phone. Sign in to see your bookings and the door's latest.",
    signIn: "Sign in",
    /** No key on this phone and no session to make one with. */
    noKey: "Sign in to set up your code on this phone.",
  },
  unavailable: "Your club hasn't switched on member codes yet. Ask at the desk if you need to get in or onto a court.",
  barredNoCode: "There's no code to show while that is the case, because doors and court boxes would turn it away. "
    + "If the desk has just sorted it out, check again.",
} as const;

/** What a member the club has barred is told, by the server's reason code. */
export function barredReason(code: string): string {
  if (code === "member_suspended") {
    return "Your membership is suspended, so your code would not open anything. Speak to the club to have it restored.";
  }
  if (code === "no_membership") {
    return "This account has no membership at the club, so there is no code to show. Apply to join, or ask the club.";
  }
  return "Your membership isn't active yet, so your code would not open anything. The club has to approve it first.";
}

/** "New code in 12 seconds" — the sentence beside the countdown ring. */
export function newCodeIn(seconds: number): string {
  return `New code in ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/** The line under the pass card: where the code is used, at a club with a door and at one without. */
export function codeUseLine(doors: boolean): string {
  if (!doors) {
    return "Show this to the scanner on the court box. It switches the lights on for your booking and marks you as arrived,"
      + " and lets you pay for a friend's court at the box, when you choose to.";
  }
  return "Show this at the club door or the scanner on a court box. At a court it switches the lights on and marks you as"
    + " arrived; at a door it just lets you in. It also lets you pay for a friend's court at the box, when you choose to.";
}
