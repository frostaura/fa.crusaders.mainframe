import type { LedgerEntryType } from "./api";
import { walletTone, type WalletTone } from "./walletTone";
import { firstName, playersWhen } from "./playersNames";
import { minutesSpoken } from "./minutes";

/**
 * The wallet's own words, and the one distinction the product kept getting wrong.
 *
 * <p>
 * <b>Zero is not "running low".</b> `lib/balance.walletLabel` once had two arms, so a member
 * with an empty wallet was told their balance was <i>running low</i>, in the same amber as a
 * nearly-empty one. It is not low, it is empty: they cannot book anything at all. Three states,
 * three sentences, and the zero one says what it stops and what fixes it.
 * </p>
 *
 * <p>
 * P13: every amount here is whole minutes, written through `lib/minutes` ("45 min",
 * "1 h 30 min") and never as a decimal; the verb for getting more is "buy", never "top up".
 * </p>
 *
 * <p>
 * The chip in the header is the UI lane's; this is the wallet and top-up pages' half. They no
 * longer read one threshold and decide separately — they ask `walletTone` and look the answer
 * up in the tables below, which is what makes "must not drift" a fact rather than an intention.
 * </p>
 */

/**
 * The three states a balance can be in.
 *
 * <p>
 * The type is {@link WalletTone}, and the RULE that picks between them lives with it in
 * `lib/balance` — one question, asked in one place, because three lanes each answered it and
 * their answers disagreed. What lives here is only what each state SAYS.
 * </p>
 */
export type BalanceLevel = WalletTone;

/**
 * What the wallet card says under the figure.
 *
 * <p>
 * The "zero" sentence names the CONSEQUENCE rather than the number, because the number is
 * already three times its size directly above it. "0 min" is a fact a member can read;
 * "you can't book a court until you buy minutes" is the thing they came to find out.
 * </p>
 */
export const BALANCE_SENTENCE: Record<BalanceLevel, string> = {
  zero: "You can't book a court until you buy minutes.",
  low: "That's enough for a short game. Buy more before it runs out.",
  fine: "Court time is paid in minutes — a booking costs exactly its length. Buy a package in rand whenever you need more.",
};

/** The tone each state is drawn in. Existing token pairs, every one already measured. */
export const BALANCE_TONE: Record<BalanceLevel, { fill: string; ink: string }> = {
  // danger, not warning. Amber for empty and amber for nearly empty is the defect: one is a
  // caution and the other is a stop, and colour was the only thing distinguishing them from
  // a comfortable balance at all.
  zero: { fill: "bg-danger-soft", ink: "text-danger-strong" },
  low: { fill: "bg-warning-soft", ink: "text-warning-strong" },
  fine: { fill: "bg-bg-muted", ink: "text-text-secondary" },
};

/** The buy control's own label, which changes with the state because the errand does. */
export const TOP_UP_LABEL: Record<BalanceLevel, string> = {
  zero: "Buy minutes to start booking",
  low: "Buy minutes",
  fine: "Buy minutes",
};

/**
 * R10 J10-3 — the Wallet card's state: the three tones, plus `short` — something to spend, but
 * less than the shortest court the club books. The card said "That's enough for a short game"
 * over 10 minutes in a club of 15-minute slots, and over a WHOLE balance whose spendable part was
 * −2 (held for partners) while the chip beside it was red. Read off SPENDABLE, like the chip.
 */
export type CardLevel = BalanceLevel | "short";

/** The card's state from what the member can spend and the club's shortest booking (null: not known). */
export function cardLevel(spendable: number | null, smallestSlot: number | null): CardLevel {
  const tone = walletTone(spendable);
  if (tone === "zero" || spendable === null || smallestSlot === null) return tone;
  return Math.trunc(spendable) < smallestSlot ? "short" : tone;
}

/** The card's sentence: the three fixed ones, or what is short of a court and by how much. */
export function balanceSentence(level: CardLevel, spendable: number | null, smallestSlot: number | null): string {
  if (level !== "short" || spendable === null || smallestSlot === null) return BALANCE_SENTENCE[level === "short" ? "low" : level];
  return `You can't book a court with ${minutesSpoken(Math.trunc(spendable))} — the shortest booking is ${minutesSpoken(smallestSlot)}. Buy minutes to book.`;
}

/** `short` is drawn as a caution (the chip's amber) and its buy control is the primary one. */
export const SHORT_TONE = { fill: "bg-warning-soft", ink: "text-warning-strong" } as const;

