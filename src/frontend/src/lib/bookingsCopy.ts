import { formatCredits } from "./utils";
import { playersWhen } from "./playersCopy";

/**
 * Every word the Bookings screen says — the page, the grid and (below the grid section) the two
 * sheets it opens.
 *
 * <p>
 * One module for the reason `lib/doorsCopy.ts` set: the same sentence is needed in a visible
 * label, an `aria-label` and a live region, and tests query by these constants rather than by a
 * copy of the words, so a wording change is one edit and never a red suite. The explanations a
 * locked cell answers with (hours, windows, the daily cap) stay in `lib/gridCopy.ts`, which the
 * explainer and the wallet notice already share.
 * </p>
 *
 * <p>
 * <b>Sections are owned.</b> The GRID section is the grid lane's; the SHEETS section is appended
 * by the sheets lane. Neither edits the other's.
 * </p>
 */

/* ═══════════════════════════════════ GRID ═══════════════════════════════════ */

export const BOOKINGS_COPY = {
  title: "Bookings",
  /** R4 form factor (SPEC 3.1) — the rail beside the grid from a 72rem page. */
  railLabel: "Your day and your games",
  summaryTitle: "Your wallet",
  summarySpendable: "You can spend",
  /** R5 A5-9 — booking FOR a member, the rail's wallet is theirs, never the desk's. */
  summaryTheirTitle: (name: string) => `${name}'s wallet`,
  summaryTheirSpendable: (name: string) => `${name} can spend`,
  /** The sr-only h2 the grid is named by — the court names are already the visible headers. */
  gridHeading: "Courts and times",
  dayStripLabel: "Choose a day",
  jumpToDate: "Jump to a date",
  refresh: "Refresh the schedule",
  /** The toolbar toggle, both states. An icon button: this is its name and its tooltip. */
  selectOn: "Select several slots",
  selectOff: "Stop selecting",
  noHours: "This day has no hours to show.",
  loadAction: "load the schedule",
  courtChips: "Jump to a court",
  /** The time column's header. */
  timeHeader: "Time",
  nowCaption: "Now",
  yourRate: "your rate",
  /** The floating bar's toolbar name, its × and its primary. */
  actionBarLabel: "Selected slots",
  clearSelection: "Clear selection",
  bookSelection: "Book",
  /** Live-region sentences. */
  selectionOn: "Selection on. Choose the free slots you want, then press Book.",
  selectionOff: "Selection off.",
  selectionClearedDayChange: "Selection cleared — you changed day.",
  /** The action bar's headline before anything is ticked. */
  chooseSlots: "Choose free slots",
  dismissExplanation: "Dismiss",
  noCourts: "No courts yet",
  noCourtsHint: "The club hasn't set up any courts to book.",
} as const;

/** The word each cell wears. Short enough for a 104px column at a large root font. */
export const CELL_TEXT = {
  available: "Book",
  past: "—",
  closed: "Closed",
  /** R5 — beyond the club's rolling booking window: free, but not bookable until it opens. */
  notYetOpen: "Not open yet",
  /** The member's own daily cap is reached — the COURT is free, so never "Full" (R2 F1-6). */
  limit: "Your limit",
  hold: "Club hold",
  mine: "Your court",
  onCourt: "On court",
  played: "Played",
  minePast: "Past",
  idle: "Not in use",
  reserved: "Reserved",
} as const;

/** "Book Court 1 at 18:00 for 50.00 cr" — which court, which time, what it costs. */
export function bookCellLabel(where: string, priceCredits: number): string {
  return `Book ${where} for ${formatCredits(priceCredits)}`;
}

/** The viewer's own future booking: pressing it opens the cancel sheet. */
export function mineCellLabel(where: string, checkedIn: boolean | null): string {
  return checkedIn ? `Cancel your booking on ${where} — checked in` : `Cancel your booking on ${where}`;
}

export function minePastCellLabel(where: string, checkedIn: boolean | null): string {
  return checkedIn ? `${where} — your past booking, attended` : `${where} — your past booking`;
}

