import { formatCredits } from "./utils";
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
  return `${where} — you've booked your ${maxSlots} ${maxSlots === 1 ? "slot" : "slots"} ${dayLabel ? `on ${dayLabel}` : "for today"}`;
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
export function quotaBannerTitle(maxSlots: number, day: string): string {
  const slots = maxSlots === 1 ? "slot" : "slots";
  return `You've booked your ${maxSlots} ${slots} for ${weekdayName(day)}.`;
}

export function quotaBannerBody(maxSlots: number): string {
  return `Cancel one of them, or pick another day. The club caps it at ${maxSlots} so everyone gets court time.`;
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
 * follows their group's times — god mode lifts the credit and the daily cap, never the window —
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

/**
 * The day picker's quiet line when the viewer's price is their group's rather than the court's.
 *
 * <p>
 * R4 I4-7: it read "You're booking as a ix review group." — the club's own name lowercased and
 * singularised, an "a" hard-coded in front of it, and shown for a group that charges the club's
 * standard price, where it said nothing true. Now: only when the group price differs from the
 * court's (`rules.slicePriceCredits` against the first open court's own price, which is what the
 * server prices from), the name as the club wrote it, and never a figure — a member is never
 * shown another group's rate. With several groups the server takes the highest of their prices
 * and does not say whose, so the line does not guess.
 * </p>
 */
export function groupRateLine(
  groups: readonly { name: string }[], groupPrice: number | null, courtPrice: number | null,
): string | null {
  if (groups.length === 0 || groupPrice === null || courtPrice === null || groupPrice === courtPrice) return null;
  const name = groups[0].name.trim();
  if (groups.length > 1 || name === "") return "You book at your groups' rate.";
  return `You book at the ${name} rate.`;
}

/* ─────────────────────────── The wallet, before the member picks ─────────────────────────── */

/**
 * D4 §2.6. A member with no credit was shown thirty-one green cells and found out in the
 * dialog, after choosing a court and a time. The dialog handles it well; it just handles it
 * too late.
 *
 * <p>
 * The cells are deliberately NOT locked by this. A balance is not a booking rule — an admin
 * may top the member up while they look, and a grid that hides slots on a wallet read would
 * be making a promise in the other direction. The member is told, and the cells still work.
 * </p>
 *
 * <p>
 * <b>It takes the balance, because a wallet below zero is not an empty one.</b> This used to
 * take the slice price alone, so the banner was structurally incapable of saying the one thing
 * a member in debt needs to hear — while `walletNotice`, its only caller, had the figure in
 * its hand and dropped it on the way in. "You have no credits" told a member 25.00 credits
 * overdrawn to top up the price of a slot, which would not have bought them one: they must
 * clear the hole first. The two sentences differ only in their first clause, because the rest
 * of the banner — what a slot costs, and the fact that the cells still work — is identical
 * either way.
 * </p>
 *
 * <p>
 * The rounding case is the product's usual one, decided on the number the member can SEE.
 * −0.001 renders as "0.00", so it is an empty wallet and not a debt; taking `toFixed(2)` first
 * is also what stops "-0.00 cr" reaching the screen.
 * </p>
 */
export function emptyWalletSentence(balanceCredits: number | null, cheapestSliceCredits: number | null): string {
  const cost = cheapestSliceCredits !== null
    ? ` A slot here costs ${formatCredits(cheapestSliceCredits)}.`
    : "";
  // `null` is UNKNOWN and never reaches here — `walletTone` answers "fine" for it — but it is
  // read as "not a debt" rather than trusted not to arrive.
  const shown = balanceCredits === null ? 0 : Number(balanceCredits.toFixed(2));
  if (shown < 0) return `You owe ${formatCredits(Math.abs(shown))}, so you can't book yet.${cost}`;
  return `You have no credits, so you can't book yet.${cost}`;
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