/**
 * What a member is told when minutes arrive while they are looking at the screen.
 *
 * <p>
 * <b>A number silently changing in a corner is not an event anybody notices</b>, and for a
 * screen-reader user it is not an event at all: a rendered figure is not a live region. An admin
 * selling a member a package at the desk while the member watches their phone gets one
 * announcement, with the amount in it, and the amount is the one the ledger recorded.
 * </p>
 *
 * <p>
 * <b>Attribution is read off the ledger row, never assumed.</b> "The club added 1 h" is false if
 * the member's partner just cancelled a court in another tab. Where the row cannot be matched
 * the sentence is the neutral one, which is true whoever caused it.
 * </p>
 */
export function minutesArrivedSentence(amount: number, entryType: LedgerEntryType | null, from: string | null): string {
  const minutes = minutesSpoken(amount);
  switch (entryType) {
    case "AdminAdjustment":
      // Named, because "the club" is a building and a member wants to know who to thank — and
      // because an adjustment they did not expect is the one movement worth querying.
      return from ? `${from} added ${minutes} to your wallet.` : `The club added ${minutes} to your wallet.`;
    case "AdminTopUp":
      return `Your package from the desk landed: ${minutes} added to your wallet.`;
    case "TopUp":
      return `Your purchase landed: ${minutes} added to your wallet.`;
    case "CancellationRefund":
      return `A cancelled booking put ${minutes} back in your wallet.`;
    case "PaymentReversal":
      return `A payment was reversed: ${minutes} back in your wallet.`;
    case "ShareTransfer":
      // Either a partner paid their share or a share of the member's own came back.
      return `A share of a split booking moved ${minutes} into your wallet.`;
    default:
      return `Your wallet went up by ${minutes}.`;
  }
}

/** And the other direction, which is deliberately quieter. See the note in `useWalletLive`. */
export function minutesLeftSentence(amount: number, entryType: LedgerEntryType | null): string {
  const minutes = minutesSpoken(amount);
  switch (entryType) {
    case "BookingCharge": return `${minutes} went on a court booking.`;
    case "LightsPurchase": return `${minutes} went on court time at the box.`;
    case "NoShowPenalty": return `${minutes} went on a no-show charge.`;
    case "LateCancellationPenalty": return `${minutes} went on a late-cancellation charge.`;
    case "ShareTransfer": return `${minutes} went on a share of a split booking.`;
    default: return `${minutes} left your wallet.`;
  }
}

/**
 * D4 — the chip's one toast for a movement this tab did not cause, worded from the stream frame's
 * `reason` rather than always blaming "the club". `share_transfer` gets a named sentence from the
 * ledger where it can be read (see the chip); this is the sentence for every other reason, and
 * the fallback for that one.
 *
 * <p>
 * <b>R10 E10-1 — the sign and the cause, never a guess.</b> An outage refund, its reversal (a
 * MINUS), a pay-for refund and a no-show's refund-and-penalty all arrived as
 * `cancellation_refund` / `mixed`, and the toast said "A cancelled booking put 15 minutes back"
 * for a booking nobody cancelled — and "The club added 11 minutes" in green for a no-show that
 * took a penalty. The server now names the cause (`outage_refund`, `no_show_settled`, …) and
 * carries each row (`parts`); a frame from an older API is worded by its sign alone.
 * </p>
 */
export function movementSentence(amount: number, reason: string | undefined, parts?: readonly MovementPart[], who: MovementWho = {}): string {
  const minutes = minutesSpoken(Math.abs(amount));
  const up = amount > 0;
  const said: Said = {
    minutes, up, split: splitParts(parts), by: who.checkedInBy, where: sharePlace(who.place), whereAt: placeAt(who.place), other: namedOther(parts),
  };
  const caused = reason ? causedSentence(reason, said, parts, who) : null;
  if (caused) return caused;
  // `mixed` without its rows, and anything unknown: true whoever caused it.
  const [rose, fell] = (reason ? BY_REASON[reason] : undefined) ?? NEUTRAL_MOVEMENT;
  return (up ? rose : fell)(minutes);
}