/** Another member's booking, as an ADMIN reaches it. First name only — the grid's invariant. */
export function otherCellAdminLabel(firstName: string | null, where: string): string {
  return `${firstName ?? CELL_TEXT.reserved} — cancel on their behalf, ${where}`;
}

/** Another member's booking, as a MEMBER sees it. */
export function bookedByLabel(where: string, firstName: string | null): string {
  return `${where} — booked by ${firstName ?? "another member"}`;
}

export function continuesLabel(where: string, mine: boolean): string {
  return mine ? `${where} — continues, your booking` : `${where} — continues, reserved`;
}

export function idleCellLabel(where: string): string {
  return `${where} — this court is not in use`;
}

/** "Court 1 · 50.00 cr / 15 min" — the header's price line. */
export function slicePriceLine(priceCredits: number, sliceMinutes: number): string {
  return `${formatCredits(priceCredits)} / ${sliceMinutes} min`;
}

/* ─────────────────────────── the selection ─────────────────────────── */

/**
 * "3 slots · 150.00 cr" — the action bar's headline; "3 slots · 150.00 cr · 1 booking" when
 * bookings are in the selection too, so free and booked are counted apart.
 */
export function selectionHeadline(slots: number, totalCredits: number, bookings = 0): string {
  const parts: string[] = [];
  if (slots > 0) parts.push(`${slots} ${slots === 1 ? "slot" : "slots"} · ${formatCredits(totalCredits)}`);
  if (bookings > 0) parts.push(`${bookings} ${bookings === 1 ? "booking" : "bookings"}`);
  return parts.join(" · ");
}

/** The action bar's cancel button — it opens the cancel sheet for the ticked bookings. */
export function cancelSelectionLabel(bookings: number): string {
  return bookings === 1 ? "Cancel booking" : `Cancel ${bookings} bookings`;
}

/**
 * A member at their daily cap trying to take one more. States the rule, not the person, and
 * says what is still possible — the same three rules `lib/gridCopy` keeps for the banner.
 * R4 M4-7: said when a pick is REFUSED, so it names what is already chosen — "You can book 4
 * more slots" beside four ticked slots read as an invitation to tick a fifth.
 */
export function selectionCapSentence(cap: number, dayLabel: string | null = null): string {
  // F1.7 — the cap is the SHOWN day's; "today" is only true when that is today.
  const when = dayLabel ? `on ${dayLabel}` : "today";
  if (cap <= 0) return `You've booked your slots for ${dayLabel ?? "today"}, so there's nothing more to choose.`;
  const what = cap === 1 ? "That's 1 slot" : `That's ${cap} slots`;
  return `${what} — the most you can book ${when}, the club's daily limit. Untick one to choose a different time.`;
}

/**
 * R4 M4-7 — the same refusal, short enough for the selection bar's two-line detail on a phone
 * (the full sentence is what a screen reader hears).
 */
export function selectionCapShort(cap: number, dayLabel: string | null = null): string {
  const when = dayLabel ? `on ${dayLabel}` : "today";
  if (cap <= 0) return `Limit reached: nothing more ${when}.`;
  return `Limit reached: ${cap} ${cap === 1 ? "slot" : "slots"} ${when}.`;
}

/** The mobile court chip's name — it scrolls the grid to that court. */
export function courtChipLabel(courtName: string): string {
  return `Show ${courtName}`;
}

/**
 * An ADMIN at or below zero (R19). The member's banner ("You have no credits, so you can't book
 * yet") is false for an admin, who may book anyway — so the admin gets the fact, calmly, and
 * what it means, instead of a refusal the booking API would not make.
 */
export function adminWalletNote(balanceCredits: number): string {
  return `Your balance is ${signedCredits(Number(balanceCredits.toFixed(2)) || 0)}. `
    + "As an admin you can still book — going below zero is recorded.";
}

/**
 * A booking just made, painted before the club's confirming read has given it its real id. It
 * cannot be opened, cancelled or chosen until then — a cancel for a temporary id is a cancel the
 * server has never heard of.
 */
/**
 * Perf lane (2026-09-30) — the cell a booking is being SENT for, while the club has not answered.
 * Tentative on purpose: it claims nothing about money or the court; the sheet over it says what
 * the club answered, and a refusal puts the cell straight back.
 */
