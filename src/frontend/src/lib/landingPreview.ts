/**
 * The court box's idle glass, composed exactly as the Mega 3.0.0 composes it — for the console's
 * landing preview (Settings › Box screens, and each board on Boards).
 *
 * <p>
 * <b>This is a port, not a design.</b> The reference implementation is
 * `src/contracts/device-protocol/display/gen_cases.py` (`landing`, `marquee_window`), the Mega's
 * `courtlogic` implements the same functions in C++11, and `landingPreview.test.ts` executes every
 * `landing` and `marquee` vector of that corpus against this file — read from the corpus file, so a
 * vector added to the generator turns the preview red until it renders here too. Change the
 * generator first, never this file alone: an admin who previews "expanded" must see what the glass
 * will actually say, or the preview is a promise the box breaks.
 * </p>
 *
 * <p>
 * <b>No names, ever.</b> The glass is read by anybody standing at the court, so the landing says
 * which courts are lit and for how long and nothing about who booked them — the same rule the
 * heartbeat's snapshot keeps (`kind`/`ref`, never a name).
 * </p>
 */

export type LcdLayout = "compact" | "expanded";

/** What the bridge tells the Mega about itself; `offline` is the Mega's own verdict on a dead bridge. */
export type LandingStatus = "ready" | "starting" | "no_wifi" | "no_server" | "offline";

/** One relay as the Mega sees it: the club court number from `!MAP` (0 = unmapped, never shown). */
export type LandingCourt = { number: number; lit: boolean; seconds: number };

export type LandingInput = {
  layout: LcdLayout;
  marquee: boolean;
  status: LandingStatus;
  /** `HHMM` of the club's wall clock, or null before the bridge has one. */
  clock: string | null;
  /** A bridge `!NOTE` (e.g. `SETUP AP 1A2B`), replacing the status item. */
  note: string | null;
  courts: readonly LandingCourt[];
  /** Pages turned since landing was entered. */
  page: number;
  /** Marquee steps since the row was committed. */
  offset: number;
};

export const LCD_WIDTH: Readonly<Record<LcdLayout, number>> = { compact: 16, expanded: 20 };
export const LCD_ROWS: Readonly<Record<LcdLayout, number>> = { compact: 2, expanded: 4 };
export const LANDING_CTA: Readonly<Record<LcdLayout, string>> = {
  compact: "SCAN YOUR QR", expanded: "SCAN YOUR QR CODE",
};
export const OUT_OF_SERVICE = "OUT OF SERVICE";
/** Between marquee items, and between the end of a marquee and its restart. */
export const MARQUEE_GAP = "   ";
export const MAX_MINUTES_SHOWN = 999;

const STATUS_TEXT: Readonly<Record<Exclude<LandingStatus, "ready">, string>> = {
  starting: "STARTING UP",
  no_wifi: "NO WIFI",
  no_server: "NO SERVER",
  offline: "SEE THE DESK",
};

const spaces = (n: number): string => (n > 0 ? " ".repeat(n) : "");
const ljust = (text: string, width: number): string => text + spaces(width - text.length);

function center(text: string, width: number): string {
  const cut = text.slice(0, width);
  const left = Math.floor((width - cut.length) / 2);
  return ljust(spaces(left) + cut, width);
}

/**
 * Whole minutes of light left, rounded UP: a court with 20 s left reads 1 MIN, never 0 MIN while
 * its relay is closed.
 */
export function landingMinutes(seconds: number): number {
  return Math.min(MAX_MINUTES_SHOWN, Math.ceil(seconds / 60));
}

function courtCell(number: number, lit: boolean, seconds: number, layout: LcdLayout): string {
  const width = LCD_WIDTH[layout];
  const right = lit
    ? (layout === "expanded" ? `ON ${landingMinutes(seconds)} MIN` : `${landingMinutes(seconds)} MIN`)
    : "OFF";
  for (const label of [`COURT ${number}`, `CT ${number}`, `${number}`]) {
    if (label.length + 1 + right.length <= width) {
      return label + spaces(width - label.length - right.length) + right;
    }
  }
  return ljust(`${number} ${right}`.slice(0, width), width);
}

function courtItem(number: number, lit: boolean, seconds: number): string {
  return lit ? `COURT ${number} ${landingMinutes(seconds)} MIN` : `COURT ${number} OFF`;
}

function statusItem(status: LandingStatus, clock: string | null, note: string | null): string {
  if (status === "offline") return STATUS_TEXT.offline;
  if (note) return note;
  if (status === "ready") return clock ? `READY ${clock.slice(0, 2)}:${clock.slice(2)}` : "READY";
  return STATUS_TEXT[status];
}

