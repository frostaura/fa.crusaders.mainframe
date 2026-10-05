import { INBOX_TITLE, PENDING_INVITE_NOTE } from "./bellCopy";
import { ApiError } from "./api";
import { clubCalendarDate } from "./clubClock";
import { describeFailure } from "./errors";
import { minutesSpoken } from "./minutes";
import { SOMEONE } from "./playersNames";
import { BUY_MINUTES_ACTION } from "./gridCopy";
import { unsureSentence, type UnsureWords } from "./lostReply";
import { LOST_REPLY, unsureWords } from "./lostReplyCopy";

/**
 * Every word the players feature says (P11, D11–D13): the BookSheet's Players and Split steps,
 * the booking's own page, invites and their accept sheet, the member inbox, the wallet's shares,
 * the privacy switches — and one sentence for every refusal the players routes can answer.
 *
 * <p>
 * One module for the reason `lib/bookingsCopy.ts` set: the same sentence is needed in a visible
 * label, an `aria-label` and a live region, and tests query by these constants rather than by a
 * copy of the words, so a wording change is one edit and never a red suite.
 * </p>
 *
 * <p>
 * <b>The voice.</b> Warm and plain, never gimmicky — this is money between friends. Nobody is
 * "owed" anything here and nobody is "in debt": a partner is <em>asked</em> for a share, the
 * organiser <em>covers</em> the court, and a share nobody paid simply lapses (D11 — no debts).
 * Celebration and play belong to P12.
 * </p>
 *
 * <p>
 * <b>Sections are owned.</b> Each block below belongs to one surface; edit only your own.
 * </p>
 */

/* ═══════════════════════════════════ SHARED ═══════════════════════════════════ */

export const PLAYERS_COPY = {
  you: "You",
  organiser: "Organiser",
  guest: "Guest",
  openSeat: "Open seat",
  teamA: "Team A",
  teamB: "Team B",
  /** A name the server could not give — a member who has left. */
  someone: SOMEONE,
} as const;

/** A seat's state, as a chip says it. Never colour alone — this word is always shown. */
export const STATUS_WORD: Record<string, string> = {
  organiser: "Organiser",
  invited: "Invited",
  accepted: "In",
  paid: "Paid",
  needs_consent: "Asked again",
  declined: "Declined",
  withdrawn: "Pulled out",
  removed: "Removed",
  lapsed: "Lapsed",
  settled_outside: "Settled by the club",
  guest: "Guest",
  open_link: "Waiting for someone",
  /** R1 F2.10 — on a cancelled game: who was on it, and an invite nobody can answer any more. */
  was_in: "Was in",
  invite_closed: "Invite closed",
  /** R1 F2.13 — in (the club accepted for them, or a zero share was raised) with no share agreed yet. */
  not_agreed: "In · share not agreed",
};

// Names and instants live in `playersNames` (first-load split, R7 P5-7); re-exported here.
export { firstName, listNames, playersWhen } from "./playersNames";
import { listNames, playersWhen } from "./playersNames";

/** "12 min held until Sat 27 Sep, 20:00" — wherever the balance is explained (§3a). */
export function heldLine(heldMinutes: number, until: string | null | undefined, timezone?: string): string {
  const amount = minutesSpoken(heldMinutes);
  return until ? `${amount} held until ${playersWhen(until, timezone)}` : `${amount} held`;
}

/** Why some of a balance is not spendable — the sentence under a held line. */
export const HELD_EXPLAINER =
  "Shares your partners paid you are held until 48 hours after each game, in case one comes back. They're yours — you just can't spend them yet.";

/**
 * P11 — "16 min owed back to partners — paid from the next minutes you buy". Owed back has no
 * date: it clears when minutes come in, so the line says that instead of an "until".
 */
export function owedBackLine(owedBackMinutes: number): string {
  return `${minutesSpoken(owedBackMinutes)} owed back to partners — paid from the next minutes you buy`;
}

/** Why a balance owes partners — the sentence under an owed-back line. */
export const OWED_BACK_EXPLAINER =
  "A partner's share came back to them after you'd already spent it, so their minutes are waiting on your balance. The next minutes you get go to them first, then to you.";

/** For an admin reading a quote: the same fact, about whoever pays. */
export function owedBackQuoteLine(owedBackMinutes: number, name: string | null): string {
  const who = name ?? "You";
  const owes = name ? "owes" : "owe";
  return `${who} ${owes} ${minutesSpoken(owedBackMinutes)} back to partners — that comes out of the next minutes first.`;
}

/* ═══════════════════════════════════ REFUSALS ═══════════════════════════════════ */

/**
 * The sentence for each stable code the players routes answer with. Figures that a sentence
 * needs are read off the refusal in {@link playersRefusal}; these are the plain ones.
 */
export const PLAYERS_REFUSAL: Record<string, string> = {
  booking_not_found: "That booking isn't there any more — it may have been cancelled, or you're no longer on it.",
  player_not_found: "That player isn't on this booking any more. The page has the latest.",
  invite_not_found: "This invite isn't for you, or it's no longer open. Ask whoever sent it for a fresh link.",
  booking_not_open: "This game can't change any more — it has finished, been cancelled, or its shares have closed.",
  booking_full: "This booking already has four players.",
  seat_taken: "That seat was taken a moment ago. Pick another.",
  already_in_booking: "You're already on this booking.",
  member_not_found: "That member isn't active at the club any more, so they can't be added.",
  membership_inactive: "Your membership isn't active, so you can't join a game right now. The club can help.",
  player_invalid: "Something about that player didn't add up. Try adding them again.",
  too_many_players: "A booking has at most four players — you and three others.",
  guest_name_invalid: "A guest needs a name of 1 to 64 characters.",
  invite_closed: "This invite has closed — the game was cancelled, or its shares are settled.",
  not_invited: "That seat isn't waiting for an answer any more.",
  nothing_to_nudge: "There's nothing to remind them about — they've answered and paid.",
  conflict_retry: "Someone else changed this booking at the same moment. The page has the latest — try again.",
  reason_required: "Give a reason — it goes on the club's record.",
  overdraft_not_authorised: "Collecting past a member's balance needs your explicit go-ahead.",
  nothing_to_collect: "There's nothing left to collect on that seat.",
  split_unknown_seat: "Add someone before you split the cost.",
  booking_payer_overridden: "Someone else paid for this booking at the court, so its players can't change here.",
  expected_share_required: "Something went wrong reading your share. Open the invite again.",
  player_previously_declined: "They already said no to this game, so it won't ask them again.",
  player_previously_removed: "That player was taken off this game, so they can't rejoin it from here.",
  player_not_accepted: "That player hasn't said yes yet, so there's no share to settle.",
  split_mode_invalid: "Choose Equal, Ratio or Amount.",
  split_weight_invalid: "Each ratio is a whole number from 0 to 100.",
  split_amount_invalid: "Each amount is a whole number of minutes, 0 or more.",
  split_exceeds_price: "The amounts you've asked for add up to more than the court costs.",
  split_needs_organiser: "Something went wrong with your own seat. Refresh and try again.",
  split_preview_invalid: "We couldn't work out that split. Check the figures.",
  split_pay_in_app: "This booking is split — each player pays their share in the app.",
  query_too_short: "Type at least two letters of their name.",
  cannot_favourite_self: "You can't star yourself.",
  notification_not_found: "That notification has gone.",
};

function numberDetail(e: ApiError, key: string): number | null {
  const value = e.detail(key);
  return typeof value === "number" ? value : null;
}

