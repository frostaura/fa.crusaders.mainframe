import { ApiError } from "./api";
import { clubClock } from "./clubClock";
import { clubZone } from "./clubZone";
import { describeFailure } from "./errors";
import { formatCredits } from "./utils";

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
  someone: "A member",
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

/** "Sam" from "Sam Petersen" — the grid's own rule: first names between members. */
export function firstName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return PLAYERS_COPY.someone;
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

/** "Sam", "Sam and Alex", "Sam, Alex and Jo". */
export function listNames(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * "Wed 30 Sep, 18:00" in the club's zone — the one face every players screen writes an instant
 * in. Built from parts, as `bookFlow.clubDayLabel` is, because ICU's en-GB spells September
 * "Sept" and a players screen must not be the one place that disagrees with the grid.
 */
export function playersWhen(iso: string | number | Date, timezone?: string): string {
  const at = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: timezone ?? clubZone(),
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month").slice(0, 3)}, ${clubClock(at, timezone)}`;
}

/** "12.00 cr held until Sat 27 Sep, 20:00" — wherever the balance is explained (§3a). */
export function heldLine(heldCredits: number, until: string | null | undefined, timezone?: string): string {
  const amount = formatCredits(heldCredits);
  return until ? `${amount} held until ${playersWhen(until, timezone)}` : `${amount} held`;
}

/** Why some of a balance is not spendable — the sentence under a held line. */
export const HELD_EXPLAINER =
  "Shares your partners paid you are held until 48 hours after each game, in case one comes back. They're yours — you just can't spend them yet.";

/**
 * P11 — "16.00 cr owed back to partners — paid from your next credit". Owed back has no date:
 * it clears when credit comes in, so the line says that instead of an "until".
 */
export function owedBackLine(owedBackCredits: number): string {
  return `${formatCredits(owedBackCredits)} owed back to partners — paid from your next credit`;
}

/** Why a balance owes partners — the sentence under an owed-back line. */
export const OWED_BACK_EXPLAINER =
  "A partner's share came back to them after you'd already spent it, so their credits are waiting on your balance. The next credits you get go to them first, then to you.";

/** For an admin reading a quote: the same fact, about whoever pays. */
export function owedBackQuoteLine(owedBackCredits: number, name: string | null): string {
  const who = name ?? "You";
  const owes = name ? "owes" : "owe";
  return `${who} ${owes} ${formatCredits(owedBackCredits)} back to partners — that comes out of the next credit first.`;
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
  split_amount_invalid: "Each amount must be zero or more, to at most two decimal places.",
  split_exceeds_price: "The amounts you've asked for add up to more than the court costs.",
  split_needs_organiser: "Something went wrong with your own seat. Refresh and try again.",
  split_preview_invalid: "We couldn't work out that split. Check the figures.",
  split_pay_in_app: "This booking is split — each player pays their share in the app.",
  query_too_short: "Type at least two letters of their name.",
  cannot_favourite_self: "You can't star yourself.",
  notification_not_found: "That notification has gone.",
};

function creditsDetail(e: ApiError, key: string): number | null {
  const value = e.detail(key);
  return typeof value === "number" ? value : null;
}

function capSentence(e: ApiError): string {
  const day = e.detail("club_day");
  const when = typeof day === "string" ? ` on ${day}` : " that day";
  if (e.detail("cap") === "slots") {
    const cap = creditsDetail(e, "cap_slots");
    return cap === null
      ? `Saying yes would take you past your daily limit${when}.`
      : `Saying yes would take you past your limit of ${cap} slots a day${when}.`;
  }
  if (e.detail("cap") === "minutes") {
    const cap = creditsDetail(e, "cap_minutes");
    return cap === null
      ? `Saying yes would take you past your daily limit${when}.`
      : `Saying yes would take you past your limit of ${cap} minutes on court a day${when}.`;
  }
  return "Saying yes would take you past your daily limit on court.";
}

function withFigures(e: ApiError, timezone?: string): string | null {
  switch (e.code) {
    case "share_changed": {
      const share = creditsDetail(e, "share_credits");
      return share === null
        ? "Your share has changed since you opened this. Check the new figure and say yes again."
        : `Your share is now ${formatCredits(share)}. Check it and say yes again if you're happy.`;
    }
    case "insufficient_balance": {
      const have = creditsDetail(e, "current_credits");
      const need = creditsDetail(e, "required_credits");
      if (have === null || need === null) return "You don't have enough credits to spend for this. Top up and try again.";
      return `You need ${formatCredits(need)} and have ${formatCredits(have)} to spend. Top up ${formatCredits(Math.max(0, need - have))} and try again.`;
    }
    case "partner_cap_exceeded": return capSentence(e);
    case "withdraw_window_closed": {
      const at = e.detail("closed_at");
      return typeof at === "string"
        ? `It's too close to the game to pull out — that closed at ${playersWhen(at, timezone)}. Talk to the organiser.`
        : "It's too close to the game to pull out. Talk to the organiser.";
    }
    case "nudge_limit": {
      const limit = creditsDetail(e, "limit");
      const until = e.detail("retry_after");
      const count = limit === null ? "the most reminders" : `${limit} reminder${limit === 1 ? "" : "s"}`;
      return typeof until === "string"
        ? `You've sent ${count} today. You can remind them again after ${playersWhen(until, timezone)}.`
        : `You've sent ${count} today. Try again tomorrow.`;
    }
    case "player_invite_limit": {
      const limit = creditsDetail(e, "limit");
      return limit === null
        ? "This booking has had as many invites as it can."
        : `A booking can send ${limit} invites in all, and this one has used them. Share an existing link instead.`;
    }
    case "directory_rate_limited": {
      const seconds = creditsDetail(e, "retry_after_seconds");
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
};

/**
 * The one sentence for anything a players route answers with — a refusal with its figures, a
 * refusal we know by name, or a failure that is not a refusal at all (the connection, the
 * club's system), which `describeFailure` owns.
 */
export function playersRefusal(error: unknown, options: RefusalOptions = {}): string {
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
    equal: "Everyone who pays gets the same share in whole credits. You take any odd credit.",
    ratio: "Give each player a weight from 0 to 100 — shares follow the weights.",
    amount: "Ask each player for an amount. You cover whatever is left.",
  },
  weightLabel: (name: string) => `Weight for ${name}`,
  amountLabel: (name: string) => `Amount for ${name}`,
  theRest: "The rest",
  playsFree: "Plays free",
  sharesLabel: "Shares",
  totalsLabel: "What each player is asked for",
  eachBooking: "Each booking",
  perPrice: (price: string) => `Each ${price} booking`,
  youPayNow: (now: string, back: string) => `You pay ${now} now · you get ${back} back as they accept`,
  addsUp: (price: string) => `Adds up to ${price}`,
  reading: "Working out the shares…",
  previewAction: "work out the shares",
} as const;

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
    return `${who} ${plural ? "are" : "is"} asked for ${formatCredits(paying[0].share)}${plural ? " each" : ""}`;
  }
  const parts = paying.map((s, i) => {
    const who = s.kind === "link" ? linkTakers(1) : s.name;
    return i === 0 ? `${who} is asked for ${formatCredits(s.share)}` : `${who} for ${formatCredits(s.share)}`;
  });
  return listNames(parts);
}