/** A cancellation said once (C1), a settlement with its partners' shares (C13-2), or a precise cause; null for none. */
function causedSentence(reason: string, said: Said, parts: readonly MovementPart[] | undefined, who: MovementWho): string | null {
  const club = who.cancelledBy === "club";
  const rows = parts ?? [];
  // R14 E14-7 — a cancel the frame places ("on Court 3 · Mon 5 Oct") is said with its place.
  if (reason === "cancellation_refund" && (club || rows.length > 1 || said.where)) return cancelSentence(said, parts, club);
  // R14 J14-4 — a late cancel of a split booking comes as `mixed`: its partners' shares went back
  // to them, they are not the penalty ("11 minutes went on a charge" for a 4-minute penalty).
  if (reason === "mixed" && rows.some((p) => p.delta_minutes > 0) && rows.some((p) => p.reason === "share_transfer" && p.delta_minutes < 0)) {
    return cancelSentence(said, parts, club);
  }
  const precise = PRECISE_MOVEMENT[reason];
  return settledWithShares(reason, said, parts ?? []) ?? (precise ? precise(said) : null);
}

type Say = (minutes: string) => string;

/** Neither a cause nor a guess at one — the sentence for a reason this build does not know. */
const NEUTRAL_MOVEMENT: readonly [Say, Say] = [(m) => `Your wallet went up by ${m}.`, (m) => `${m} left your wallet.`];

/** The per-type reasons, each worded by its sign: [minutes in, minutes out]. */
const BY_REASON: Record<string, readonly [Say, Say]> = {
  top_up: [(m) => `Your purchase landed: ${m} added to your wallet.`, (m) => `${m} of a purchase were taken back.`],
  admin_top_up: [(m) => `Your package from the desk landed: ${m} added to your wallet.`, (m) => `The club took ${m} off your wallet.`],
  booking_charge: [(m) => `${m} came back from a booking.`, (m) => `${m} went on a court booking.`],
  cancellation_refund: [(m) => `A cancelled booking put ${m} back in your wallet.`, (m) => `${m} of a refund were taken back.`],
  penalty: [(m) => `A charge was returned: ${m} back in your wallet.`, (m) => `${m} went on a late-cancellation or no-show charge.`],
  lights_purchase: [(m) => `${m} came back from court time at the box.`, (m) => `${m} went on court time at the box.`],
  share_transfer: [(m) => `A share of a split booking moved ${m} into your wallet.`, (m) => `${m} went on a share of a split booking.`],
  correction: [(m) => `A payment was reversed: ${m} back in your wallet.`, (m) => `A payment was reversed: ${m} left your wallet.`],
  admin_adjustment: [(m) => `The club added ${m} to your wallet.`, (m) => `The club took ${m} off your wallet.`],
};

/** R12 contracts C1 / C2 — who cancelled, and who checked in (absent: this member, or not said). */
export type MovementWho = {
  cancelledBy?: "club" | "member"; checkedInBy?: string;
  /** R14 E14-7 — the booking the frame names (`court_name` + `booking_starts_at`): "on Court 3 · Mon 5 Oct". */
  place?: SharePlace;
};

/**
 * R12 X12-1 — a cancellation said once, whoever's rows it moved: the refund, the partners' shares
 * that went back to them, any charge kept — then the net. "The club cancelled your booking: 30
 * minutes came back, 15 minutes went back to your partners for their shares, so 15 minutes came
 * back to your wallet." Worded by the club when `cancelled_by` says so.
 *
 * <p>
 * R13 X13-2 — each partner by name, as the organiser's own cancel sheet names them ("Back to
 * Sam"), from the share row's `counterparty_name`; one partner is one share, never "your partners
 * … their shares". Without names on the wire: "your partner" / "your 2 partners".
 * </p>
 */
function cancelSentence(s: Said, parts: readonly MovementPart[] | undefined, club: boolean): string {
  const on = s.where ? ` on ${s.where}` : "";
  const lead = club ? `The club cancelled your booking${on}` : `Your booking${on} was cancelled`;
  const rows = parts ?? [];
  const back = rows.filter((p) => p.delta_minutes > 0).reduce((n, p) => n + p.delta_minutes, 0);
  const shareRows = rows.filter((p) => p.delta_minutes < 0 && p.reason === "share_transfer");
  const shares = -shareRows.reduce((n, p) => n + p.delta_minutes, 0);
  const charged = -rows.filter((p) => p.delta_minutes < 0 && p.reason !== "share_transfer").reduce((n, p) => n + p.delta_minutes, 0);
  if (back <= 0 || shares + charged <= 0) return `${lead}: ${s.minutes} ${s.up ? "back in your wallet" : "left your wallet"}.`;
  const clauses = [
    `${minutesSpoken(back)} came back`,
    ...(shares > 0 ? [sharesBackClause(shareRows, shares)] : []),
    ...(charged > 0 ? [`${minutesSpoken(charged)} went on a late-cancellation charge`] : []),
  ];
  return `${lead}: ${clauses.join(", ")}, ${net(s)}.`;
}