export const HOLDING_CELL = {
  word: "Holding…",
  label: (where: string) => `${where} — booking it now; the club has not answered yet.`,
} as const;

export const PENDING_CELL = {
  word: "Confirming…",
  label: (where: string) => `${where} — just booked, still confirming with the club. It can be changed in a moment.`,
} as const;

/* ═══════════════════════════════════ SHEETS ═══════════════════════════════════ */
/* Appended by the sheets lane. */
/*
 * Dialog copy rules (design-system.md, Patterns): dismiss = "Cancel"; a multi-step dismiss =
 * "Back"; the primary names its outcome ("Book 3 slots · 150.00 cr"); when the primary itself
 * cancels something, the dismiss names what is kept ("Keep booking"). Banned: "Keep looking",
 * "Don't move any credit", "OK".
 */

/** A credit figure honest about its sign: "−16.00 cr" with a real minus (U+2212), never "-16". */
export function signedCredits(value: number): string {
  return value < 0 ? `−${formatCredits(-value)}` : formatCredits(value);
}

function countOf(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const BOOK_SHEET = {
  title: (count: number) => (count === 1 ? "Book this court" : `Book ${count} slots`),
  holdTitle: (count: number) => (count === 1 ? "Hold this court" : `Hold ${count} slots`),
  description: "Check the slots and the price, then book.",
  holdDescription: "A club hold charges nobody. The name you write shows on the grid.",
  steps: { slots: "Slots", players: "Players", split: "Split", confirm: "Confirm" },
  /** D3 — the compact slot summary on the steps that are not the slot list. */
  summaryLabel: "What you're booking",
  summaryMore: (n: number) => `and ${n} more`,
  stepOf: (index: number, total: number, name: string) => `Step ${index} of ${total}: ${name}`,

  bookAs: "Book as",
  asSelf: "Myself",
  asSelfHint: "Booked in your name, on your own wallet.",
  asMember: "A member",
  asMemberHint: "Charged to the member you choose.",
  asHold: "A club hold",
  asHoldHint: "Nobody is charged. The name you write shows on the grid.",
  /** The book-as combobox's name — who the booking is FOR, not the bare word "Member" (R1, F3). */
  memberLabel: "Member to book for",
  memberPlaceholder: "Choose a member",
  memberMissing: "Choose who this is for.",
  holdLabel: "Name on the grid",
  holdPlaceholder: "League night, maintenance…",
  holdMissing: "Write the name the grid should show.",

  slotsLabel: "Selected slots",
  total: "Total",
  free: "No charge",
  balanceNow: "Balance now",
  balanceAfter: "Balance after",
  theirBalanceNow: (name: string) => `${name}'s balance`,
  theirBalanceAfter: "After this booking",
  /**
   * F1.3/F1.4 — with anything held for or owed back to partners, the figures are what may be
   * SPENT, named so; the raw balance would disagree with the Done line and the god-mode notice.
   */
  availableNow: "Available now",
  availableAfter: "Available after",
  theirAvailableNow: (name: string) => `${name} can spend`,
  quoteReading: "Working out the price…",
  quoteAction: "work out the price",
  notBookable: "Can't be booked",
  noneBookable: "None of these slots can be booked right now.",
  someNotBookable: (n: number) =>
    `${countOf(n, "slot", "slots")} can't be booked and ${n === 1 ? "is" : "are"} left out.`,

  next: "Continue",
  back: "Back",
  cancel: "Cancel",
  done: "Done",
  retry: "Try again",
  topUp: "Top up",
  primary: (count: number, credits: number, forName: string | null) => {
    const what = count === 1 ? "Book" : `Book ${count} slots`;
    const who = forName ? ` for ${forName}` : "";
    return `${what}${who} · ${formatCredits(credits)}`;
  },
  /** While the quote is still being read — the price is not known yet, so it is not claimed. */
  primaryPending: (count: number) => (count === 1 ? "Book" : `Book ${count} slots`),
  /** The slot row's note on a hold: the name the grid will show. */
  holdNote: (label: string) => `“${label.trim()}”`,
  holdPrimary: (count: number) => (count === 1 ? "Hold the court" : `Hold ${count} slots`),

  /**
   * A member who is short (members never overdraw): what they need, never a red "Balance after
   * −30.00 cr" — a figure their wallet can never reach. The Book button stays, unavailable, and
   * names this as its reason.
   */
  needMore: (shortBy: number) => `You need ${formatCredits(shortBy)} more`,
  needMoreBody: "Top up, then book — a member's balance can't go below zero.",
  stillNeeded: "Still needed",
  bookedTitle: (booked: number, total: number) => {
    if (booked === total) return total === 1 ? "Court booked" : total === 2 ? "Both booked" : `All ${total} booked`;
    return `${booked} of ${total} booked`;
  },
  heldTitle: (held: number, total: number) => {
    if (held === total) return total === 1 ? "Court held" : total === 2 ? "Both held" : `All ${total} held`;
    return `${held} of ${total} held`;
  },
  noneBookedTitle: "Nothing was booked",
  balanceLine: (after: number, forName: string | null) =>
    forName ? `${forName}'s balance is now ${signedCredits(after)}.` : `Your balance is now ${signedCredits(after)}.`,
  /** The same concept as Confirm's "Available after" (F1.3) — what is left to SPEND. */
  availableLine: (after: number, forName: string | null) =>
    forName ? `${forName} now has ${signedCredits(after)} to spend.` : `You now have ${signedCredits(after)} to spend.`,
  /** F1.1 — the club's reply was lost; the outcome was read off the schedule. */
  provenNote: "The club's reply didn't arrive, so this was read off the schedule. Your wallet is being re-read.",
  confirmedFromSchedule: "On the schedule in this name.",
  notOnSchedule: "Not on the schedule — not booked.",
  haltedShort:
    "You ran out of credit part-way, so the rest weren't tried. Top up, then try again — "
    + "the ones already booked won't be charged twice.",
  you: "You",
  haltedShortAdmin: (name: string) =>
    `${name} ran out of credit part-way, so the rest weren't tried. `
    + "You can book the rest anyway — it's recorded in the change record.",
  bookRestAnyway: "Book the rest anyway",
  failedAction: "make that booking",
  fallback: "Couldn't make that booking. Try again in a moment.",
  /**
   * R4 I4-1 — while the club is answering, nothing leaves the sheet: a member who backed out of
   * a slow booking was charged with nothing on screen. Said beside the unavailable way out, and
   * said again when somebody tries the ×, Escape or Back.
   */
  sending: "Booking… waiting for the club's answer before this closes.",
  /**
   * R4 I4-2 — a double tap on Continue whose second half landed on Book: ignored, and said, so a
   * press never does nothing in silence.
   */
  doubleTapIgnored: "That was a double tap, so nothing was booked yet. Check the details, then tap Book.",
  /** An answer that arrived after the sheet had gone (a sign-out, a forced route) — a toast. */
  landedLate: (what: readonly string[]) =>
    `The booking went through: ${what.length === 1 ? what[0] : `${what.length} slots`}. It's on the schedule.`,
} as const;

/** R19's notice: who, where it leaves them, and that it is on the record. */
export const GOD_MODE = {
  title: "This goes below zero",
  body: (name: string | null, after: number) =>
    `This takes ${name ?? "you"} to ${signedCredits(after)}. It's recorded in the change record.`,
} as const;

/**
 * Per-item refusal codes, as they read in a list — a row, not a paragraph. A SINGLE booking's
 * refusal carries figures and goes through `describeBookingError` instead.
 */
export const REFUSAL_REASON: Record<string, string> = {
  court_not_found: "That court isn't on the schedule any more.",
  past_time: "That slot has already started.",
  too_far_ahead: "That day isn't open for booking yet.",
  slot_taken: "Someone else just took it.",
  insufficient_balance: "Not enough credit.",
  peak_hours_league_only: "Peak hours are for league members until closer to the time.",
  per_day_cap_exceeded: "That's all your court time for that day.",
  per_day_slot_cap_exceeded: "That's all your slots for that day.",
  group_window: "Outside the group's booking times.",
  crosses_midnight: "It would run past midnight.",
  no_bookable_window: "The groups' booking times leave no time that day.",
  out_of_hours: "The club is closed then.",
  no_time_available: "There's no free time on that court.",
  invalid_duration: "That length of booking isn't allowed.",
  duplicate_request: "Already booked.",
  not_attempted: "Not tried — the credit ran out first.",
  idempotency_key_reused: "That request was already used. Start again from the grid.",
  member_suspended: "The membership is suspended.",
  member_not_active: "The membership isn't active.",
  booking_not_found: "That booking is no longer there.",
  already_started: "It has already started.",
  already_cancelled: "Was already cancelled.",
};

export function refusalReason(code: string | null | undefined): string {
  if (code && code in REFUSAL_REASON) return REFUSAL_REASON[code];
  return "That one didn't go through.";
}

/** The status word on a result row; the sentence under it says why or what moved. */
export const RESULT_WORD = {
  booked: "Booked",
  held: "Held",
  replayed: "Already booked",
  cancelled: "Cancelled",
  refused: "Not booked",
  notCancelled: "Not cancelled",
} as const;

export const RESULTS_LABEL = { book: "What was booked", cancel: "What was cancelled" } as const;

export const CANCEL_SHEET = {
  title: (count: number) => (count === 1 ? "Cancel this booking?" : `Cancel ${count} bookings?`),
  description: (count: number) =>
    (count === 1 ? "Here's what goes back if you cancel now." : "Here's what goes back if you cancel them now."),
  keep: (count: number) => (count === 1 ? "Keep booking" : "Keep bookings"),
  /** R4 I4-1 — the cancel sheet's waiting line; see BOOK_SHEET.sending. */
  sending: "Cancelling… waiting for the club's answer before this closes.",
  /** A cancellation that finished after its sheet had gone. */
  landedLate: (count: number) =>
    (count === 1 ? "The booking was cancelled." : `${count} bookings were cancelled.`) + " The wallet shows what came back.",
  confirm: (count: number) => (count === 1 ? "Cancel booking" : `Cancel ${count} bookings`),
  done: "Done",
  retry: "Try again",
  quoteReading: "Working out what goes back…",
  quoteAction: "work out what cancelling costs",
  quoteFailed: "Couldn't work out what cancelling costs. You can still cancel — the club works it out — or try again.",
  quoteMissing: "Couldn't read this one's refund — the club still works it out when you cancel.",
  holdLine: "A club hold — no money moves.",

  paid: "Paid",
  penalty: (pct: number) => `Late-cancellation penalty (${pct}%)`,
  penaltyWaived: "Penalty waived",
  goesBack: (whose: string | null) => (whose ? `Back to ${whose}` : "Back to you"),
  totalBack: "Goes back in total",

  free: (whose: string | null) =>
    `Cancelling now is free — the full amount goes back to ${whose ? `${whose}'s` : "your"} credit.`,
  late: (pct: number) => `This is inside the late-cancellation window, so ${pct}% is kept as a penalty.`,
  checkedIn: (name: string | null) =>
    (name
      ? `${name} has already checked in and the lights have been on, so nothing is refunded.`
      : "You've already checked in and the lights have been on, so nothing is refunded."),
  nothingBack: "Nothing back — the lights had been on",
  finalLine: "Cancelling can't be undone. Booking again is a new booking at today's price.",

  waive: (penalty: number) => `Waive the ${formatCredits(penalty)} penalty`,
  waiveMany: "Waive the late-cancellation penalties",
  waiveHint: "Recorded against your name, with your reason.",
  reasonLabel: "Reason",
  reasonHint: "Required — the member is told why, and it goes on the club's change record.",
  reasonHintMany: "Required for a batch — it goes in the email each member gets.",
  reasonPlaceholder: "Court double-booked, injury, club decision…",
  reasonMissing: "Say why — the member is told the reason, and the club's records keep it.",

  cancelledTitle: (done: number, total: number) => {
    if (done === total) return total === 1 ? "Booking cancelled" : total === 2 ? "Both cancelled" : `All ${total} cancelled`;
    return `${done} of ${total} cancelled`;
  },
  noneCancelledTitle: "Nothing was cancelled",
  failedAction: "cancel that booking",
  fallback: "Couldn't cancel that booking. Try again in a moment.",
  /** F1.1 — cancelled (the schedule shows it gone) but the reply with the figures was lost. */
  provenRow: "Gone from the schedule — the refund shows on the wallet.",
  unsureStillThere: "The club didn't answer, and it's still on the schedule.",
  unsureRow: "The club didn't answer — check the schedule.",
} as const;

/** F1.13 — a split booking's row: the organiser's net, and what went on to the partners. */
export function splitRowOutcome(net: number, toPartners: number, penalty: number): string {
  const line = `${formatCredits(Math.max(net, 0))} back, ${formatCredits(toPartners)} to partners`;
  return penalty > 0 ? `${line}, ${formatCredits(penalty)} penalty kept` : line;
}

/** What a successful cancellation moved, per row. `refund` is GROSS, as the cancel routes answer it. */
export function cancelRowOutcome(refund: number, penalty: number): string {
  const back = refund - penalty;
  if (back <= 0 && penalty <= 0) return CANCEL_SHEET.nothingBack;
  const line = `${formatCredits(Math.max(back, 0))} back`;
  return penalty > 0 ? `${line}, ${formatCredits(penalty)} penalty kept` : line;
}

/* ═══════════════════════════════ REVIEW ROUND 1 ═══════════════════════════════ */

/** F1.6 — `/bookings?as=<member>`: whose booking this is, before the sheet says so. */
export const BOOKING_FOR = {
  label: "Booking for",
  region: (name: string) => `Booking for ${name}`,
  canSpend: (credits: number) => `can spend ${signedCredits(credits)}`,
  price: (credits: number, sliceMinutes: number) => `pays ${formatCredits(credits)} / ${sliceMinutes} min`,
  held: (credits: number) => `${formatCredits(credits)} held for or owed to partners`,
  gridNote: "The grid shows your prices and their group's hours; the sheet charges theirs.",
  reading: "Reading this member's details…",
  failed: "Couldn't read this member's details. The sheet still books for them and shows their figures.",
  retry: "Try again",
  stop: "Book for myself instead",
} as const;

/** F1.10 — the cancellation terms, on Confirm, before anything is charged. */
export function cancelTermsLine(penaltyPct: number, windowMinutes: number): string {
  if (penaltyPct <= 0 || windowMinutes <= 0) {
    return "Cancel any time before you check in and the full amount comes back. Once the lights have been on, nothing does.";
  }
  return `Cancel more than ${windowMinutes} min before the start and the full amount comes back; inside ${windowMinutes} min, ${penaltyPct}% is kept. Once the lights have been on, nothing comes back.`;
}

/**
 * F1.20 — the Done heading when the list under it has fewer rows than slots (adjacent slots on
 * one court are one booking): "All 3 booked" above two rows read as a slot lost.
 */
export function bookedInBookings(done: number, total: number, rows: number, held = false): string {
  const verb = held ? "held" : "booked";
  const inRows = `in ${rows} ${rows === 1 ? "booking" : "bookings"}`;
  return done === total ? `${total} slots ${verb} ${inRows}` : `${done} of ${total} slots ${verb} ${inRows}`;
}

/** F1.12 — the member's upcoming games, above the grid. */
export const UPCOMING = {
  title: "Your upcoming games",
  empty: "No games coming up. Pick a free slot below to book one.",
  failed: "Couldn't load your upcoming games.",
  retry: "Try again",
  organiser: "You booked",
  partner: "You're playing",
  needsAction: "Needs you",
  more: (n: number) => `Show ${n} more`,
  less: "Show fewer",
  share: (credits: number) => `Your share ${formatCredits(credits)}`,
  /** R3 M-3 — what the game has actually cost the member so far, not the share they would carry. */
  paid: (credits: number) => `You've paid ${formatCredits(credits)}`,
  /** R3 M-3 — a partner's share not yet paid. */
  owe: (credits: number) => `You owe ${formatCredits(credits)}`,
  /**
   * R3 M-3 — "Dean, Sam · 1 still to answer": the accepted players by first name, then the seats
   * asked but not taken (an invite, an open link), counted and never named as players. The space
   * before the dot does not break, so a wrap never starts a line with it (R3 V-9).
   */
  people: (names: readonly string[], waiting: number) => {
    const still = waiting ? `${waiting} still to answer` : "";
    if (names.length === 0) return still;
    return still ? `${names.join(", ")}\u00a0· ${still}` : names.join(", ");
  },
} as const;

/**
 * R2 F1-1 — games that have finished within the result window (contract C3), under the upcoming
 * ones: a finished game was reachable only from an email, so its result could not be recorded.
 */
export const RECENT = {
  title: "Recent games",
  failed: "Couldn't load your recent games.",
  retry: "Try again",
  record: "Record the result",
  recordFor: (court: string, when: string) => `Record the result of ${court}, ${when}`,
  confirm: "Confirm the result",
  confirmFor: (court: string, when: string) => `Confirm the result of ${court}, ${when}`,
  pending: "Waiting for a confirm",
  confirmed: "Result in",
  disputed: "Disputed",
  more: (n: number) => `Show ${n} more`,
  less: "Show fewer",
} as const;

/** R2 F1-1 — the viewer's own past booking on the grid opens its booking page (and its result). */
export function minePastOpenLabel(where: string, checkedIn: boolean | null): string {
  return `${minePastCellLabel(where, checkedIn)}. Open it`;
}

/** F1.12 — a partner's seat on the grid: theirs to open, never to cancel. */
export function partnerCellLabel(where: string): string {
  return `${where} — a game you're playing in. Open it`;
}

export const PARTNER_CELL_WORD = "Your game";

/**
 * F1.9 — the seats as partner and opponents, not "Team A / Team B": a singles opponent landed on
 * the member's own team because nothing said which side seat 2 was.
 */
export const BOOK_SEATS = {
  yourTeam: "Your side",
  otherTeam: "Opponents",
  partner: "Your partner",
  opponent: "Opponent",
  addPartner: "Add your partner",
  addOpponent: "Add an opponent",
  addToSeat: (seat: number) => (seat <= 2 ? "Add your partner — on your side" : `Add an opponent — seat ${seat}, the other side`),
  pickerTitle: (seat: number) => (seat <= 2 ? "Your partner" : `Opponent, seat ${seat}`),
  withOthersHint: "Add an opponent, a partner, or both — then split the cost between you.",
} as const;

/** F1.13 — a split booking's cancel: what each partner gets back, and what the organiser keeps. */
export const SPLIT_CANCEL = {
  partnerBack: (name: string) => `Back to ${name}`,
  youKeep: "You keep",
  note: "Partners get their shares back from what comes back to you.",
} as const;

/* ─────────────────────────────── end SHEETS ─────────────────────────────── */

/**
 * C4 — "25.00 cr until Fri 2 Oct, 06:45 · 35.00 cr until Sun 4 Oct, 10:30": held credit, one
 * part per share deadline, each with its own release (R2 F4-18 — one date for the whole amount
 * was right only for the first part). "held" leads, so it reads as the held line it replaces.
 */
export function heldPartsLine(parts: readonly { credits: number; until: string }[], timezone?: string): string {
  return `Held: ${parts.map((p) => `${formatCredits(p.credits)} until ${playersWhen(p.until, timezone)}`).join(" · ")}`;
}

/**
 * R5 A5-1 — lifting a club hold asks first, and asks why. One tap used to DELETE it with no
 * confirm and no reason, and the change record showed the lift with reason null. The reason is
 * required by the API (400 reason_required) and lands on the change record.
 */
export const LIFT_HOLD_SHEET = {
  title: "Lift this hold?",
  description: (where: string, label: string | null) =>
    `${where}${label ? ` — ${label}` : ""}. The court is free to book the moment it's lifted.`,
  reasonLabel: "Reason",
  reasonHint: "Required — it goes on the club's change record.",
  reasonPlaceholder: "League moved, court repaired, set by mistake…",
  reasonMissing: "Say why — the club's change record keeps the reason.",
  keep: "Keep hold",
  confirm: "Lift hold",
};