/**
 * The Confirm step's one sentence: "You pay 100.00 cr now; Sam and Alex are asked for 25.00 cr
 * each. Jo (guest) plays free." `price` is what the organiser is charged now (the whole court).
 */
export function confirmPlayersSentence(price: number, seats: readonly SentenceSeat[], eachBooking = false): string {
  const lead = `${eachBooking ? "On each booking you" : "You"} pay ${formatCredits(price)} now`;
  const paying = seats.filter((s) => s.kind !== "guest");
  const guests = seats.filter((s) => s.kind === "guest").map((s) => BOOK_PLAYERS.guestShort(s.name));
  const ask = paying.length ? `; ${askClause(paying)}` : "";
  const free = guests.length ? ` ${listNames(guests)} ${guests.length > 1 ? "play" : "plays"} free.` : "";
  return `${lead}${ask}.${free}`;
}

/** The Confirm step and the result's players outcome. */
export const BOOK_CONFIRM = {
  playersLabel: "Players",
  playersLine: (names: readonly string[]) => `You, ${listNames(names)}`,
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
  back: "Bookings",
  backToBookings: "Back to Bookings",
  readAction: "read this booking",
  refresh: "Refresh this booking",
  notFoundTitle: "Booking not found",
  refreshFailed: "Couldn't refresh this booking — this is what we last read.",
  organisedByYou: "You organised this game",
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
  removeOpenTitle: "Remove this open seat?",
  removeOpenBody: "Its link stops working and the seat is free again.",
  removeConfirm: "Remove",
  removeKeep: "Keep them",
  removed: (name: string) => `${name} is off this game.`,
  removeAction: "remove that player",
  openSeatName: "Open seat",
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
  action: "change the split",
} as const;