function capSentence(e: ApiError): string {
  const day = e.detail("club_day");
  // R4 X4-9 — the club day arrives as `YYYY-MM-DD`: said as "Wed 30 Sep", never printed raw.
  const when = typeof day === "string" ? ` on ${clubCalendarDate(day)}` : " that day";
  if (e.detail("cap") === "slots") {
    const cap = numberDetail(e, "cap_slots");
    return cap === null
      ? `Saying yes would take you past your daily limit${when}.`
      : `Saying yes would take you past your limit of ${cap} slots a day${when}.`;
  }
  if (e.detail("cap") === "minutes") {
    const cap = numberDetail(e, "cap_minutes");
    return cap === null
      ? `Saying yes would take you past your daily limit${when}.`
      : `Saying yes would take you past your limit of ${cap} minutes on court a day${when}.`;
  }
  return "Saying yes would take you past your daily limit on court.";
}

function withFigures(e: ApiError, timezone?: string): string | null {
  switch (e.code) {
    case "share_changed": {
      const share = numberDetail(e, "share_minutes");
      return share === null
        ? "Your share has changed since you opened this. Check the new figure and say yes again."
        : `Your share is now ${minutesSpoken(share)}. Check it and say yes again if you're happy.`;
    }
    case "insufficient_balance": {
      const have = numberDetail(e, "current_minutes");
      const need = numberDetail(e, "required_minutes");
      if (have === null || need === null) return "You don't have enough minutes to spend for this. Buy a package and try again.";
      return `You need ${minutesSpoken(need)} and have ${minutesSpoken(have)} to spend — ${minutesSpoken(Math.max(0, need - have))} short. Buy a package and try again.`;
    }
    case "partner_cap_exceeded": return capSentence(e);
    case "withdraw_window_closed": {
      const at = e.detail("closed_at");
      return typeof at === "string"
        ? `It's too close to the game to pull out — that closed at ${playersWhen(at, timezone)}. Talk to the organiser.`
        : "It's too close to the game to pull out. Talk to the organiser.";
    }
    case "nudge_limit": {
      const limit = numberDetail(e, "limit");
      const until = e.detail("retry_after");
      const count = limit === null ? "the most reminders" : `${limit} reminder${limit === 1 ? "" : "s"}`;
      return typeof until === "string"
        ? `You've sent ${count} today. You can remind them again after ${playersWhen(until, timezone)}.`
        : `You've sent ${count} today. Try again tomorrow.`;
    }
    case "player_invite_limit": {
      const limit = numberDetail(e, "limit");
      return limit === null
        ? "This booking has had as many invites as it can."
        : `A booking can send ${limit} invites in all, and this one has used them. Share an existing link instead.`;
    }
    case "directory_rate_limited": {
      const seconds = numberDetail(e, "retry_after_seconds");
      return seconds === null
        ? "That's a lot of searching — wait a moment and try again."
        : `That's a lot of searching — try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
    }
    default: return null;
  }
}

export type RefusalOptions = {
  /** What the member was doing, for a failure that is not a refusal: "accept the invite". */
  action?: string;
  /** The club's zone, for any time in the sentence. */
  timezone?: string;
  /** R3 — the words for a lost reply that was read back (`lib/lostReply`). */
  unsure?: UnsureWords;
};

/**
 * The one sentence for anything a players route answers with — a refusal with its figures, a
 * refusal we know by name, or a failure that is not a refusal at all (the connection, the
 * club's system), which `describeFailure` owns.
 */
export function playersRefusal(error: unknown, options: RefusalOptions = {}): string {
  const lost = options.unsure ? unsureSentence(error, options.unsure) : null;
  if (lost) return lost;
  if (error instanceof ApiError) {
    const figured = withFigures(error, options.timezone);
    if (figured) return figured;
    if (error.code && error.code in PLAYERS_REFUSAL) return PLAYERS_REFUSAL[error.code];
  }
  return describeFailure(error, { action: options.action });
}

/** The refusal's code, when it is one — for the screens that act on a particular refusal. */
export function refusalCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}

/* ═══════════════════════════════════ BOOK SHEET (Players · Split · Confirm) ═══════════════════════════════════ */
/* Owned by the BookSheet lane. */

/** The BookSheet's Players step: who is playing, as four seats in two teams. */
export const BOOK_PLAYERS = {
  label: "Who's playing",
  justMe: "Just me",
  justMeHint: "You book the court and pay for it, as always.",
  withOthers: "With other players",
  withOthersHint: "Add up to three players and split the cost between you.",
  seatsLabel: "Seats",
  addPlayer: "Add a player",
  addToSeat: (seat: number, team: string) => `Add a player to seat ${seat}, ${team}`,
  remove: (name: string) => `Remove ${name}`,
  youHint: "Books and pays for the court",
  memberHint: "Asked for a share",
  guestHint: "Guest · plays free",
  linkName: "Open seat",
  linkHint: "Anyone with the link can take it",
  pickerTitle: (seat: number, team: string) => `Seat ${seat}, ${team}`,
  pickerBack: "Back to the seats",
  full: "All four seats are taken.",
  guestShort: (name: string) => `${name} (guest)`,
} as const;

/** The player picker (panel and dialog). */
export const PICKER = {
  tabsLabel: "Find a player",
  dialogDescription: "Pick someone you play with, search the club, or add an open seat or a guest.",
  favourites: "Favourites",
  recent: "Recent",
  members: "Members",
  link: "Link",
  guest: "Guest",
  added: "Added",
  add: (name: string) => `Add ${name}`,
  /** The admin's god-mode act on a seat, and the admin's add. */
  admin: (name: string) => unsureWords(`${name}'s seat is as it was`, "that went through", "the booking"),
  adminAdd: unsureWords("no new player is on the booking", "the player was added", "the booking"),
  /** A privacy switch whose reply was lost and whose read-back failed too. */
  privacy: (label: string) => `The club didn't answer and we couldn't check either, so we can't tell whether "${label}" changed. Refresh the page to see.`,
  star: (name: string) => `Star ${name}`,
  unstar: (name: string) => `Unstar ${name}`,
  starFailed: (name: string) => `Couldn't change the star on ${name}. Try again.`,
  favouritesAction: "read your favourites",
  favouritesEmpty: "No favourites yet",
  favouritesEmptyHint: "Star the people you play with most, from Recent or Members, and they'll wait for you here.",
  recentAction: "read who you've played with",
  recentEmpty: "Nobody yet",
  recentEmptyHint: "Players you've been on a court with in the last few months show up here.",
  played: (games: number) => (games === 1 ? "Played once" : `Played ${games} times`),
  lastPlayed: (when: string) => `last on ${when}`,
  searchLabel: "Search members",
  searchPlaceholder: "Their name",
  searchHint: "Type at least two letters of their name.",
  searchAction: "search the members",
  searchReading: "Searching…",
  searchEmpty: "No one found",
  /** The polite live region's words once a search has answered (a11y): a count, or no one. */
  searchFound: (count: number) => (count === 1 ? "1 member found" : `${count} members found`),
  searchNoneFound: "No one found.",
  searchEmptyHint:
    "Only members who've chosen to be findable appear here. Anyone else can join through a share link.",
  linkTitle: "An open seat",
  linkBody: "Anyone with the link can take this seat.",
  linkAfter: "You'll get the link to share once the seat is added — send it on WhatsApp or anywhere else.",
  linkAdd: "Add an open seat",
  guestLabel: "Guest's name",
  guestHint: "Guests pay nothing in the app — you're covering them.",
  guestAdd: "Add guest",
  guestMax: 64,
} as const;

/** The Split step and its live totals bar. */
export const BOOK_SPLIT = {
  modeLabel: "How to split",
  modes: { equal: "Equal", ratio: "Ratio", amount: "Amount" },
  modeHint: {
    equal: "Everyone who pays gets the same share in whole minutes. You take any odd minute.",
    ratio: "Give each player a weight from 0 to 100 — shares follow the weights, in whole minutes. You take any odd minute.",
    amount: "Ask each player for a number of minutes. You cover whatever is left.",
  },
  weightLabel: (name: string) => `Weight for ${name}`,
  amountLabel: (name: string) => `Minutes for ${name}`,
  theRest: "The rest",
  playsFree: "Plays free",
  sharesLabel: "Shares",
  totalsLabel: "What each player is asked for",
  eachBooking: "Each booking",
  /** R12 J12-2 — "Each 15-minute booking": a length as an adjective, never "Each 15 minutes booking". */
  perPrice: (minutes: number) => `Each ${lengthBooking(minutes, 1)}`,
  youPayNow: (now: string, back: string) => `You pay ${now} now · you get ${back} back as they accept`,
  addsUp: (price: string) => `Adds up to ${price}`,
  reading: "Working out the shares…",
  previewAction: "work out the shares",
} as const;

/**
 * R12 J12-2 — a booking named by its length: "15-minute booking", "1-hour bookings", or the long
 * way ("booking of 1 hour 30 minutes") for a length that is neither — `sliceLengthLine`'s rule.
 */
function lengthBooking(minutes: number, count: number): string {
  const noun = count === 1 ? "booking" : "bookings";
  const n = Math.trunc(minutes);
  if (n > 0 && n < 60) return `${n}-minute ${noun}`;
  if (n > 0 && n % 60 === 0 && n < 24 * 60) return `${n / 60}-hour ${noun}`;
  return `${noun} of ${minutesSpoken(n)}`;
}

/**
 * Which bookings a Confirm sentence is about: one booking ("You pay"), every booking of a batch of
 * one length ("On each booking you pay"), or — lengths mixed (J12-2) — the ones of this length,
 * counted, so two sentences never state two figures for "each booking".
 */
export type SentenceScope = boolean | { count: number };

function sentenceLead(price: number, scope: SentenceScope): string {
  if (scope === false) return "You";
  if (scope === true) return "On each booking you";
  return scope.count === 1
    ? `On the ${lengthBooking(price, 1)} you`
    : `On each of the ${scope.count} ${lengthBooking(price, scope.count)} you`;
}

/** "whoever takes your link", or "the 2 people who take your links". */
function linkTakers(count: number): string {
  return count === 1 ? "whoever takes your link" : `the ${count} people who take your links`;
}

export type SentenceSeat = { kind: "member" | "link" | "guest"; name: string; share: number };

function askClause(paying: readonly SentenceSeat[]): string {
  const members = paying.filter((s) => s.kind === "member");
  const links = paying.filter((s) => s.kind === "link");
  const same = paying.every((s) => s.share === paying[0].share);
  if (same) {
    const who = listNames([...members.map((s) => s.name), ...(links.length ? [linkTakers(links.length)] : [])]);
    const plural = members.length + links.length > 1;
    return `${who} ${plural ? "are" : "is"} asked for ${minutesSpoken(paying[0].share)}${plural ? " each" : ""}`;
  }
  const parts = paying.map((s, i) => {
    const who = s.kind === "link" ? linkTakers(1) : s.name;
    return i === 0 ? `${who} is asked for ${minutesSpoken(s.share)}` : `${who} for ${minutesSpoken(s.share)}`;
  });
  return listNames(parts);
}

/**
 * The Confirm step's one sentence: "You pay 1 h 30 min now; Sam and Alex are asked for 22 min
 * each. Jo (guest) plays free." `price` is what the organiser is charged now (the whole court).
 */
export function confirmPlayersSentence(price: number, seats: readonly SentenceSeat[], scope: SentenceScope = false): string {
  const lead = `${sentenceLead(price, scope)} pay ${minutesSpoken(price)} now`;
  const paying = seats.filter((s) => s.kind !== "guest");
  const guests = seats.filter((s) => s.kind === "guest").map((s) => BOOK_PLAYERS.guestShort(s.name));
  const ask = paying.length ? `; ${askClause(paying)}` : "";
  const free = guests.length ? ` ${listNames(guests)} ${guests.length > 1 ? "play" : "plays"} free.` : "";
  return `${lead}${ask}.${free}`;
}

/** The Confirm step and the result's players outcome. */
export const BOOK_CONFIRM = {
  playersLabel: "Players",
  /** R7 J7-7 — "You and Pam", "You, Sam and Alex": one list, so the last name gets its "and". */
  playersLine: (names: readonly string[]) => listNames(["You", ...names]),
  /** An open seat, as the players line names it mid-sentence. */
  linkInLine: "an open seat",
  shareLink: "Share the invite link",
  shareLinkFor: (seat: number) => `Share the invite link for seat ${seat}`,
  shareTitle: "Join my squash game",
  shareText: (when: string, court: string) => `${court}, ${when} — there's a seat for you. Tap to join.`,
  linkCopied: "Link copied",
  copyFailed: (url: string) => `Couldn't share it from here. Copy this link: ${url}`,
  seeBooking: "See the booking",
  playersError: "Your court is booked, but the players weren't added — add them from the booking's page.",
  linksNote: "Each open seat has its own link. Share it now — it's shown only once, and you can make a new one from the booking's page.",
} as const;

/* ═══════════════════════════════════ BOOKING DETAIL ═══════════════════════════════════ */
/* Owned by the booking-detail lane. */

/** The booking's own page, `/bookings/:bookingId` — what every viewer reads. */
export const DETAIL_COPY = {
  title: "Booking",
  /** R7 E7-5 — the header line for a member who paid for this court at the box (read-only). */
  payerLine: "You paid for this court at the box.",
  /** R4 form factor — the docked bar that holds the organiser's one verb on a phone. */
  actionsLabel: "Booking actions",
  /** R5 F5 — the invitee's answer docked above the tab bar on a phone. */
  answerLabel: "Your answer",
  /** R4 form factor — from a panel showing the booking inside another page (the Inbox). */
  openPage: "Open the booking",
  back: "Bookings",
  backToBookings: "Back to Bookings",
  readAction: "read this booking",
  refresh: "Refresh this booking",
  notFoundTitle: "Booking not found",
  refreshFailed: "Couldn't refresh this booking — this is what we last read.",
  organisedByYou: "You organised this game",
  /** R9 J9-5 — the desk booked it on the member's behalf: not something they did. */
  bookedForYou: "The club booked this for you",
  organisedBy: (name: string) => `Organised by ${name}`,
  statusLine: { booked: "", cancelled: "Cancelled", no_show: "Nobody checked in", completed: "Played", blocked: "Club hold" } as Record<string, string>,
  when: (court: string, when: string, end: string) => `${court} · ${when}–${end}`,
  someCourt: "Court",
  playersTitle: "Players",
  playersDescription: "Up to four players — two a side.",
  teamA: "Team A",
  teamB: "Team B",
  you: (name: string) => `${name} (you)`,
  checkedIn: "Checked in",
  notCheckedIn: "Not checked in",
  formerTitle: "No longer playing",
  formerDescription: "Only you can see these.",
  seatLabel: (name: string, word: string) => `${name}, ${word}`,
  freeSeat: "Free seat",
  freeSeatHint: "Nobody here yet",
  seatNumber: (n: number) => `Seat ${n}`,
} as const;

/** What a removed seat had paid, and the share the organiser absorbs once it is gone (R7 J7-9). */
export type RemoveMoney = { paid: number; share: number };

/**
 * R15 J15-11 — the verb agrees with the amount: "20 minutes go back", "1 minute goes back" (an
 * amount spoken by `minutesSpoken`; "1 hour" and "1 day" are one thing too).
 */
function agrees(amount: string, one: string, many: string): string {
  return /^1 (minute|hour|day)$/.test(amount) ? one : many;
}

function removeMoneySentence(lead: string, { paid, share }: RemoveMoney, who: { from: string; whose: string }): string {
  const midWhose = who.whose === "Your" ? "your" : who.whose;
  if (paid <= 0 && share <= 0) return `${lead}. Nothing was paid and ${midWhose} cost does not change.`;
  const back = paid > 0
    ? `${lead} and the ${minutesSpoken(paid)} they paid ${agrees(minutesSpoken(paid), "goes", "go")} back to them from ${who.from}.`
    : `${lead}. They haven't paid anything, so nothing goes back.`;
  return share > 0 ? `${back} ${who.whose} cost for the court goes up by ${minutesSpoken(share)}.` : back;
}

/** The organiser's hand on the page: invite, remind, share a seat's link, remove. */
export const DETAIL_ACTIONS = {
  invite: "Invite a player",
  inviteTitle: "Invite a player",
  inviting: "Adding them…",
  invited: (name: string) => `${name} is invited. They'll get a notification.`,
  guestAdded: (name: string) => `${name} is on the booking as your guest.`,
  openSeatAdded: "An open seat is ready. Share its link with whoever's playing.",
  inviteAction: "add that player",
  nudge: "Remind",
  nudgeFor: (name: string) => `Remind ${name}`,
  nudged: (name: string, left: number) =>
    left > 0
      ? `Reminder sent to ${name}. You can remind them ${left} more time${left === 1 ? "" : "s"} today.`
      : `Reminder sent to ${name}. That's the last reminder for today.`,
  nudgeAction: "send the reminder",
  link: "Share link",
  linkFor: (name: string) => `Share a link for ${name}`,
  remove: "Remove",
  removeFor: (name: string) => `Remove ${name}`,
  removeTitle: (name: string) => `Remove ${name}?`,
  removeBody: (name: string) => `${name} comes off this game. They're refunded anything they paid.`,
  /**
   * R7 J7-9 — the confirm says what the remove does to money: what goes back to them, from whose
   * balance, and that the organiser absorbs their share (a remove never re-splits, players spec).
   */
  removeBodyFor: (name: string, money: RemoveMoney) =>
    removeMoneySentence(`${name} comes off this game`, money, { from: "your balance", whose: "Your" }),
  removeOpenTitle: "Remove this open seat?",
  removeOpenBody: "Its link stops working and the seat is free again.",
  removeConfirm: "Remove",
  removeKeep: "Keep them",
  removed: (name: string) => `${name} is off this game.`,
  removeAction: "remove that player",
  /** R5 I5-2 — said in place of "Keep them" while the remove is on its way, and again on each refused way out. */
  removeSending: "Taking them off — waiting for the club. This stays open until it answers.",
  openSeatName: "Open seat",
  /** The seat an add was making, in the middle of a sentence (a lost reply). */
  newOpenSeat: "the new open seat",
} as const;

/** R1 F2.1 — the organiser changing the split of a booking that already stands. */
export const CHANGE_SPLIT = {
  open: "Change split",
  title: "Change the split",
  description: "Anyone whose share goes up is asked again before anything more is taken. A share that goes down comes back to them.",
  save: "Save the split",
  cancel: "Cancel",
  done: "The split is changed.",
  doneAskedAgain: "The split is changed. Anyone whose share went up has been asked again.",
  /** R14 J14-9 — seats the club accepted without asking agreed to nothing: asked, not "again". */
  doneAskedFirst: "The split is changed. Anyone who hasn't agreed a share yet has been asked for theirs.",
  doneAskedBoth: "The split is changed. Anyone whose share went up has been asked again, and anyone who hasn't "
    + "agreed a share yet has been asked for theirs.",
  action: "change the split",
  /** R5 I5-2 — said in place of Cancel while the save is on its way, and again on each refused way out. */
  sending: "Saving the split — waiting for the club. This stays open until it answers.",
  /** R2 F2-3 — what saving does to a booking that already stands: money that moves, not booking-time words. */
  effectsTitle: "What saving does",
  askedFor: (name: string, amount: string) => `${name} is asked for ${amount}.`,
  askedMore: (name: string, amount: string, consent: boolean) =>
    consent ? `${name} is asked for ${amount} more — once they say yes to it.` : `${name} is asked for ${amount} more.`,
  goesBack: (name: string, amount: string) => `${amount} ${agrees(amount, "goes", "go")} back to ${name}.`,
  youCover: (amount: string) => `You cover ${amount} in the end.`,
  noChange: "Nobody's share changes.",
} as const;

/** R1 F2.1 — a player added to an amount or ratio split is asked for a share the organiser names. */
export const SHARE_ASK = {
  title: (who: string) => `What should ${who} pay?`,
  amountBody: (covered: string) => `You cover ${covered} now. What you ask for comes off that.`,
  ratioBody: "Shares follow the weights. Give them a weight from 0 to 100.",
  amountLabel: (who: string) => `Minutes for ${who}`,
  weightLabel: (who: string) => `Weight for ${who}`,
  amountHint: "In whole minutes. 0 means you cover them.",
  weightHint: "A whole number from 0 to 100.",
  confirm: (who: string) => `Invite ${who}`,
  cancel: "Cancel",
} as const;

/** Sharing a seat's link — rotating makes a new one and the old one stops. */
export const SHARE_LINK = {
  confirmTitle: (name: string) => `A new link for ${name}`,
  confirmBody: "This makes a new link; the old one stops working. Anyone with the new link can take this seat.",
  make: "Make a new link",
  making: "Making the link…",
  keep: "Cancel",
  readyTitle: "Share this link",
  readyBody: "Send it on WhatsApp or anywhere else. It works once, for one player.",
  newLinkNote: "A new link — any older link for this seat has stopped working.",
  share: "Share link",
  copy: "Copy link",
  copied: "Link copied",
  copyFailed: "Couldn't copy it — press and hold the link above to copy it yourself.",
  done: "Done",
  linkLabel: "Invite link",
  shareTitle: "Join my squash game",
  shareText: (when: string) => `Squash on ${when} — tap to join and see your share.`,
  makeAction: "make a new link",
} as const;

/**
 * R3 I-2/I-3 and the lost-reply audit — a players write whose reply was lost, after the club's
 * record was read back: still as it was (nothing changed), or unreadable. A write that DID land
 * is said with its own sentence and {@link PLAYERS_LOST}. Writes with nothing to read back
 * (a reminder, a new link) say plainly that the outcome is not known.
 */
export const PLAYERS_UNSURE = {
  remove: (name: string) => unsureWords(`${name} is still on this game`, `${name} came off this game`),
  add: (name: string) => unsureWords(`${name} isn't on this game yet`, `${name} was added`),
  split: unsureWords("the split is as it was", "the split was changed"),
  withdraw: unsureWords("you're still on this game", "you're off this game"),
  decline: unsureWords("you're still invited", "your answer went through"),
  nudge: (name: string) =>
    `The club didn't answer, so we can't tell whether the reminder reached ${name}. Give it a few minutes before reminding them again — they may already have it.`,
  link: "The club didn't answer, so we can't tell whether a new link was made — if it was, the old link has stopped working. Make a new link to get one you can share.",
  /** The admin's god-mode act on a seat, and the admin's add. */
  admin: (name: string) => unsureWords(`${name}'s seat is as it was`, "that went through", "the booking"),
  adminAdd: unsureWords("no new player is on the booking", "the player was added", "the booking"),
  /** A privacy switch whose reply was lost and whose read-back failed too. */
  privacy: (label: string) => `The club didn't answer and we couldn't check either, so we can't tell whether "${label}" changed. Refresh the page to see.`,
  star: (name: string) =>
    `The club didn't answer, so we can't tell whether the star on ${name} changed. Close this and open it again to see.`,
} as const;

/** A players write that landed although its reply was lost: its own sentence, and that we checked. */
export const PLAYERS_LOST = LOST_REPLY.proven;

/** The money panel. Nobody is in debt: a share is asked for, and an unpaid one lapses. */
export const DETAIL_MONEY = {
  title: "Money",
  price: "Court price",
  organiserPaid: (who: string | null) => (who ? `${who} paid at booking` : "You paid at booking"),
  received: "Shares received",
  stillToCome: "Shares not paid yet",
  net: (who: string | null) => (who ? `${who}'s cost` : "Your cost"),
  deadline: (when: string) => `Shares close ${when}`,
  heldNote: "Shares you receive are held until shares close, in case one comes back.",
  perPlayerTitle: "Who's paid",
  paidRow: (paid: string, share: string) => `Paid ${paid} of ${share}`,
  unpaidRow: (share: string) => `Not paid yet · ${share}`,
  invitedRow: (share: string) => `Asked for ${share}`,
  askedAgainRow: (share: string, consented: string) => `Asked again: ${share} (said yes to ${consented})`,
  /** R1 F2.13 — nothing was ever agreed (accepted by the club): no "said yes to 0 min". */
  notAgreedRow: (share: string) => `Share of ${share} not agreed — nothing collected`,
  settledRow: "Settled with the club",
  coversRow: "Covers the court",
  guestRow: "Guest · no share",
  lapsedRow: "Share lapsed",
  unpaidSentence: (name: string, when: string, toWhom: string) =>
    `${name} hasn't paid yet — their share lapses to ${toWhom} if unpaid by ${when}.`,
  /** R2 F2-3 — a share raised after they paid part of it: never "hasn't paid yet". */
  askedMoreRow: (paid: string, more: string) => `Paid ${paid} · asked for ${more} more`,
  askedMoreSentence: (name: string, paid: string, more: string, when: string, toWhom: string) =>
    `${name} has paid ${paid} and is asked for ${more} more — if it isn't paid by ${when}, that part lapses to ${toWhom}.`,
  goingBackRow: (paid: string, back: string) => `Paid ${paid} · ${back} going back`,
  toYou: "you",
  /** R6 E6-2 (D10) — somebody else took the charge over at the court box; the booker was refunded. */
  refundedAtBox: (who: string | null) => (who ? `Refunded to ${who}` : "Refunded to you"),
  paidAtBoxNote: (payer: string | null, who: string | null, amount: string) =>
    `${payer ?? "Another member"} paid for this court at the court box, so ${who ? `${who} was` : "you were"} refunded ${amount}.`,
  /** R8 E8-2 — the same note to the member who paid at the box: about themselves, in the second person. */
  paidAtBoxNoteSelf: (who: string | null, amount: string) =>
    `You paid for this court at the court box, so ${who ?? "the organiser"} was refunded ${amount}.`,
  notSplit: "This court isn't split — the organiser covers it all.",
} as const;

/**
 * R1 F2.10 — a cancelled booking says only what is true: it was cancelled, who was on it, and
 * where the money went. No deadline, no "not paid yet", no "all paid up", no result to record.
 */
export const DETAIL_CANCELLED = {
  /** An older server, which says nothing of who cancelled. */
  banner: "This game was cancelled.",
  /** R13 J13-6 (contract C13-1) — who cancelled it, and why. */
  byClub: "The club cancelled this game.",
  byYou: "You cancelled this game.",
  byOrganiser: (name: string) => `${name} cancelled this game.`,
  /** The admin's own recorded words, as the member's mail says them. */
  reason: (reason: string) => `Reason: ${reason}`,
  displaced: "The club cancelled this game and refunded it — the court was still in use by an earlier booking.",
  playersDescription: "Who was on the game when it was cancelled.",
  moneyNote: "The booking was cancelled — this is where the money went.",
  refunded: (who: string | null) => (who ? `Refunded to ${who}` : "Refunded to you"),
  kept: (who: string | null) => (who ? `${who} paid in the end` : "You paid in the end"),
  nothingToPay: "Nothing owed · any share paid went back",
  /**
   * R2 F2-4 — on a SPLIT booking the gross refund to the organiser is not what they kept: the
   * partners' shares went back to the partners out of it. Never "Refunded to you 50 min" beside a
   * cancel sheet that said "You keep 15 min".
   */
  splitRefundNote: (who: string | null, partners: readonly string[] = []) =>
    `${who ?? "You"} got back what ${who ? "they" : "you"} paid for the court, less ${sharesPaid(who, partners)}.`,
  paidRow: (paid: string) => `Paid ${paid}`,
  /** R2 F2-4 — a partner's share that went back when the game was cancelled: "25 min back". */
  returnedRow: (returned: string) => `${returned} back`,
  partnerNothing: "The game was cancelled, so there's nothing for you to pay — any share you'd paid went back to you.",
  partnerPaid: (paid: string) => `The game was cancelled after check-in, so the ${paid} you paid stands.`,
  /**
   * R5 M5-7 — a late cancellation says its penalty on the booking as the sheet did, as the ledger's
   * own two rows: the refund in full, then the penalty kept from it.
   */
  penalty: "Late-cancellation penalty",
  splitRefundPenaltyNote: (who: string | null, penalty: string, partners: readonly string[] = []) =>
    `${who ?? "You"} got back what ${who ? "they" : "you"} paid for the court less the ${penalty} late-cancellation penalty, and less ${sharesPaid(who, partners)}.`,
} as const;

/**
 * R14 J14-7 / R15 — the shares that went back out of a split's refund, by name: "the share Sam had
 * paid you — that went straight back to Sam"; two or more, "the shares Sam and Alex had paid you —
 * those went straight back to them". No names on the wire (an older server): the plural said
 * generally, as before.
 */
function sharesPaid(who: string | null, partners: readonly string[]): string {
  const you = who ? "them" : "you";
  if (partners.length === 1) return `the share ${partners[0]} had paid ${you} — that went straight back to ${partners[0]}`;
  if (partners.length > 1) return `the shares ${listNames(partners)} had paid ${you} — those went straight back to them`;
  return who
    ? "the shares partners had paid them — those went straight back to the partners"
    : "the shares your partners had paid you — those went straight back to them";
}

/**
 * R5 M5-8 — the booking page for a member who is no longer on the game (the API's 404), when the
 * link that opened it named their seat ("You were taken off Court 4…"): what became of them, read
 * off their own seat, instead of "Booking not found".
 */
export const DETAIL_GONE = {
  removedTitle: "You were taken off this game",
  /**
   * R15 J15-1 — said as its actor's act: "club" is the club's, "organiser" names the organiser;
   * null (no record — a removal before R14 — or an older API) names nobody, never the organiser.
   */
  removedBody: (organiser: string, game: string, by: "club" | "organiser" | null = null) => {
    const refunded = "Anything you'd paid for it is refunded — your wallet shows it.";
    if (by === null) return `You were taken off ${game}. ${refunded}`;
    return `${by === "club" ? "The club" : organiser} took you off ${game}. ${refunded}`;
  },
  leftTitle: "You're no longer on this game",
  declinedBody: (game: string) => `You declined ${game}.`,
  withdrawnBody: (game: string) => `You pulled out of ${game}. Anything you'd paid for it is refunded — your wallet shows it.`,
  lapsedBody: (game: string) => `Your invite to ${game} lapsed.`,
  /** "Court 4, Thu 1 Oct, 18:00" — the game as the sentence names it. */
  game: (court: string, when: string) => `${court}, ${when}`,
  someone: "The organiser",
  wallet: "Open your wallet",
} as const;

/**
 * R5 M5-3 — a game nobody checked in on (a no-show): the court was refunded and the club kept the
 * no-show penalty from it; each partner's share came down with it. Said as the ledger's rows: what
 * was paid at booking, the refund, the penalty — never "paid at booking 15 min" for a 50 min court.
 */
export const DETAIL_NO_SHOW = {
  moneyNote: (split: boolean) => split
    ? "Nobody checked in, so the court was refunded less the no-show penalty — and partners' shares came down with it."
    : "Nobody checked in, so the court was refunded less the no-show penalty.",
  moneyNoteFree: "Nobody checked in. The court was refunded in full, with no penalty.",
  /** R6 E6-6 — the sweep refunded in full because no box was reachable: not held against anyone. */
  outageNote: "The court's box couldn't be reached, so this booking was refunded in full. It doesn't count as a no-show.",
  refunded: (who: string | null) => (who ? `Refunded to ${who}` : "Refunded to you"),
  penalty: "No-show penalty",
  /** A partner's row: everything they paid in, and what came back after the no-show. */
  paidBackRow: (paid: string, back: string) => `Paid ${paid} · ${back} came back`,
  paidRow: (paid: string) => `Paid ${paid}`,
  nothingRow: "Nothing paid",
  /** The viewer's own share on a no-show. */
  partnerBack: (paid: string, back: string, net: string) =>
    `Nobody checked in. You paid ${paid} and ${back} came back to you — ${net} in the end.`,
  partnerPaid: (paid: string) => `Nobody checked in. You paid ${paid}.`,
  partnerNothing: "Nobody checked in, and there's nothing for you to pay.",
  attendance: "Nobody checked in.",
} as const;

/** A player's own share and their hand: withdraw, decline, review. */
export const DETAIL_PLAYER = {
  title: "Your share",
  share: "Your share",
  paid: "You've paid",
  toPay: "Still to pay",
  paidAll: "You're all paid up.",
  askedAgain: (share: string) => `Your share went up to ${share}. Review it to say yes again.`,
  /** R14 J14-9 — the club accepted the seat without asking and nothing was ever agreed: not "went up". */
  askedFirst: (share: string) => `The club has asked you for ${share} — review it to say yes.`,
  review: "Review your share",
  withdraw: "Pull out",
  withdrawUntil: (when: string) => `You can pull out until ${when}.`,
  withdrawClosed: (when: string) => `Pulling out closed at ${when}. Talk to the organiser.`,
  withdrawTitle: "Pull out of this game?",
  /** R12 X12-4 — the figure that comes back, not "anything you paid". */
  withdrawBody: (paid: number) => (paid > 0
    ? `You come off the booking and the ${minutesSpoken(paid)} you paid come back to you.`
    : "You come off the booking. You haven't paid anything, so nothing moves."),
  withdrawConfirm: "Pull out",
  withdrawKeep: "Stay in",
  withdrawn: (paid: number) => (paid > 0 ? `You've pulled out. ${minutesSpoken(paid)} came back to you.` : "You've pulled out."),
  withdrawAction: "pull out",
  decline: "Decline",
  declineTitle: "Say no to this game?",
  declineBody: "The organiser is told, and you won't be asked to this game again.",
  declineConfirm: "Decline",
  declineKeep: "Cancel",
  declined: "You've said no to this game.",
  declineAction: "decline the invite",
} as const;

/** Attendance at the court. */
export const DETAIL_ATTENDANCE = {
  title: "At the court",
  checkedInAt: (clock: string) => `Checked in at ${clock}`,
  /** R9 E9-7 — the court went dark before the end it was sold to. */
  lightsOffAt: (clock: string) => `Lights off at ${clock}`,
  notYet: "Nobody has checked in yet.",
  count: (n: number, of: number) => `${n} of ${of} player${of === 1 ? "" : "s"} checked in`,
} as const;

/** The organiser cancelling — the grid's own CancelSheet, with the partners' side said first. */
export const DETAIL_CANCEL = {
  title: "Cancel this booking",
  /**
   * R14 J14-7 — each partner named, one share for one partner: "Sam gets back what they paid for
   * their share." / "Sam and Alex get back … their shares." Empty when no member holds a seat.
   */
  partnersBack: (names: readonly string[]) => {
    if (names.length === 0) return "";
    return names.length === 1
      ? `${names[0]} gets back what they paid for their share.`
      : `${listNames(names)} get back what they paid for their shares.`;
  },
  penaltyYours: "Any late-cancellation penalty is yours alone — it isn't split.",
  open: "Cancel booking",
  cancelled: "The booking is cancelled.",
} as const;

/** "Their 16 min is waiting on Naledi's balance and goes back as soon as it's covered." */
function returnWaiting(amount: string | null, organiser: string): string {
  const what = amount ? `Their ${amount} is` : "What they paid is";
  return `${what} waiting on ${organiser}'s balance and goes back as soon as it's covered.`;
}

/** The admin's god mode over a booking's seats. Every one is on the change log. */
export const DETAIL_ADMIN = {
  title: "Admin",
  description: "Act on any seat as the club. Everything here needs a reason and lands in the change log.",
  menu: (name: string) => `Admin actions for ${name}`,
  changeLog: "This lands in the club's change log.",
  reasonLabel: "Reason",
  reasonHint: "Goes on the club's record.",
  reasonPlaceholder: "e.g. Paid cash at the desk",
  reasonMissing: "Give a reason — it goes on the club's record.",
  cancel: "Cancel",
  add: "Add a player",
  addTitle: "Add a player as the club",
  addDescription: "A member (invited, or placed without asking), a guest, or an open link seat.",
  addKind: "Who",
  addMember: "A member",
  addMemberHint: "Invited, unless you place them now.",
  addGuest: "A guest",
  addGuestHint: "Named, no share, no app.",
  addLink: "An open seat",
  addLinkHint: "A link anyone can claim.",
  /** The member combobox's own name (R1, from F3) — "Member" alone named nothing it was for. */
  memberLabel: "Member to add",
  memberPlaceholder: "Choose a member",
  memberMissing: "Choose a member.",
  membersFailed: "Couldn't read the members list.",
  guestLabel: "Guest's name",
  guestMissing: "Give the guest a name.",
  placeAccepted: "Place them as in, without asking",
  placeAcceptedHint: "They're on the game at once. Nothing is collected — there's no consent.",
  addConfirm: "Add player",
  added: "Player added.",
  addAction: "add the player",
  remove: "Remove",
  removeTitle: (name: string) => `Remove ${name} as the club?`,
  removeBody: "They come off the game and anything they paid goes back to them.",
  /** R7 J7-9 — the club's confirm, with the money: the refund and the organiser's cost, by name. */
  removeBodyFor: ({ organiser, ...money }: RemoveMoney & { organiser: string }) =>
    removeMoneySentence("They come off the game", money, { from: `${organiser}'s balance`, whose: `${organiser}'s` }),
  removeConfirm: "Remove player",
  removed: (name: string) => `${name} is off this game.`,
  accept: "Accept for them",
  acceptTitle: (name: string) => `Accept for ${name}?`,
  acceptBody: "They're on the game. No consent is recorded, so nothing is collected from them.",
  acceptConfirm: "Accept for them",
  accepted: (name: string) => `${name} is in — accepted by the club.`,
  settle: "Settled outside the app",
  settleTitle: (name: string) => `Mark ${name}'s share as settled?`,
  settleBody: "Use this when they paid by hand. Anything collected in the app goes back to them.",
  settleConfirm: "Mark as settled",
  settled: (name: string) => `${name}'s share is settled with the club.`,
  /**
   * P11 — the return is WAITING: the organiser's balance could not cover it, so no money has
   * moved yet. It goes back as soon as the organiser's balance covers it.
   */
  removedWaiting: (name: string, amount: string | null, organiser: string) =>
    `Removed ${name}. ${returnWaiting(amount, organiser)}`,
  settledWaiting: (name: string, amount: string | null, organiser: string) =>
    `${name}'s share is settled with the club. ${returnWaiting(amount, organiser)}`,
  collect: "Collect",
  collectTitle: (name: string) => `Collect ${name}'s share?`,
  collectBody: "Takes their share now, even from a lapsed seat.",
  collectConfirm: "Collect share",
  collected: (name: string, amount: string) => `Collected ${amount} from ${name}.`,
  overdraftTitle: "This may go below zero",
  /**
   * R1 F2.13 — who goes below zero, by full name. R15 J15-11 — not "up to 25 minutes below zero":
   * the page does not know their balance, and a member with 15 goes 10 under. What their balance
   * does not cover is what goes below zero.
   */
  overdraftCollect: (amount: string, name: string) =>
    `Take ${amount} from ${name} even if their balance doesn't cover it — whatever it doesn't cover takes them below zero`,
  /** Who goes below zero, and — when the server said — by how much: the return less what covers it. */
  overdraftReturn: (name: string, figures?: { returned: string; covered: string; short: string; partner: string }) => (figures
    ? `Go ahead even if it takes ${name} below zero: ${figures.returned} ${agrees(figures.returned, "goes", "go")} back to ${figures.partner}, ${figures.covered} of it ${agrees(figures.covered, "is", "are")} covered, so ${name} goes up to ${figures.short} below zero`
    : `Go ahead even if it takes ${name} below zero`),
  overdraftAsked: "The club's system needs your explicit go-ahead: this would take someone below zero.",
  overdraftMissing: "Tick the box to authorise it.",
  action: "do that",
} as const;

/** The link on an admin's member page to the booking's own page. */
export const DETAIL_LINKS = {
  open: "Players",
  openFor: (court: string, when: string) => `Players on ${court}, ${when}`,
} as const;

/* ═══════════════════════════════════ INVITES ═══════════════════════════════════ */
/* Owned by the invites lane. */

export const INVITES_COPY = {
  title: "Invites",
  /** R4 form factor (SPEC 3.5) — the split view's detail pane and the phone's docked verb. */
  detailLabel: "The invite",
  pickTitle: "Pick an invite",
  pickHint: "Its game, your share and when it must be paid open here, with Accept and Decline.",
  actionsLabel: "Invite actions",
  pageTitle: "Invite",
  back: "Bookings",
  description: "Games friends have asked you into. Say yes and your share moves to whoever booked the court.",
  refresh: "Refresh invites",
  readAction: "read your invites",
  listLabel: "Invites waiting for you",
  emptyTitle: "No invites waiting",
  emptyHint: "When a friend adds you to a booking, or sends you a link to one, it shows up here for you to say yes or no.",
  toBookings: "Back to Bookings",
  toInvites: "See your invites",
  statusWaiting: "Waiting for your answer",
  statusAskedAgain: "Your share went up — asked again",
  /** R14 J14-9 — the club accepted the seat without asking: nothing agreed, so nothing "went up". */
  statusAskedFirst: "The club added you — your share needs a yes",
  sheetTitle: "Join this game?",
  sheetDescription: "Check your share, then say yes or no.",
  linkTitle: "You're invited",
  /** R4 M4-8 — a seat that already said yes, asked again because its share went up. */
  askedAgainTitle: "Your share went up",
  /** R14 J14-9 — the heading for a seat the club accepted without asking. */
  askedFirstTitle: "The club added you to this game",
  court: "Court",
  when: "When",
  organiser: "Booked by",
  players: "Players",
  yourShare: "Your share",
  toPayNow: "To pay now",
  balanceAfter: "Balance after",
  /** R9 J9-2 — the Book sheet's words: with nothing held the figures ARE the balance. */
  balanceNow: "Balance now",
  /** With anything held for or owed back to partners, the figures are what may be SPENT (J9-2). */
  availableNow: "Available now",
  availableAfter: "Available after",
  heldHint: "Why some isn't spendable",
  capCounts: "This game counts toward your own daily limit on court.",
  decline: "Decline",
  /** R1 F2.6 — Decline is final, so it asks once before it goes. */
  declineConfirm: "Decline for good",
  declineKeep: "Keep the invite",
  declineFinal: (organiser: string) =>
    `Declining is final — ${organiser} is told, and can't ask you into this game again.`,
  /** R12 J12-3 — the decline question's own title: it is not "Join this game?". */
  declineSheetTitle: "Decline this game?",
  /** R12 J12-3 — a no takes nothing and holds nothing, so the question shows no figures and says so. */
  declineNothingMoves: "Nothing moves: no minutes leave your wallet.",
  cancel: "Cancel",
  done: "Done",
  /** P13 — the short-balance way out is a package; the verb is "buy" (§6). */
  buyMinutes: BUY_MINUTES_ACTION,
  shortBody: "Buy a package, then come back — the invite waits for you until it lapses.",
  capBlocked: "You can't accept this one while it would break your limit.",
  acceptedTitle: "You're in",
  seeBooking: "See the booking",
  declinedTitle: "You said no",
  readingAgain: "Checking the latest figure…",
  /** R4 (I4-1's rule) — the accept sheet's waiting line, said again on every refused close. */
  sending: "Answering… waiting for the club's answer before this closes.",
  acceptAction: "accept the invite",
  declineAction: "decline the invite",
  deepLinkGone: "This invite is no longer waiting for you",
  deepLinkGoneHint:
    "It may have been answered, withdrawn, or its shares may have closed — or it was sent to a different account. Your invites and bookings have the latest.",
  /** D5 — the invite may be another member's: the club will not say whose, so the page says who is signed in. */
  signOutToOpen: "Sign out to open it as the invited member",
  refusedTitle: "This invite can't be opened",
  linkNotFound: "This link isn't for this account or no longer works — if it was sent to someone else, they can open it; otherwise ask for a fresh one.",
  linkClosed: "This invite has closed — the game was cancelled, or its shares are settled.",
  linkAlreadyIn: "You're already on this game.",
  linkRemoved: "You were taken off this game, so this link can't put you back on it. Talk to whoever booked it.",
  readLinkAction: "open this invite",
  /** R1 F2.3 / F2.4 — an invite opened signed out. The club shows a game only to a member, so the page says what it can. */
  signedOutTitle: "You've been invited to a game",
  signedOutBody: "Sign in to see who asked you, when it is and your share — then say yes or no.",
  /** R2 F2-7 — under the preview's own facts: they are already on screen, so only the answer needs a sign-in. */
  signedOutBodyShown: "Sign in to answer.",
  signedOutSignIn: "Sign in to answer",
  signedOutJoin: "Join the club",
  signedOutJoinHint: "New here? Join the club — once you're approved and signed in, this invite will be waiting for you.",
  /** Review round 1 (B4) — the anonymous preview: once a link's seat is not open, there is nothing to sign in for. */
  signedOutGoneTitle: "This invite is no longer open",
  signedOutGoneBody: "The game may have been cancelled, or its seat was answered or closed. Ask whoever sent it for a fresh link.",
  /** "Sam invited you to play" — the anonymous preview names the organiser by first name only. */
  previewInvited: (organiser: string) => `${organiser} invited you to play`,
  /** R1 F2.7 — a link this account opened before, now closed: never "sign out". */
  linkNoLongerOpen: "This invite is no longer open — the game may have been cancelled, or its seat was answered or closed.",
  /** R1 F2.7 / F2.8 — the mail's link, once the invite has moved on: what happened to it. */
  fateInTitle: "You're in",
  fateInBody: "You've already said yes to this game.",
  fateCancelledTitle: "This game was cancelled",
  fateCancelledBody: "Nothing more is needed from you. The booking shows what happened to any share.",
  /** R2 F2-6 — the claimer's own link, after the organiser cancelled. */
  linkCancelledBack: (amount: string) => `This game was cancelled — your ${amount} is back on your balance.`,
  linkCancelledNothing: "This game was cancelled — nothing was taken from you for it.",
  fateGoneTitle: "You're no longer on this game",
  fateGoneBody: "You declined it, pulled out or were taken off it — or its invite lapsed. Your bookings have the latest.",
  /** R1 F2.5 — an invite link opened and not yet answered (a short balance, a sign-in between), resurfaced. */
  pendingFrom: "From a link you opened",
  pendingNote: PENDING_INVITE_NOTE.join,
  pendingNoteVerified: PENDING_INVITE_NOTE.verified,
  pendingOpen: "Open your invite",
} as const;

/** "You're signed in as Olivia." — beside an invite this account cannot open (D5). */
export function signedInAsLine(name: string): string {
  return `You're signed in as ${name}.`;
}

/** "Accept and pay 22 min" — or plain "Accept" when nothing is collected now. */
export function acceptLabel(toPay: number): string {
  return toPay > 0 ? `Accept and pay ${minutesSpoken(toPay)}` : "Accept";
}

/** "2 invites waiting" — the Bookings badge's accessible name. */
export function invitesWaitingLabel(count: number): string {
  return `${count} ${count === 1 ? "invite" : "invites"} waiting`;
}

/** "Accepted — 5 min still to pay". */
export function acceptedUnpaidLine(toPay: number): string {
  return `Accepted — ${minutesSpoken(toPay)} still to pay`;
}

/** R4 M4-8 — "Sam changed the split: your share is now 30 min. Check it and say yes again." */
/** R14 J14-9 — the line under `askedFirstTitle`: the share asked for, the first time. */
export function askedFirstLine(share: number): string {
  return `The club has asked you for ${minutesSpoken(share)} — check it and say yes.`;
}

export function askedAgainLine(organiser: string, share: number): string {
  return `${organiser} changed the split: your share is now ${minutesSpoken(share)}. Check it and say yes again.`;
}

/**
 * "Sam invited you to take a seat" (open link) · "Sam invited you to play". R15 J15-1 — a seat the
 * club put the member on (`added_by_club`) is the club's act: "The club added you to Sam's game".
 */
export function invitedLine(organiser: string, openLink: boolean, byClub = false): string {
  if (byClub) return `The club added you to ${organiser}'s game`;
  return openLink ? `${organiser} invited you to take a seat` : `${organiser} invited you to play`;
}

/** "Pay by Thu 1 Oct, 20:45, or it lapses to Sam — no debt either way." */
export function deadlineLine(deadline: string, organiser: string, timezone?: string): string {
  return `Pay by ${playersWhen(deadline, timezone)}, or it lapses to ${organiser} — no debt either way.`;
}

/** "Pay by Thu 1 Oct, 20:45" — the card's short deadline. */
export function payByLine(deadline: string, timezone?: string): string {
  return `Pay by ${playersWhen(deadline, timezone)}`;
}

/** "You need 12 min more to spend to accept this." */
export function shortByLine(shortBy: number): string {
  return `You need ${minutesSpoken(shortBy)} more to spend to accept this.`;
}

/** "4 players" / "2 players". */
export function playersCount(count: number): string {
  return `${count} ${count === 1 ? "player" : "players"}`;
}

/**
 * The calm confirmation's line: "22 min paid to Sam. See you on court." R15 J15-11 — `paid` is
 * what THIS accept paid (the button's "Accept and pay 10 minutes"); `total`, the seat's paid in
 * all, is said beside it when an earlier payment makes it more ("10 minutes paid to Mia — 30
 * minutes in all"), never in its place.
 */
export function acceptedLine(paid: number, organiser: string, total = paid): string {
  if (paid <= 0) return "See you on court.";
  const inAll = total > paid ? ` — ${minutesSpoken(total)} in all` : "";
  return `${minutesSpoken(paid)} paid to ${organiser}${inAll}. See you on court.`;
}

/** "Sam's been told." — after a decline. */
export function declinedLine(organiser: string): string {
  return `${organiser} has been told. They can't ask you into this game again.`;
}

/**
 * Refusals where the reader is the PARTNER. The shared sentences for these codes speak to the
 * organiser ("That player was taken off…"), so the invites screens say them in the second person;
 * every other code is `playersRefusal`'s.
 */
/**
 * R2 F2-1 — an accept whose reply was lost, after the seat was read back. Never "Couldn't
 * accept" about a yes the club had taken the money for.
 */
export const INVITE_UNSURE = {
  checked: "The club didn't answer, so we checked your invite: you're not on this game yet — nothing was taken. Try again in a moment.",
  unchecked: "The club didn't answer and your invite couldn't be checked either, so we can't tell whether you're in. Check your bookings and your wallet before trying again.",
  provenNote: "The club's reply didn't arrive, so we checked your invite — you're in. Your wallet is being re-read.",
  /** R3 I-3 — the decline landed although its reply was lost. */
  declineProvenNote: "The club's reply didn't arrive, so we checked your invite — your answer went through.",
} as const;

export const INVITE_REFUSAL: Record<string, string> = {
  player_previously_removed: "You were taken off this game, so you can't rejoin it. Talk to whoever booked it.",
  already_in_booking: "You're already on this game.",
};

/* ═══════════════════════════════════ INBOX ═══════════════════════════════════ */
/* Owned by the inbox lane. */

/** The bell in the top bar and the member's inbox at `/inbox`. */
export const INBOX_COPY = {
  title: INBOX_TITLE,
  /** R4 form factor (SPEC 3.6) — the split view's detail pane. */
  pickTitle: "Pick a notification",
  pickHint: "Its game, its money or its invite opens here, so you can act on it without leaving your inbox.",
  noticeLabel: "The notification",
  openTarget: "Open it",
  description: "Invites, shares and changes to your games.",
  listLabel: "Your notifications",
  /** StateBlock's "Couldn't read your notifications — …". */
  readAction: "read your notifications",
  readCaveat: "This doesn't mean you have none.",
  empty: "Nothing yet — invites, shares and game changes land here.",
  markAll: "Mark all read",
  /** R4 X4-5 — said once every notice is marked read; the bar that held the button has gone. */
  allRead: "All read",
  markAllAction: "mark your notifications read",
  markOne: "Mark read",
  markOneAction: "mark that notification read",
  unread: "Unread",
  showMore: "Show more",
  showMoreFailed: "Couldn't read the older notifications. Try again.",
  cursorExpired: "The list moved on while you were reading. Refresh to start from the newest.",
  refresh: "Refresh notifications",
  today: "Today",
  /** R2 F2-5 — a question that has been answered or withdrawn: said so, never still "to confirm". */
  resolved: "Nothing needed now",
  resolvedHint: "This no longer needs you — the booking has the latest.",
  /** Lost-reply audit (R3): a mark whose reply was lost and whose look failed too. */
  markUnknown: "The club didn't answer and we couldn't check either, so we can't tell whether that was marked read. Refresh to see.",
} as const;

/** The bell's words live with the shell (`bellCopy`, so this file stays out of the entry chunk). */
export { bellBadge, bellLabel } from "./bellCopy";

/** Above the inbox list: "1 unread" / "3 unread". */
export function inboxUnreadLine(unread: number): string {
  return `${unread} unread`;
}


/** What each kind is, in words — the icon's companion for a screen reader. */
export const INBOX_KIND_WORD: Record<string, string> = {
  "players.invited": "Invite",
  "players.share_moved": "Share",
  "players.reminder": "Reminder",
  "players.lapsed": "Lapsed share",
  "players.game_cancelled": "Game cancelled",
  "players.game_changed": "Game changed",
  "players.response": "Reply",
  "players.return_waiting": "Share on its way back",
  "players.club_seat": "Added by the club",
};

/* ═══════════════════════════════════ WALLET · REPORTS · PRIVACY ═══════════════════════════════════ */
/* Owned by the wallet-and-privacy lane. */

/** The reports' share rows (D11). Both optional on the wire: an older API sends neither. */
export const REPORT_SHARES_COPY = {
  memberShares: "Shares from/to partners",
  memberNetCourt: "What court time cost you, after shares",
  memberFootnote: "Shares are what partners paid you, less what you paid as a partner.",
  clubShares: "Shares between players",
  clubCaption: "Shares move minutes from one member to another, so across the club they always add up to zero.",
} as const;

/**
 * D13 — the social switches. Both OFF by default and opt-in: nobody is findable or ranked
 * because they never said no.
 */
export const PRIVACY_COPY = {
  title: "Privacy",
  description: "Who can find you by name when adding players. It's off until you turn it on.",
  findableLabel: "Let other members find me",
  findableHint: "Club members can find you by name when adding players. Invite links and people you've played with work either way.",
  leaderboardsLabel: "Show me on leaderboards",
  leaderboardsHint: "For when leaderboards arrive. Off means you're never listed.",
  readAction: "read your privacy settings",
  saving: "Saving",
  /** Said once the switch has landed, so a screen reader hears the outcome. */
  savedOn: (label: string) => `${label}: on.`,
  savedOff: (label: string) => `${label}: off.`,
  /** The switch went back; this says why and that nothing changed. */
  saveFailed: (label: string) => `Couldn't change "${label}" — it's back as it was. Try again.`,
} as const;

