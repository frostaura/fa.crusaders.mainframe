/**
 * GOAL item 16 — what happens after you book, in words for somebody who is not good with
 * technology.
 *
 * <p>
 * <b>The audience is the design.</b> The club's membership skews older, most members visit
 * once a week, and the goal note names them explicitly. Two consequences run through every
 * sentence here. Anything shown on a first run is forgotten before the second visit, so there
 * is exactly one PUSHED thing — a card about the booking you just made, at the moment it is
 * actionable — and everything else is PULLED from a guide that is always reachable. And no
 * sentence may contain a number, a name or a label the product cannot prove: a guide that
 * quotes words the box does not have is worse than one that describes the button.
 * </p>
 *
 * <p>
 * <b>The flow described here is the box's real one</b>, taken from the devices design rather
 * than imagined: <b>scan → card → court → time</b>. A member with a booking is not asked to
 * choose a court or a length, because the panel has no OK button — its eight buttons are four
 * courts and four durations, and "press any button to confirm" maps onto nothing. A member
 * without one presses a green button and then a black one. That asymmetry is the single most
 * useful thing to tell somebody, and the old product told them nothing at all.
 * </p>
 *
 * <p>
 * <b>No coach marks, no overlay tour.</b> They would fire on the schedule — the one screen
 * where a member is already mid-task — cover the grid they are explaining, and be gone by the
 * next weekly visit. NN/g's recommendation is pull revelations over push ones, with the help
 * easy to dismiss and easy to recall; the "what happens next" card is that, at the moment it
 * is needed, and `/how-it-works` is the recall.
 * </p>
 */

/**
 * What the four buttons on the court box are FOR, in the order the flow uses them.
 *
 * <p>
 * <b>These name a role, never a label.</b> The club's own labels live in
 * `AdminSettings.button_map` — eight short strings, by physical position — and a club that
 * relabels a button must not silently invalidate its own help text. Where the map is known,
 * the guide prints the club's words; where it is not, it prints these, and it prints them as
 * a DESCRIPTION rather than in quotation marks. Printing "PRESS C" when the box says "CARD"
 * is worse than saying "the card button".
 * </p>
 */
export const COURT_BUTTON_ROLE = "a green court button";
export const TIME_BUTTON_ROLE = "a black time button";

/**
 * What the keys on the hand-built box physically READ, confirmed by the devices lane.
 *
 * <p>
 * Four green court keys marked <b>A B C D</b> over four black duration keys marked
 * <b>15 30 45 60</b>, and no OK, Cancel or Back anywhere on the panel. These are the firmware
 * defaults as well as the labels on the plastic, so they are what a member is looking at
 * unless the club has re-mapped a key — at which point `button_map` wins and the club's own
 * words are printed instead. This is a description of hardware, not a guess at a label.
 * </p>
 */
export const DEFAULT_COURT_KEYS = ["A", "B", "C", "D"] as const;
export const DEFAULT_TIME_KEYS = ["15", "30", "45", "60"] as const;

/**
 * The club's eight button labels, split into the two rows a member actually presses.
 *
 * <p>
 * The wire is `string[]` by physical position: four green court buttons then four black
 * duration buttons, on the hand-built box. A map that is absent, short, or full of the
 * grammar's own non-labels (`off`, `none`) yields nothing rather than a guess — the guide
 * then describes the row instead of quoting it, which is always true.
 * </p>
 */
export function buttonRow(map: readonly string[] | null | undefined, row: "court" | "time"): string[] {
  if (!map || map.length < 8) return [];
  const slice = row === "court" ? map.slice(0, 4) : map.slice(4, 8);
  const labels = slice
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry !== "" && entry !== "off" && entry !== "none")
    // `court:A` / `minutes:45` is the wire grammar; a member reads the part after the colon.
    .map((entry) => (entry.includes(":") ? entry.slice(entry.indexOf(":") + 1).trim() : entry))
    .filter((entry) => entry !== "");
  return labels.length === slice.length ? labels : [];
}