/** R1 F2.1 — a player added to an amount or ratio split is asked for a share the organiser names. */
export const SHARE_ASK = {
  title: (who: string) => `What should ${who} pay?`,
  amountBody: (covered: string) => `You cover ${covered} now. What you ask for comes off that.`,
  ratioBody: "Shares follow the weights. Give them a weight from 0 to 100.",
  amountLabel: (who: string) => `Amount for ${who}`,
  weightLabel: (who: string) => `Weight for ${who}`,
  amountHint: "In credits, up to two decimal places. 0 means you cover them.",
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
  /** R1 F2.13 — nothing was ever agreed (accepted by the club): no "said yes to 0.00 cr". */
  notAgreedRow: (share: string) => `Share of ${share} not agreed — nothing collected`,
  settledRow: "Settled with the club",
  coversRow: "Covers the court",
  guestRow: "Guest · no share",
  lapsedRow: "Share lapsed",
  unpaidSentence: (name: string, when: string, toWhom: string) =>
    `${name} hasn't paid yet — their share lapses to ${toWhom} if unpaid by ${when}.`,
  toYou: "you",
  notSplit: "This court isn't split — the organiser covers it all.",
} as const;

/**
 * R1 F2.10 — a cancelled booking says only what is true: it was cancelled, who was on it, and
 * where the money went. No deadline, no "not paid yet", no "all paid up", no result to record.
 */
export const DETAIL_CANCELLED = {
  banner: "This game was cancelled.",
  playersDescription: "Who was on the game when it was cancelled.",
  moneyNote: "The booking was cancelled — this is where the money went.",
  refunded: (who: string | null) => (who ? `Refunded to ${who}` : "Refunded to you"),
  kept: (who: string | null) => (who ? `${who} paid in the end` : "You paid in the end"),
  nothingToPay: "Nothing to pay",
  paidRow: (paid: string) => `Paid ${paid}`,
  partnerNothing: "The game was cancelled, so there's nothing for you to pay.",
  partnerPaid: (paid: string) => `The game was cancelled after check-in, so the ${paid} you paid stands.`,
} as const;

/** A player's own share and their hand: withdraw, decline, review. */
export const DETAIL_PLAYER = {
  title: "Your share",
  share: "Your share",
  paid: "You've paid",
  toPay: "Still to pay",
  paidAll: "You're all paid up.",
  askedAgain: (share: string) => `Your share went up to ${share}. Review it to say yes again.`,
  review: "Review your share",
  withdraw: "Pull out",
  withdrawUntil: (when: string) => `You can pull out until ${when}.`,
  withdrawClosed: (when: string) => `Pulling out closed at ${when}. Talk to the organiser.`,
  withdrawTitle: "Pull out of this game?",
  withdrawBody: "You come off the booking and anything you paid comes back to you.",
  withdrawConfirm: "Pull out",
  withdrawKeep: "Stay in",
  withdrawn: "You've pulled out. Anything you paid is back in your credit.",
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
  notYet: "Nobody has checked in yet.",
  count: (n: number, of: number) => `${n} of ${of} player${of === 1 ? "" : "s"} checked in`,
} as const;

