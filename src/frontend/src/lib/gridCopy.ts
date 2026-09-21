import { formatCredits } from "./utils";

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

/** The word a cell wears. Short enough for a 120 px column at a 32 px root font. */
export const CELL_WORD = {
  available: "Available",
  past: "PAST",
  closed: "Closed",
  full: "Full",
  hold: "Club hold",
} as const;

const WEEKDAYS: Record<string, string> = {
  sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday",
  thu: "Thursday", fri: "Friday", sat: "Saturday",
};

/** "Monday" from a `YYYY-MM-DD`, in the club's own spelling, never the reader's locale. */
export function weekdayName(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return "that day";
  // Date-only arithmetic: a calendar date has a weekday with no instant and no zone in it.
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" })
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

/** The word on a quota-locked cell's accessible name. */
export function quotaCellLabel(where: string, maxSlots: number): string {
  return `${where} — you've booked your ${maxSlots} ${maxSlots === 1 ? "slot" : "slots"} for today`;
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
export function quotaPill(booked: number, maxSlots: number): string {
  return `${booked} of ${maxSlots} today`;
}

/** The minutes cap, when it — and not the slot cap — is the rule that bound. */
export function minuteQuotaBannerTitle(maxMinutes: number, day: string): string {
  return `You've booked your ${maxMinutes} minutes of court time for ${weekdayName(day)}.`;
}

/* ─────────────────────────── Item 3 — groups, on the member's grid ─────────────────────────── */

/** The short word a restricted cell wears. Never a code, never a group's internal name. */
export function restrictionLabel(reason: string, windows: readonly { start: string; end: string }[]): string {
  if (reason === "peak_league_only") return "League only";
  if (reason === "no_bookable_window") return "Not yours";
  const next = windows[0];
  return next ? `From ${next.start}` : "Not your hours";
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

/** The DayBar's quiet line when the viewer's price is their group's rather than the court's. */
export function groupRateLine(groups: readonly { name: string }[]): string | null {
  const first = groups[0]?.name;
  return first ? `You're booking as a ${withoutTrailingPlural(first).toLowerCase()}.` : null;
}

/** What the "(your rate)" affordance says when it is pressed. */
export function groupRateSentence(groups: readonly { name: string }[], priceCredits: number, sliceMinutes: number): string {
  const first = groups[0]?.name;
  const who = first ? `You're a ${withoutTrailingPlural(first).toLowerCase()}.` : "This is your rate.";
  return `${who} You pay ${formatCredits(priceCredits)} for ${sliceMinutes} minutes on this court.`;
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
 */
export function emptyWalletSentence(cheapestSliceCredits: number | null): string {
  const cost = cheapestSliceCredits !== null
    ? ` A slot here costs ${formatCredits(cheapestSliceCredits)}.`
    : "";
  return `You have no credits, so you can't book yet.${cost}`;
}

/* ─────────────────────────── The past wall ─────────────────────────── */

/**
 * D4 §7.4. The past rows are not deleted — `gridWindow`'s own comment records the member who
 * was sold 03:00 on a Sunday and could see it on no screen in the product — they are collapsed
 * behind one row that says what is inside it.
 */
export function earlierSummary(rows: number, mine: number, from: string, to: string): string {
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

/** "League members" → "League member", so a sentence can say "you're a league member". */
function withoutTrailingPlural(name: string): string {
  return name.endsWith("s") ? name.slice(0, -1) : name;
}