/**
 * How long the door stays open, said without inventing a number.
 *
 * <p>
 * The unlock dwell is a tenant setting delivered to the door's own board on its heartbeat
 * (15 seconds by default). <b>No member-facing endpoint carries it</b>, so until one does the
 * sentence says "a few seconds" — which is true at any setting — rather than quoting the
 * default as though the page had read it. The number appears the day it is served.
 * </p>
 */
export function doorHoldSentence(unlockSeconds: number | null): string {
  const how = unlockSeconds && unlockSeconds > 0 ? `about ${unlockSeconds} seconds` : "a few seconds";
  return `It stays unlocked for ${how}, so push the door while the light is still green.`;
}

/** One numbered step of the guide. `illustration` names a drawing, never a file. */
export type GuideStep = {
  id: string;
  title: string;
  /** One instruction per sentence. Rendered as separate paragraphs, in order. */
  body: string[];
  /** Which of the three inline drawings sits beside it, if any. */
  illustration?: "door" | "box" | "lights";
};

export type GuideInput = {
  /** The club's own button labels, by physical position, or null. See {@link buttonRow}. */
  buttonMap?: readonly string[] | null;
  /** The door's unlock dwell in seconds, when a member-facing read ever carries one. */
  unlockSeconds?: number | null;
  /** Does this club have door scanners at all? Unknown keeps the door step's promise soft. */
  doors?: "yes" | "no" | "unknown";
};

/** "the green buttons marked A, B, C and D" — or the role, when the club has not been read. */
function namedRow(labels: readonly string[], colour: "green" | "black"): string {
  if (labels.length === 0) return colour === "green" ? COURT_BUTTON_ROLE : TIME_BUTTON_ROLE;
  const last = labels[labels.length - 1];
  const list = labels.length === 1 ? last : `${labels.slice(0, -1).join(", ")} and ${last}`;
  return `the ${colour} buttons marked ${list}`;
}

export const GUIDE_TITLE = "How it works";
export const GUIDE_INTRO = "From booking a court to walking off it. Nothing here needs any setting up — "
  + "your phone and your code are all you bring.";

/**
 * The guide, built for THIS club.
 *
 * <p>
 * A function rather than a constant because three of its sentences depend on what the club
 * has told this page: the door step is omitted entirely at a club with no doors (the same
 * silence the code page keeps, for the same reason), and the court-box steps print the club's
 * own button labels where they are known.
 * </p>
 */
export function guideSteps(input: GuideInput = {}): GuideStep[] {
  /*
    The club's own map wins; where it has not been served, the keys the box is physically
    built with are named. Both are true statements about a button a member can see — what is
    never printed is a label invented to fill the sentence.
  */
  const courtKeys = buttonRow(input.buttonMap, "court");
  const timeKeys = buttonRow(input.buttonMap, "time");
  const courts = namedRow(courtKeys.length ? courtKeys : DEFAULT_COURT_KEYS, "green");
  const times = namedRow(timeKeys.length ? timeKeys : DEFAULT_TIME_KEYS, "black");
  const steps: GuideStep[] = [
    {
      id: "book",
      title: "Book a court",
      body: [
        "Pick a green box on the grid. Each box is one court for fifteen minutes.",
        "Before anything is charged you see the court, the time, the price, and what your wallet has left.",
      ],
    },
    {
      id: "code",
      title: "Come to the club",
      body: [
        "Bring your phone. Open Your code from the menu at the top.",
        "The code changes every minute. That is normal, and you never have to do anything about it.",
      ],
    },
  ];

  // A club with no door scanners must not be told about one. "Unknown" keeps the step, because
  // a member who has one and is not told about it is stuck outside a building.
  if (input.doors !== "no") {
    steps.push({
      id: "door",
      title: "Get in the door",
      illustration: "door",
      body: [
        "There is a small scanner beside the club door.",
        "Hold your phone in front of it, screen facing the scanner, about a hand's width away.",
        "The light turns green and the lock clicks.",
        doorHoldSentence(input.unlockSeconds ?? null),
      ],
    });
  }

  steps.push(
    {
      id: "box",
      title: "Turn the lights on at the court box",
      illustration: "box",
      body: [
        "On the wall by the courts is a box with a small screen. When nobody is using it, it says SCAN YOUR CODE.",
        "Hold your phone up to the scanner on the box. The screen says it is checking.",
        "Then it greets you: HI and your name, with what it found underneath.",
        "If you have a court booked, the box knows which one and for how long. The lights come on by themselves — "
          + "there is nothing to press.",
        `If you have not booked, the box asks you to choose. Press ${courts} for the court you want, then press `
          + `${times} for how long you want it. The lights come on straight after.`,
      ],
    },
    {
      id: "playing",
      title: "While you play",
      illustration: "lights",
      body: [
        "The box screen shows every court and how many minutes each one has left.",
        "When your time is up the lights go off by themselves. You do not have to do anything.",
      ],
    },
    {
      id: "walkup",
      title: "No booking? Walk up",
      body: [
        "If a court is free you can start on it there and then.",
        "On your phone, tap Member code, then use the box the same way. You are charged for the time you use.",
        "Somebody else can scan right after you. The box shows how many seconds until it is ready again, and a scan "
          + "is never turned away for being too soon.",
      ],
    },
    {
      id: "stuck",
      title: "If something does not work",
      body: [
        "The scanner will not read my phone — turn your screen brightness right up and tap the code to fill the "
          + "screen. Hold it still, about a hand's width away.",
        // The door line goes with the door step. A club with no gate must not meet the word
        // anywhere — not in a step, not in a troubleshooting list — which is the same silence
        // the code page keeps and the same way it is easiest to break.
        ...(input.doors === "no"
          ? []
          : ["The door did not open — tap The door did not open on your code screen. It will tell you what it can see."]),
        "The box is not doing anything — the club's number is at the bottom of your code screen.",
      ],
    },
  );
  return steps;
}