/** The organiser cancelling — the grid's own CancelSheet, with the partners' side said first. */
export const DETAIL_CANCEL = {
  title: "Cancel this booking",
  partnersBack: "Your partners get back what they paid for their shares.",
  penaltyYours: "Any late-cancellation penalty is yours alone — it isn't split.",
  open: "Cancel booking",
  cancelled: "The booking is cancelled.",
} as const;

/** "Their 16.00 cr is waiting on Naledi's balance and goes back as soon as it's covered." */
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
  memberLabel: "Member",
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
  /** R1 F2.13 — who goes below zero, by full name, and the most it can be: the whole amount taken. */
  overdraftCollect: (amount: string, name: string) => `Take ${amount} from ${name} even if it puts them up to ${amount} below zero`,
  /** Who goes below zero, and — when the server said — by how much: the return less what covers it. */
  overdraftReturn: (name: string, figures?: { returned: string; covered: string; short: string; partner: string }) => (figures
    ? `Go ahead even if it takes ${name} below zero: ${figures.returned} goes back to ${figures.partner}, ${figures.covered} of it is covered, so ${name} goes up to ${figures.short} below zero`
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
  sheetTitle: "Join this game?",
  sheetDescription: "Check your share, then say yes or no.",
  linkTitle: "You're invited",
  court: "Court",
  when: "When",
  organiser: "Booked by",
  players: "Players",
  yourShare: "Your share",
  toPayNow: "To pay now",
  spendable: "Available to spend",
  balanceAfter: "Balance after",
  heldHint: "Why some isn't spendable",
  capCounts: "This game counts toward your own daily limit on court.",
  decline: "Decline",
  /** R1 F2.6 — Decline is final, so it asks once before it goes. */
  declineConfirm: "Decline for good",
  declineKeep: "Keep the invite",
  declineFinal: (organiser: string) =>
    `Declining is final — ${organiser} is told, and can't ask you into this game again.`,
  cancel: "Cancel",
  done: "Done",
  topUp: "Top up",
  shortBody: "Top up, then come back — the invite waits for you until it lapses.",
  capBlocked: "You can't accept this one while it would break your limit.",
  acceptedTitle: "You're in",
  seeBooking: "See the booking",
  declinedTitle: "You said no",
  readingAgain: "Checking the latest figure…",
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
  signedOutSignIn: "Sign in to answer",
  signedOutJoin: "Join the club",
  signedOutJoinHint: "New here? Join the club — once you're approved and signed in, this invite will be waiting for you.",
  /** R1 F2.7 — a link this account opened before, now closed: never "sign out". */
  linkNoLongerOpen: "This invite is no longer open — the game may have been cancelled, or its seat was answered or closed.",
  /** R1 F2.7 / F2.8 — the mail's link, once the invite has moved on: what happened to it. */
  fateInTitle: "You're in",
  fateInBody: "You've already said yes to this game.",
  fateCancelledTitle: "This game was cancelled",
  fateCancelledBody: "Nothing more is needed from you. The booking shows what happened to any share.",
  fateGoneTitle: "You're no longer on this game",
  fateGoneBody: "You declined it, pulled out or were taken off it — or its invite lapsed. Your bookings have the latest.",
  /** R1 F2.5 — an invite link opened and not yet answered (a short balance, a sign-in between), resurfaced. */
  pendingFrom: "From a link you opened",
  pendingNote: "You've been invited to a game. Join the club, and once you're approved and signed in, the invite will be waiting for you.",
  pendingNoteVerified: "Your invite is waiting — once the club approves you, sign in and we'll take you to it.",
  pendingOpen: "Open your invite",
} as const;