/**
 * R13 X13-2 — "7 minutes went back to Sam for their share" / "7 minutes went back to Sam and 7
 * minutes to Nomsa for their shares"; unnamed, "… to your partner for their share" / "… to your 2
 * partners for their shares". Two rows for one partner are one figure.
 */
function sharesBackClause(rows: readonly MovementPart[], total: number): string {
  const each = namedFigures(rows);
  if (!each) {
    const one = rows.length === 1;
    return `${minutesSpoken(total)} went back to ${one ? "your partner" : `your ${rows.length} partners`} for their share${one ? "" : "s"}`;
  }
  const said = each.map(([who, n], i) => `${minutesSpoken(n)}${i === 0 ? " went back" : ""} to ${who}`);
  return `${listed(said)} for their share${each.length === 1 ? "" : "s"}`;
}

/**
 * R13 E13-5 — shares paid to the organiser again (a late check-in reversed the return): "7 minutes
 * came back from Sam for their share" / "… from your partner …" / "… from your 2 partners for their shares".
 */
function sharesFromClause(rows: readonly MovementPart[], total: number): string {
  const each = namedFigures(rows);
  if (!each) {
    const one = rows.length === 1;
    return `${minutesSpoken(total)} came back from ${one ? "your partner" : `your ${rows.length} partners`} for their share${one ? "" : "s"}`;
  }
  const said = each.map(([who, n], i) => `${minutesSpoken(n)}${i === 0 ? " came back" : ""} from ${who}`);
  return `${listed(said)} for their share${each.length === 1 ? "" : "s"}`;
}

/** Each named partner's first name and the minutes on their rows (unsigned); null when any row is unnamed. */
function namedFigures(rows: readonly MovementPart[]): [string, number][] | null {
  if (!rows.every((p) => typeof p.counterparty_name === "string" && p.counterparty_name.trim() !== "")) return null;
  const byName = new Map<string, number>();
  for (const p of rows) {
    const who = (p.counterparty_name as string).trim();
    byName.set(who, (byName.get(who) ?? 0) + Math.abs(p.delta_minutes));
  }
  return [...byName].map(([who, n]) => [firstName(who), n]);
}

