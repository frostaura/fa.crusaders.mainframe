import { minutesSpoken } from "./minutes";
import { dateTimeFormat } from "./intlCache";

/**
 * Every sentence the booking grid says, in one module.
 *
 * <p>
 * The shape `lib/doorsCopy.ts` established, and here for the same reason it was established
 * there: the same sentence is needed in a button label, in an `aria-label` and in a live
 * region, and the third copy is what turns wording into drift. A cell that LOOKS restricted
 * and a cell that SAYS it is restricted have to be reading the same string, or the screen
 * reader and the eye are told two different things about one slot.
 * </p>
 *
 * <p>
 * <b>Both halves of every conditional.</b> Where a member can act, the sentence says what to
 * do; where they cannot, it says so plainly rather than softening it. Telling somebody to
 * "check back later" about a slot that will never be theirs wastes their evening, so the
 * opens-at clause is omitted when there is no opens-at, never replaced with a kindness.
 * </p>
 *
 * <p>
 * <b>Never shaming.</b> Three rules, which the quota copy below obeys: state the RULE, not the
 * person ("you've booked your 4 slots", never "you've used up your allowance"); say why in one
 * clause ("so everyone gets court time"), which turns a wall into a queue; and always give the
 * next action. The quota banner is `warning`, never `danger` — red says the member did
 * something wrong, and they did not.
 * </p>
 */