/** "You're signed in as Olivia." — beside an invite this account cannot open (D5). */
export function signedInAsLine(name: string): string {
  return `You're signed in as ${name}.`;
}

/** "Accept and pay 25.00 cr" — or plain "Accept" when nothing is collected now. */
export function acceptLabel(toPay: number): string {
  return toPay > 0 ? `Accept and pay ${formatCredits(toPay)}` : "Accept";
}

/** "2 invites waiting" — the Bookings badge's accessible name. */
export function invitesWaitingLabel(count: number): string {
  return `${count} ${count === 1 ? "invite" : "invites"} waiting`;
}

/** "Accepted — 5.00 cr still to pay". */
export function acceptedUnpaidLine(toPay: number): string {
  return `Accepted — ${formatCredits(toPay)} still to pay`;
}

/** "Sam invited you to take a seat" (open link) · "Sam invited you to play". */
export function invitedLine(organiser: string, openLink: boolean): string {
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

/** "You need 12.50 cr more to spend to accept this." */
export function shortByLine(shortBy: number): string {
  return `You need ${formatCredits(shortBy)} more to spend to accept this.`;
}

/** "4 players" / "2 players". */
export function playersCount(count: number): string {
  return `${count} ${count === 1 ? "player" : "players"}`;
}

/** The calm confirmation's line: "25.00 cr paid to Sam. See you on court." */
export function acceptedLine(paid: number, organiser: string): string {
  return paid > 0 ? `${formatCredits(paid)} paid to ${organiser}. See you on court.` : "See you on court.";
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
export const INVITE_REFUSAL: Record<string, string> = {
  player_previously_removed: "You were taken off this game, so you can't rejoin it. Talk to whoever booked it.",
  already_in_booking: "You're already on this game.",
};

/* ═══════════════════════════════════ INBOX ═══════════════════════════════════ */
/* Owned by the inbox lane. */

/** The bell in the top bar and the member's inbox at `/inbox`. */
export const INBOX_COPY = {
  title: "Notifications",
  description: "Invites, shares and changes to your games.",
  listLabel: "Your notifications",
  /** StateBlock's "Couldn't read your notifications — …". */
  readAction: "read your notifications",
  readCaveat: "This doesn't mean you have none.",
  empty: "Nothing yet — invites, shares and game changes land here.",
  markAll: "Mark all read",
  markAllAction: "mark your notifications read",
  markOne: "Mark read",
  markOneAction: "mark that notification read",
  unread: "Unread",
  showMore: "Show more",
  showMoreFailed: "Couldn't read the older notifications. Try again.",
  cursorExpired: "The list moved on while you were reading. Refresh to start from the newest.",
  refresh: "Refresh notifications",
  today: "Today",
} as const;

/** The bell's accessible name: "Notifications, 3 unread" — or just "Notifications". */
export function bellLabel(unread: number | null): string {
  return unread && unread > 0 ? `${INBOX_COPY.title}, ${unread} unread` : INBOX_COPY.title;
}

/** Above the inbox list: "1 unread" / "3 unread". */
export function inboxUnreadLine(unread: number): string {
  return `${unread} unread`;
}

/** The digits on the bell: 1–9, then "9+". Null at zero or unknown — no badge at all. */
export function bellBadge(unread: number | null): string | null {
  if (!unread || unread <= 0) return null;
  return unread > 9 ? "9+" : String(unread);
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
};

/* ═══════════════════════════════════ WALLET · REPORTS · PRIVACY ═══════════════════════════════════ */
/* Owned by the wallet-and-privacy lane. */

/** The reports' share rows (D11). Both optional on the wire: an older API sends neither. */
export const REPORT_SHARES_COPY = {
  memberShares: "Shares from/to partners",
  memberNetCourt: "What court time cost you, after shares",
  memberFootnote: "Shares are what partners paid you, less what you paid as a partner.",
  clubShares: "Shares between players",
  clubCaption: "Shares move credit from one member to another, so across the club they always add up to zero.",
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

