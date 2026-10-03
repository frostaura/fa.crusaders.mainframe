import type { LedgerEntryType } from "./api";
import { walletTone, type WalletTone } from "./balance";
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
export function movementSentence(amount: number, reason: string | undefined, parts?: readonly MovementPart[]): string {
  const minutes = minutesSpoken(Math.abs(amount));
  const up = amount > 0;
  const precise = reason ? PRECISE_MOVEMENT[reason] : undefined;
  if (precise) return precise({ minutes, up, split: splitParts(parts) });
  // `mixed` without its rows, and anything unknown: true whoever caused it.
  const [rose, fell] = (reason ? BY_REASON[reason] : undefined) ?? NEUTRAL_MOVEMENT;
  return (up ? rose : fell)(minutes);
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

/** One row of a live movement, as the stream's `parts` carry it (`lib/liveBalance.BalancePart`). */
export type MovementPart = { reason: string; delta_minutes: number };

/** What came in and what went out across a movement's rows, in words; null without rows. */
type Split = { back: string; charged: string } | null;

function splitParts(parts: readonly MovementPart[] | undefined): Split {
  if (!parts || parts.length === 0) return null;
  const back = parts.filter((p) => p.delta_minutes > 0).reduce((n, p) => n + p.delta_minutes, 0);
  const charged = -parts.filter((p) => p.delta_minutes < 0).reduce((n, p) => n + p.delta_minutes, 0);
  if (back <= 0 || charged <= 0) return null;
  return { back: minutesSpoken(back), charged: minutesSpoken(charged) };
}

type Said = { minutes: string; up: boolean; split: Split };

/** "so 11 minutes came back" / "so 4 minutes left your wallet" — the net, with its direction in words. */
function net({ minutes, up }: Said): string {
  return up ? `so ${minutes} came back to your wallet` : `so ${minutes} left your wallet`;
}

/** R10 E10-1 — the server's precise causes (BE10 `WalletStreamReasons`). Each says what happened, by sign. */
const PRECISE_MOVEMENT: Record<string, (s: Said) => string> = {
  outage_refund: (s) => s.up
    ? `The court's box was offline, so your booking was refunded: ${s.minutes} back in your wallet.`
    : `${s.minutes} of an outage refund left your wallet.`,
  outage_refund_reversed: (s) => `An outage refund was taken back — you were checked in after all: ${s.minutes} ${s.up ? "came back to" : "left"} your wallet.`,
  no_show_settled: (s) => s.split
    ? `A missed booking was settled: ${s.split.back} refunded and ${s.split.charged} charged as a no-show penalty, ${net(s)}.`
    : s.up ? `A missed booking was refunded: ${s.minutes} back in your wallet.` : `${s.minutes} went on a no-show charge.`,
  no_show_reversed: (s) => s.split
    ? `A no-show was reversed — you were checked in after all: the ${s.split.back} penalty came back and the ${s.split.charged} refund was taken back, ${net(s)}.`
    : `A no-show was reversed — you were checked in after all: ${s.minutes} ${s.up ? "came back to" : "left"} your wallet.`,
  pay_for_refund: (s) => s.up
    ? `Another member paid for your booking at the court, so its ${s.minutes} came back to your wallet.`
    : `${s.minutes} of a pay-at-court refund left your wallet.`,
  pay_for_charge: (s) => s.up
    ? `${s.minutes} came back from a court you paid for at the box.`
    : `${s.minutes} went on another member's court, paid at the box.`,
  displaced_refund: (s) => s.up
    ? `A booking was refunded — its court was already in use by an earlier game: ${s.minutes} back in your wallet.`
    : `${s.minutes} of a refund were taken back.`,
  // A refund and a charge in one move (a cancellation inside the penalty window, say): both, then the net.
  mixed: (s) => s.split
    ? `${s.split.back} came back and ${s.split.charged} went on a charge, ${net(s)}.`
    : s.up ? `Your wallet went up by ${s.minutes}.` : `${s.minutes} left your wallet.`,
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

function courtOf(place: SharePlace): string {
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
 * Organiser: "Shares for Court 1 · Tue 30 Sep from 2 partners".
 * Partner: "Your share · Court 1 · Tue 30 Sep".
 *
 * <p>
 * D10 — no amount: the line sits in the ledger's own row, whose Amount column already carries
 * the net, and "Your share · Court 1 · Tue 29 Sep: −20 min" beside "−20 min" said it twice.
 * </p>
 */
export function shareGroupSentence(input: ShareGroupInput): string {
  const where = sharePlace(input.place, input.timezone);
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

export type ShareRowInput = {
  side: "organiser" | "partner";
  signed: number;
  place: SharePlace;
  /** The other person on this movement — the organiser for a partner, a partner for the organiser. */
  other: string | null;
};

/**
 * One share movement, as a sentence. "25 min moved to Nomsa for your share of Court 1".
 * Nobody owes anybody: a partner's share MOVES, and a returned one COMES BACK.
 */
export function shareRowSentence(input: ShareRowInput): string {
  const amount = minutesSpoken(Math.abs(input.signed));
  const court = courtOf(input.place);
  const who = input.other ? firstName(input.other) : null;
  if (input.side === "partner") {
    if (input.signed < 0) return `${amount} moved to ${who ?? "the organiser"} for your share of ${court}`;
    return `${amount} of your share of ${court} came back${who ? ` from ${who}` : ""}`;
  }
  if (input.signed >= 0) return `${who ?? "A partner"} paid you ${amount} for their share of ${court}`;
  return `${amount} went back to ${who ?? "a partner"} from their share of ${court}`;
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