// --- the one thing that is pushed ----------------------------------------------------

export const WHATS_NEXT_TITLE = "You're booked. Here's what happens next.";
export const WHATS_NEXT_DISMISS = "Got it";
export const WHATS_NEXT_MORE = "Read the whole guide";

/**
 * The four lines of the pushed card, for THIS booking.
 *
 * <p>
 * The court number and the times are the real ones, never placeholders — a card that says
 * "your court" to somebody deciding which of four doors to open is a card that has wasted its
 * one moment. The card persists until the booking ends, so it is there when the member opens
 * the app in the car park, and it is dismissible because NN/g's other hard requirement is
 * that push help be easy to get rid of.
 * </p>
 */
export function whatsNextSteps(booking: { courtNumber: number | null; startsClock: string; endsClock: string },
  input: GuideInput = {}): string[] {
  const where = booking.courtNumber != null ? `court ${booking.courtNumber}` : "your court";
  const lines = [
    `Your court is ${where}, from ${booking.startsClock} to ${booking.endsClock}.`,
    "Bring your phone. Your code is under Your code in the menu — it changes every minute, which is normal.",
  ];
  if (input.doors !== "no") {
    lines.push("At the club door, hold your phone in front of the small scanner beside it. "
      + doorHoldSentence(input.unlockSeconds ?? null));
  }
  lines.push(
    "At the box by the courts, hold your phone up to its scanner. It knows which court you booked, so the lights "
      + "come on by themselves — there is nothing to press.",
    "When your time is up the lights go off by themselves.",
  );
  return lines;
}

// --- where the guide is reached from ---------------------------------------------------

export const GUIDE_PATH = "/how-it-works";
export const GUIDE_LINK_LABEL = "How it works";
export const GUIDE_TILE_HINT = "Booking, the door, and the court box";
export const GUIDE_FROM_CODE = "New here? How it works, step by step";

/**
 * <b>The limitation, stated rather than hidden.</b>
 *
 * <p>
 * A dismissal is remembered in this browser only: there is no member-preferences endpoint on
 * the wire yet, so a member who dismisses this on their phone and opens the app on the club
 * tablet is shown it again. That is the honest behaviour of what exists, and it is why the
 * card is cheap to dismiss rather than something to hunt for. When `/me/preferences` lands,
 * `whats_next_dismissed_until` — an instant, not a list of booking ids — replaces the local
 * value and the local one becomes the optimistic mirror.
 * </p>
 */
export const WHATS_NEXT_DISMISS_KEY = "crusaders.onboarding.whats-next-until";