/** R15 E15-7 — the first name a movement's rows give the other member, or null. */
function namedOther(parts: readonly MovementPart[] | undefined): string | null {
  const name = parts?.find((p) => typeof p.counterparty_name === "string" && p.counterparty_name.trim() !== "")?.counterparty_name?.trim();
  return name && !/^the club$/i.test(name) ? firstName(name) : null;
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  return items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * R13 E13-5 (contract C13-2) — a sweep or a late reversal on a SHARED booking is one frame: the
 * settlement's own rows, then each partner's share row. The share rows are neither the penalty nor
 * the refund (the no-show sweep said "10 minutes charged as a no-show penalty" for a 4-minute
 * penalty and a 6-minute share), so the settlement is worded from its own rows, the shares as what
 * went back to — or came back from — the partners, then the net. Null: no share rows, or a reason
 * that is not a settlement (its own sentence stands).
 */
function settledWithShares(reason: string, s: Said, parts: readonly MovementPart[]): string | null {
  const lead = SETTLED_LEAD[reason];
  const shareRows = parts.filter((p) => p.reason === "share_transfer");
  if (!lead || shareRows.length === 0) return null;
  const own = parts.filter((p) => p.reason !== "share_transfer");
  const ownIn = own.filter((p) => p.delta_minutes > 0).reduce((n, p) => n + p.delta_minutes, 0);
  const ownOut = -own.filter((p) => p.delta_minutes < 0).reduce((n, p) => n + p.delta_minutes, 0);
  const shareNet = shareRows.reduce((n, p) => n + p.delta_minutes, 0);
  const shares = shareNet < 0 ? sharesBackClause(shareRows, -shareNet) : sharesFromClause(shareRows, shareNet);
  return `${lead(s, ownIn, ownOut)}, ${shares}, ${net(s)}.`;
}

/** "the 15 minutes refund was taken back" — a reversal's own leg. */
const takenBack = (n: number) => `the ${minutesSpoken(n)} refund was taken back`;

/** R13 E13-5 — each settlement's words from its OWN rows (in: refunded / penalty back; out: penalty / refund taken). */
const SETTLED_LEAD: Record<string, (s: Said, ownIn: number, ownOut: number) => string> = {
  no_show_settled: (_s, i, o) => (o > 0
    ? `A missed booking was settled: ${minutesSpoken(i)} refunded and ${minutesSpoken(o)} charged as a no-show penalty`
    : `A missed booking was refunded: ${minutesSpoken(i)} came back`),
  outage_refund: (_s, i) => `The court's box was offline, so your booking was refunded: ${minutesSpoken(i)} came back`,
  no_show_reversed: (s, i, o) => `${reversedLead(s, "the no-show was reversed", "A no-show was reversed — you were checked in after all")}: ${
    i > 0 ? `the ${minutesSpoken(i)} penalty came back and ${takenBack(o)}` : takenBack(o)}`,
  outage_refund_reversed: (s, _i, o) => `${reversedLead(s, "the outage refund was taken back", "An outage refund was taken back — you were checked in after all")}: ${takenBack(o)}`,
};

/**
 * One row of a live movement, as the stream's `parts` carry it (`lib/liveBalance.BalancePart`).
 * R13 X13-2 — a share row names the other member on it (`counterparty_name`), where the server says.
 */
export type MovementPart = { reason: string; delta_minutes: number; counterparty_name?: string | null };

/** What came in and what went out across a movement's rows, in words; null without rows. */
type Split = { back: string; charged: string } | null;

function splitParts(parts: readonly MovementPart[] | undefined): Split {
  if (!parts || parts.length === 0) return null;
  const back = parts.filter((p) => p.delta_minutes > 0).reduce((n, p) => n + p.delta_minutes, 0);
  const charged = -parts.filter((p) => p.delta_minutes < 0).reduce((n, p) => n + p.delta_minutes, 0);
  if (back <= 0 || charged <= 0) return null;
  return { back: minutesSpoken(back), charged: minutesSpoken(charged) };
}

/** `by` (R12 E12-2, contract C2): the member whose scan reversed a no-show or an outage refund. */
type Said = {
  minutes: string; up: boolean; split: Split; by?: string;
  /** R14 E14-7 — "Court 3 · Mon 5 Oct", and with the time ("Court 3 · Mon 5 Oct, 18:00"); null when unplaced. */
  where: string | null; whereAt: string | null;
  /** R15 E15-7 — the other member on the rows (`counterparty_name`), first name; null when none is named. */
  other: string | null;
};

/** "Dan Splitter checked in, so …" or this member's own "… — you were checked in after all". */
function reversedLead(s: Said, what: string, own: string): string {
  return s.by ? `${s.by} checked in, so ${what}` : own;
}

/** "so 11 minutes came back" / "so 4 minutes left your wallet" — the net, with its direction in words. */
function net({ minutes, up }: Said): string {
  return up ? `so ${minutes} came back to your wallet` : `so ${minutes} left your wallet`;
}

/** R10 E10-1 — the server's precise causes (BE10 `WalletStreamReasons`). Each says what happened, by sign. */
const PRECISE_MOVEMENT: Record<string, (s: Said) => string> = {
  outage_refund: (s) => s.up
    ? `The court's box was offline, so your booking was refunded: ${s.minutes} back in your wallet.`
    : `${s.minutes} of an outage refund left your wallet.`,
  outage_refund_reversed: (s) => `${reversedLead(s, "the outage refund was taken back", "An outage refund was taken back — you were checked in after all")}: ${s.minutes} ${s.up ? "came back to" : "left"} your wallet.`,
  no_show_settled: (s) => s.split
    ? `A missed booking was settled: ${s.split.back} refunded and ${s.split.charged} charged as a no-show penalty, ${net(s)}.`
    : s.up ? `A missed booking was refunded: ${s.minutes} back in your wallet.` : `${s.minutes} went on a no-show charge.`,
  no_show_reversed: (s) => {
    const lead = reversedLead(s, "the no-show was reversed", "A no-show was reversed — you were checked in after all");
    return s.split
      ? `${lead}: the ${s.split.back} penalty came back and the ${s.split.charged} refund was taken back, ${net(s)}.`
      : `${lead}: ${s.minutes} ${s.up ? "came back to" : "left"} your wallet.`;
  },
  // R15 E15-7 — who paid (or whose court it was), and which court and when, where the frame says.
  pay_for_refund: (s) => s.up
    ? `${s.other ?? "Another member"} paid for your booking${s.whereAt ? ` on ${s.whereAt}` : ""} at the court, so its ${s.minutes} came back to your wallet.`
    : `${s.minutes} of a pay-at-court refund left your wallet.`,
  pay_for_charge: (s) => s.up
    ? `${s.minutes} came back from a court you paid for at the box.`
    : `${s.minutes} went on ${s.other ? `${s.other}'s` : "another member's"} court${s.whereAt ? ` on ${s.whereAt}` : ""}, paid at the box.`,
  displaced_refund: (s) => s.up
    // R14 E14-7 — which booking: the court and the time.
    ? s.whereAt
      ? `Your booking on ${s.whereAt} was refunded — the court was already in use by an earlier game: ${s.minutes} back in your wallet.`
      : `A booking was refunded — its court was already in use by an earlier game: ${s.minutes} back in your wallet.`
    : `${s.minutes} of a refund were taken back.`,
  // A refund and a charge in one move (a cancellation inside the penalty window, say): both, then the net.
  mixed: (s) => s.split
    ? `${s.split.back} came back and ${s.split.charged} went on a charge, ${net(s)}.`
    : s.up ? `Your wallet went up by ${s.minutes}.` : `${s.minutes} left your wallet.`,
  // R14 (BE14b §5) — the club cancelled a session that had started: nothing moved, said with where and when.
  cancelled_no_refund: (s) => `The club cancelled your session${s.whereAt ? ` on ${s.whereAt}` : ""} — it had started, so nothing was refunded.`,
  displaced_reinstated: (s) => s.up
    ? `A booking was reinstated: ${s.minutes} back in your wallet.`
    : `A refunded booking was reinstated: ${s.minutes} went back on it.`,
};

/**
 * R10 E10-6 — a stored ledger reason is the CLUB's sentence ("… — the member was checked in after
 * all"), shown as is on the admin ledger; the member's own wallet says it to them. Only the
 * reasons written in the third person are mapped; every other comment is left exactly as stored.
 */
const MEMBER_VOICE: readonly [RegExp, string][] = [
  [/^Outage refund reversed — the member was checked in after all/, "Outage refund reversed — you were checked in after all"],
];

/** The member's wording of a stored ledger comment. */
export function memberLedgerComment(comment: string): string {
  for (const [said, mine] of MEMBER_VOICE) if (said.test(comment)) return comment.replace(said, mine);
  return comment;
}

/** The wallet's rows with their comments in the member's voice — the same array when nothing changes. */
export function memberLedgerRows<T extends { comment: string }>(rows: T[]): T[] {
  return rows.some((r) => memberLedgerComment(r.comment) !== r.comment)
    ? rows.map((r) => ({ ...r, comment: memberLedgerComment(r.comment) }))
    : rows;
}

/** The ledger's paging button (R14 X14-1: on `usePagedFocus`, like every "show older/more"). */
export const showOlderLabel = (more: number) => `Show older (${more} more)`;

/** Said once under the ledger, not on every row — the same rule the door history follows. */
export const LEDGER_CLOCK_NOTE = "Times are the club's own.";

/** R4 form factor (SPEC 3.4) — the balance rail beside the ledger, and the phone's docked buy button. */
export const WALLET_LAYOUT = {
  railLabel: "Your balance",
  actionsLabel: "Wallet actions",
} as const;

/** The rail's last-30-days figures under the balance (R5 M5-9, SPEC 3.4). */
export const WALLET_MINI_COPY = {
  title: "Last 30 days",
  topUps: "Bought",
  spent: "Spent",
  net: "Net",
  readAction: "read the last 30 days",
  failed: "Couldn't read the last 30 days.",
  offline: "The last 30 days need a connection.",
  retry: "Try again",
  more: "See activity",
} as const;

/* ─────────────────────────────── held minutes (D11 §3a) ─────────────────────────────── */

/** Under the held line on the wallet card: the figure every spend decision reads. */
export function spendableLine(spendable: number): string {
  // P11: owing partners more than the balance makes spendable negative. "You can spend −4 min"
  // reads as a debt the member can spend; the honest sentence is nothing, and what clears it.
  if (spendable < 0) return `You can spend 0 minutes until ${minutesSpoken(-spendable)} more comes in`;
  return `You can spend ${minutesSpoken(spendable)}`;
}

/**
 * F4-18 (C4) — each held part with its own release: "25 min until Fri 2 Oct, 06:45 · 35 min
 * until Sun 4 Oct, 10:30". Null when there is one part or none, and the single held line stands.
 */
export function heldPartsLine(parts: readonly { minutes: number; until: string }[] | undefined, timezone?: string): string | null {
  if (!parts || parts.length < 2) return null;
  return parts.map((p) => `${minutesSpoken(p.minutes)} until ${playersWhen(p.until, timezone)}`).join(" · ");
}

/** The chip's hover title when part of the balance is held or owed back to partners. */
export function chipHeldTitle(held: number, owedBack = 0): string {
  const parts = [
    held > 0 ? `${minutesSpoken(held)} of it held for partners` : null,
    owedBack > 0 ? `${minutesSpoken(owedBack)} owed back to partners` : null,
  ].filter(Boolean);
  return `Wallet balance — ${parts.join(", ")}. Tap to buy minutes.`;
}

/* ─────────────────────────────── shares in the ledger (D11) ─────────────────────────────── */

/** What a share line knows about its booking, when the booking could be read. */
export type SharePlace = { courtName: string | null; startsAt: string } | null | undefined;

/** "Tue 30 Sep" — the game's day, in the club's zone. */
function gameDay(startsAt: string, timezone?: string): string {
  return playersWhen(startsAt, timezone).split(",")[0];
}

/** "Court 1 · Tue 30 Sep", or null when the booking could not be read. */
export function sharePlace(place: SharePlace, timezone?: string): string | null {
  if (!place) return null;
  const court = place.courtName?.trim() || "Court";
  return `${court} · ${gameDay(place.startsAt, timezone)}`;
}

/** "Court 3 · Mon 5 Oct, 18:00" — a place with its time (a displacement says which game). */
function placeAt(place: SharePlace, timezone?: string): string | null {
  if (!place) return null;
  return `${place.courtName?.trim() || "Court"} · ${playersWhen(place.startsAt, timezone)}`;
}

/** The court alone ("Court 1"), or "a split booking" when the booking could not be read. */
export function courtOf(place: SharePlace): string {
  return place?.courtName?.trim() || "a split booking";
}

export type ShareGroupInput = {
  side: "organiser" | "partner";
  net: number;
  place: SharePlace;
  /** How many partners have paid, when the booking could be read. */
  partners: number | null;
  timezone?: string;
};

/**
 * The one line a booking's shares collapse under.
 * Organiser: "Shares for Court 1 · Tue 30 Sep, 18:00 from 2 partners".
 * Partner: "Your share · Court 1 · Tue 30 Sep, 18:00".
 *
 * <p>
 * D10 — no amount: the line sits in the ledger's own row, whose Amount column already carries
 * the net, and "Your share · Court 1 · Tue 29 Sep: −20 min" beside "−20 min" said it twice.
 * </p>
 */
export function shareGroupSentence(input: ShareGroupInput): string {
  // R15 J15-8 — with the start time: two games on one court and day read the same without it.
  const where = placeAt(input.place, input.timezone);
  if (input.side === "partner") {
    const own = where ? `Your share · ${where}` : "Your share of a split booking";
    // R1 F2.14 — a share that came back in full nets to nothing: say why, or it reads as a glitch.
    return input.net === 0 ? `${own} — paid and returned` : own;
  }
  const head = where ? `Shares for ${where}` : "Shares for a split booking";
  if (input.net === 0) return `${head} — paid and returned`;
  if (input.partners === null || input.partners === 0) return head;
  return `${head} from ${input.partners} partner${input.partners === 1 ? "" : "s"}`;
}

export const SHARE_LEDGER_COPY = {
  viewBooking: "View booking",
  partners: "Partners",
  organiser: "Organiser",
  /** D10 — the To column of a partner's share line names the person: "Olivia (organiser)". */
  organiserNamed: (name: string) => `${name} (organiser)`,
  /** The disclosure's state, spoken after the line itself. */
  movements: (n: number) => `${n} movement${n === 1 ? "" : "s"}`,
} as const;