/**
 * The visible window of one row. A row no wider than the glass is static; a wider one loops — the
 * text, a gap, the text again — one character per step, offset counted from the row's commit.
 */
export function marqueeWindow(text: string, width: number, offset: number): string {
  if (text.length <= width) return ljust(text, width);
  const loop = text + MARQUEE_GAP;
  const start = offset % loop.length;
  return (loop + loop).slice(start, start + width);
}

/** The landing rows, top to bottom, each exactly the layout's width. */
export function landing(input: LandingInput): string[] {
  const { layout, marquee, status, clock, note, courts, page, offset } = input;
  const width = LCD_WIDTH[layout];
  const mapped = courts.filter((court) => court.number > 0);
  const title = status === "offline" ? OUT_OF_SERVICE : LANDING_CTA[layout];
  const rows = [center(title, width)];
  const statusLine = statusItem(status, clock, note);
  if (layout === "expanded") {
    const items = mapped.map((c) => courtCell(c.number, c.lit, c.seconds, layout));
    items.push(ljust(statusLine.slice(0, width), width));
    const pages = Math.ceil(items.length / 3);
    const p = page % pages;
    const shown = items.slice(3 * p, 3 * p + 3);
    while (shown.length < 3) shown.push(spaces(width));
    return [...rows, ...shown];
  }
  if (marquee) {
    const text = [...mapped.map((c) => courtItem(c.number, c.lit, c.seconds)), statusLine].join(MARQUEE_GAP);
    return [...rows, marqueeWindow(text, width, offset)];
  }
  const items = mapped.map((c) => courtCell(c.number, c.lit, c.seconds, layout));
  items.push(ljust(statusLine.slice(0, width), width));
  return [...rows, items[page % items.length]];
}

/** How many pages the landing turns through before it repeats — for the preview's own clock. */
export function landingPageCount(layout: LcdLayout, marquee: boolean, mappedCourts: number): number {
  if (layout === "expanded") return Math.ceil((mappedCourts + 1) / 3);
  if (marquee) return 1;
  return mappedCourts + 1;
}

// ---------------------------------------------------------------------------------------
// From the control board to the glass
// ---------------------------------------------------------------------------------------

/** What the console knows about one court's lights — the control board's `lights` block. */
export type LightsReading = {
  state?: string | null;
  until?: string | null;
  seconds_remaining?: number | null;
  as_of?: string | null;
} | null | undefined;

/**
 * Seconds of LIGHT left on a court, from the lights' own grant — never the booking's end (FA-8).
 *
 * <p>
 * `seconds_remaining` is relative to `as_of` (the instant the server read it), so it is re-based
 * on the clock: a figure read 40 s ago has 40 s less now. Without one, `until` minus now. Null
 * when the lights are not on, or nothing says how long they have.
 * </p>
 */
export function lightsSecondsLeft(lights: LightsReading, now: number): number | null {
  if (!lights || lights.state !== "on") return null;
  if (typeof lights.seconds_remaining === "number" && Number.isFinite(lights.seconds_remaining)) {
    const asOf = lights.as_of ? Date.parse(lights.as_of) : Number.NaN;
    const aged = Number.isFinite(asOf) ? Math.max(0, (now - asOf) / 1000) : 0;
    const left = Math.round(lights.seconds_remaining - aged);
    return left > 0 ? left : null;
  }
  if (lights.until) {
    const left = Math.round((Date.parse(lights.until) - now) / 1000);
    return Number.isFinite(left) && left > 0 ? left : null;
  }
  return null;
}

/**
 * One box's relays as its landing shows them, in relay order, from the control board's courts.
 * A court the board does not list reads dark: the glass shows OFF for an open relay whatever any
 * other source said, and the preview must not promise light the console cannot see.
 */
export function landingCourtsFor(
  courtNumbers: readonly number[],
  courts: readonly { court_number: number; lights?: LightsReading }[],
  now: number,
): LandingCourt[] {
  return courtNumbers.map((number) => {
    const court = courts.find((c) => c.court_number === number);
    const seconds = lightsSecondsLeft(court?.lights, now);
    return { number, lit: seconds !== null, seconds: seconds ?? 0 };
  });
}

/** `HHMM` of a wall-clock instant in the club's zone, as the bridge gives the Mega its clock. */
export function landingClock(now: number, timeZone: string | undefined): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone })
      .formatToParts(new Date(now));
    const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
    return `${hour}${minute}`;
  } catch {
    return "0000";
  }
}

/** A layout value from the wire: anything but `expanded` is compact, as on the box. */
export function asLayout(value: unknown): LcdLayout {
  return value === "expanded" ? "expanded" : "compact";
}