/** "Monday" from a `YYYY-MM-DD`, in the club's own spelling, never the reader's locale. */
export function weekdayName(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return "that day";
  // Date-only arithmetic: a calendar date has a weekday with no instant and no zone in it.
  return dateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** "Mondays" — the plural the hours sentence needs. */
export function weekdayPlural(day: string): string {
  const name = weekdayName(day);
  return name === "that day" ? "that day" : `${name}s`;
}

/** What a Closed cell answers when it is tapped. Both halves: the hours, and the day they are for. */
export function closedSentence(day: string, hours: { start: string; end: string } | null): string {
  if (!hours) return `The club is shut at that time on ${weekdayPlural(day)}.`;
  return `The club is open ${hours.start}–${hours.end} on ${weekdayPlural(day)}.`;
}

/**
 * R5 — a free slot past the club's rolling booking window. The grid used to draw it "Book" and
 * the club refused it on Confirm (`too_far_ahead`); it is drawn "Not open yet" and says when.
 */
export function notYetOpenSentence(where: string, advanceDays: number | null): string {
  const window = advanceDays && advanceDays > 0
    ? ` The club opens each slot for booking ${advanceDays} ${advanceDays === 1 ? "day" : "days"} ahead, to the minute.`
    : "";
  return `${where} isn't open for booking yet.${window}`;
}

/** The accessible name of a Closed cell — what it is, then why it is not yours. */
export function closedCellLabel(where: string): string {
  return `${where} — the club is closed`;
}

export function pastCellLabel(where: string): string {
  return `${where} — past`;
}

/**
 * A club hold, named by the thing it is being held FOR.
 *
 * <p>
 * D3 §5.6: the label is the plan's name, never the word "Blocked". A hold nobody can name is
 * a hold nobody can ask about, and a member looking at a grey rectangle where Tuesday evening
 * used to be deserves to know it is the club and not another member.
 * </p>
 */
export function holdCellLabel(where: string, label: string | null): string {
  return label
    ? `${where} — held by the club for ${label}`
    : `${where} — held by the club`;
}

export function holdLiftLabel(where: string, label: string | null): string {
  return label ? `Lift the ${label} hold on ${where}` : `Lift the hold on ${where}`;
}

/* ─────────────────────────── Item 19 — the daily maximum ─────────────────────────── */

/**
 * The word on a quota-locked cell's accessible name — "for today" only on today's grid; any
 * other day is named ("on Thu 1 Oct"), because the count is the SHOWN day's (R2 F1-5).
 */
export function quotaCellLabel(where: string, maxSlots: number, dayLabel: string | null = null): string {
  // R11 E11-6 — "used", not "booked": games the member said yes to fill the limit too.
  return `${where} — you've used your ${maxSlots} ${maxSlots === 1 ? "slot" : "slots"} ${dayLabel ? `on ${dayLabel}` : "for today"}`;
}

/**
 * The standing banner above the grid.
 *
 * <p>
 * A banner, not a toast: a toast for a standing condition clears itself after four seconds and
 * leaves the member staring at a locked grid with nothing to read. `role="status"` rather than
 * `role="alert"` — an alert interrupts, and this is a condition the member arrived into.
 * </p>
 */
export function quotaBannerTitle(maxSlots: number, day: string, accepted = 0): string {
  const slots = maxSlots === 1 ? "slot" : "slots";
  // R11 E11-6 — games the member SAID YES TO count toward the limit too; a member whose slots are
  // all accepted invites booked nothing, so "You've booked" is not true of them.
  // R17 X17-2 — `accepted` counts SLOTS, and one game can fill several: "in" a game, never "is" one.
  if (accepted >= maxSlots) return `Your ${maxSlots} ${slots} for ${weekdayName(day)} ${maxSlots === 1 ? "is in a game" : "are in games"} you said yes to.`;
  if (accepted > 0) {
    const them = accepted === 1 ? "1 of them is in a game" : `${accepted} of them are in games`;
    return `You've booked your ${maxSlots} ${slots} for ${weekdayName(day)} — ${them} you said yes to.`;
  }
  return `You've booked your ${maxSlots} ${slots} for ${weekdayName(day)}.`;
}

export function quotaBannerBody(maxSlots: number, accepted = 0): string {
  const limit = `${maxSlots} ${maxSlots === 1 ? "slot" : "slots"}`;
  // R11 E11-6 — never "cancel" what the member cannot: an accepted seat is somebody else's booking.
  const counts = `Games you said yes to count toward your daily limit of ${limit}, so everyone gets court time.`;
  if (accepted >= maxSlots) return `${counts} Pick another day.`;
  if (accepted > 0) return `Cancel one of your own bookings, or pick another day. ${counts}`;
  // R9 J9-4 — "your" limit, never "the club caps it": a group may set it, and the club's word was wrong then.
  return `Cancel one of them, or pick another day. Your daily limit is ${limit}, so everyone gets court time.`;
}

/**
 * R9 J9-4 — the cap banner's way on. It moves the SHOWN day on by one, so it is "Try tomorrow"
 * only when the shown day is today; otherwise it names the day it goes to ("Try Mon 5 Oct").
 */
export function nextDayAction(shownDay: string, shownIsToday: boolean): { label: string; nextDay: true } {
  if (shownIsToday) return { label: "Try tomorrow", nextDay: true };
  const [y, m, d] = shownDay.split("-").map(Number);
  if (!y || !m || !d) return { label: "Try the next day", nextDay: true };
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const label = dateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(next);
  return { label: `Try ${label}`, nextDay: true };
}

/**
 * The counter that stops the member ever meeting the wall.
 *
 * <p>
 * Approaching a limit is not a warning; only arriving at it is. That is why this function
 * answers the words and `atLimit` answers the tone, and nothing here is coloured until
 * `booked === max`.
 * </p>
 */
/**
 * "2 of 4 today" — or "2 of 4 on Thu 1 Oct" when the grid is showing another day (F1.7): the
 * count is the SHOWN day's, and "today" under Thursday's strip was a different day's claim.
 */
export function quotaPill(booked: number, maxSlots: number, dayLabel: string | null = null): string {
  return `${booked} of ${maxSlots} ${dayLabel ? `on ${dayLabel}` : "today"}`;
}

/* ─────────────────────────── Item 3 — groups, on the member's grid ─────────────────────────── */

/**
 * Why this cell is not the viewer's, in a clause — the CELL's accessible name, as distinct
 * from the word it wears and from the sentence it says when pressed.
 *
 * <p>
 * D4 §7.3 asks for three carriers on every unavailable state: border style, glyph and word.
 * The word has to be short enough for a 120 px column at a 32 px root font ("League only"),
 * and a screen-reader user hears no border and no glyph — so the NAME carries the clause the
 * word cannot. Pressing it gives the whole sentence; this is what is announced by merely
 * arriving at it.
 * </p>
 */
export function unavailableWhy(reason: string, forName: string | null = null): string {
  switch (reason) {
    case "peak_league_only": return "reserved for league and senior members until closer to the time";
    // R2 F1-3: when the desk books for a member, the window is THEIRS — said about them.
    case "group_window": return forName ? `outside ${forName}'s booking times` : "outside the times you can book";
    case "no_bookable_window": return forName ? `not open to ${forName} on this day` : "not open to you on this day";
    case "court_inactive": return "this court is not in use";
    case "too_far_ahead": return "not open for booking yet";
    default: return "not available";
  }
}

/** The short word a restricted cell wears. Never a code, never a group's internal name. */
export function restrictionLabel(
  reason: string, windows: readonly { start: string; end: string }[], forMember = false,
): string {
  if (reason === "peak_league_only") return "League only";
  if (reason === "no_bookable_window") return forMember ? "Not theirs" : "Not yours";
  const next = windows[0];
  if (next) return `From ${next.start}`;
  return forMember ? "Not their hours" : "Not your hours";
}

/**
 * The one sentence a restricted cell says when it is tapped.
 *
 * <p>
 * Named by the member's own group, because naming the group makes the difference a
 * MEMBERSHIP — something they chose — rather than a discrimination that happens to them.
 * </p>
 */
export function restrictionSentence(
  where: string,
  groups: readonly { name: string }[],
  windows: readonly { start: string; end: string }[],
): string {
  const names = listNames(groups.map((g) => g.name));
  const who = names ? `You're in ${names}.` : "";
  if (windows.length === 0) return `${where} isn't open to you on this day. ${who}`.trim();
  const when = windows.map((w) => `${w.start}–${w.end}`).join(" and ");
  return `${where} is outside the times you can book. You can book ${when} on this day. ${who}`.trim();
}

/**
 * The same sentence about the member the desk is booking FOR (R2 F1-3). Booking for a member
 * follows their group's times — god mode lifts the balance check and the daily cap, never the window —
 * so it says whose times they are and where they are changed.
 */
export function memberRestrictionSentence(
  where: string,
  name: string,
  groups: readonly { name: string }[],
  windows: readonly { start: string; end: string }[],
): string {
  const names = listNames(groups.map((g) => g.name));
  const who = names ? ` ${name} is in ${names}.` : "";
  const change = " Their group's times can be changed on the Groups page.";
  if (windows.length === 0) return `${where} isn't open to ${name} on this day.${who}${change}`;
  const when = windows.map((w) => `${w.start}–${w.end}`).join(" and ");
  return `${where} is outside ${name}'s booking times. ${name} can book ${when} on this day.${who}${change}`;
}

/** The empty intersection, about the member the desk is booking for (R2 F1-3). */
export function memberEmptyWindowSentence(name: string, groups: readonly string[], day: string): string {
  const names = listNames(groups);
  const whose = names ? `${name}'s groups (${names})` : `${name}'s groups`;
  return `${whose} have booking times that don't overlap, so there is nothing ${name} can book on ${weekdayName(day)}. Their group's times can be changed on the Groups page.`;
}

/**
 * The empty intersection, said out loud (D2 §4.3).
 *
 * <p>
 * A member in two groups whose windows do not overlap can book nothing at all, and the
 * failure mode this replaces is a grid of grey cells that reads as "the club is shut".
 * Both halves in words, and a way out that is a real one: ask the club.
 * </p>
 */
export function emptyWindowSentence(groups: readonly string[], day: string): string {
  const names = listNames(groups);
  const who = names ? `You are in ${names}, whose booking times do not overlap` : "Your groups' booking times do not overlap";
  return `${who}, so there is nothing you can book on ${weekdayName(day)}. Please ask the club.`;
}

/* ─────────────────────────── The wallet, before the member picks ─────────────────────────── */

/** The action on every empty- or short-wallet prompt. The verb is "buy" (P13 §6). */
export const BUY_MINUTES_ACTION = "Buy minutes";

/**
 * D4 §2.6. A member with an empty wallet was shown thirty-one green cells and found out in the
 * dialog, after choosing a court and a time. The dialog handles it well; it just handles it
 * too late.
 *
 * <p>
 * The cells are deliberately NOT locked by this. A balance is not a booking rule — an admin
 * may sell the member a package while they look, and a grid that hides slots on a wallet read
 * would be making a promise in the other direction. The member is told, and the cells still work.
 * </p>
 *
 * <p>
 * <b>It takes the balance, because a wallet below zero is not an empty one.</b> A member who
 * owes minutes must clear the hole before a package buys them a slot, so the first clause says
 * what they owe; the rest — what a slot takes — is the same either way. A slot costs its
 * playing minutes (P13 §1.1), so "what a slot takes" is the day's slice length, never a price.
 * </p>
 */
export function emptyWalletSentence(balanceMinutes: number | null, sliceMinutes: number | null): string {
  const cost = sliceMinutes !== null && sliceMinutes > 0 ? ` A slot here takes ${minutesSpoken(sliceMinutes)}.` : "";
  // `null` is UNKNOWN and never reaches here — `walletTone` answers "fine" for it — but it is
  // read as "not a debt" rather than trusted not to arrive.
  const shown = balanceMinutes === null ? 0 : Math.trunc(balanceMinutes);
  if (shown < 0) return `You owe ${minutesSpoken(Math.abs(shown))}, so you can't book yet.${cost}`;
  return `You have no minutes left, so you can't book yet.${cost}`;
}

/**
 * P13 — a member with SOME minutes, but fewer than one slot takes: not an empty wallet, and not
 * fine either. Said before they pick, with the way out (buy a package), because the Book sheet
 * would refuse every slot on the grid.
 */
export function shortWalletSentence(balanceMinutes: number, sliceMinutes: number): string {
  return `You have ${minutesSpoken(balanceMinutes)} left and a slot here takes ${minutesSpoken(sliceMinutes)}. Buy a package to book.`;
}

/* ─────────────────────────── The past wall ─────────────────────────── */

/**
 * D4 §7.4. The past rows are not deleted — `gridWindow`'s own comment records the member who
 * was sold 03:00 on a Sunday and could see it on no screen in the product — they are collapsed
 * behind one row that says what is inside it: the club's open rows only, from the first one's
 * start to the last one's END (R2 F1-7 — "00:00 to 06:30 (27 slots)" counted the shut night and
 * stopped a row short).
 */
export function earlierSummary(rows: number, mine: number, from: string | null, to: string): string {
  // Every hidden row was before the club opened: there were no slots, only a shut club.
  if (from === null || rows === 0) return `Earlier today — closed until ${to}`;
  const slots = `${rows} ${rows === 1 ? "slot" : "slots"}`;
  const yours = mine > 0 ? `, ${mine} of them yours` : "";
  return `Earlier today — ${from} to ${to} (${slots}${yours})`;
}

/* ─────────────────────────── helpers ─────────────────────────── */

/** "A and B", "A, B and C" — an Oxford-free list, because this club writes British English. */
function listNames(names: readonly string[]): string {
  const kept = names.filter(Boolean);
  if (kept.length === 0) return "";
  if (kept.length === 1) return kept[0];
  return `${kept.slice(0, -1).join(", ")} and ${kept[kept.length - 1]}`;
}


/**
 * R11 X11-3 — the Book sheet's primary once the club says the slot is gone (taken, out of hours,
 * past): booking it again cannot work, so the one way on closes onto the refreshed grid.
 */
export const BOOK_SHEET_GONE = { pickAnother: "Pick another time" } as const;
