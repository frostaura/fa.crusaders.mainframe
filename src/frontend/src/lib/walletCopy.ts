import type { LedgerEntryType } from "./api";
import type { WalletTone } from "./balance";
import { firstName, playersWhen } from "./playersCopy";
import { formatCredits, formatSignedCredits } from "./utils";

/**
 * The wallet's own words, and the one distinction the product kept getting wrong.
 *
 * <p>
 * <b>Zero is not "running low".</b> `lib/balance.walletLabel` has two arms, so a member with
 * exactly 0.00 credits was told their balance was <i>running low</i> — measured, on a real
 * account, in the same amber as 49.99. It is not low, it is empty: they cannot book anything
 * at all, and the sentence that describes a warning is being used for a stop. Three states,
 * three sentences, and the zero one says what it stops and what fixes it.
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
 * their answers disagreed at 0.004 credits. What lives here is only what each state SAYS.
 * </p>
 */
export type BalanceLevel = WalletTone;

/**
 * What the wallet card says under the figure.
 *
 * <p>
 * The "zero" sentence names the CONSEQUENCE rather than the number, because the number is
 * already three times its size directly above it. "0.00 credits" is a fact a member can read;
 * "you can't book a court until you top up" is the thing they came to find out.
 * </p>
 */
export const BALANCE_SENTENCE: Record<BalanceLevel, string> = {
  zero: "You can't book a court until you top up.",
  low: "That's enough for a slot or two. Top up before it runs out.",
  fine: "Credits are what court time is bought with. Top up in rand and the club converts at your member rate.",
};

/** The tone each state is drawn in. Existing token pairs, every one already measured. */
export const BALANCE_TONE: Record<BalanceLevel, { fill: string; ink: string }> = {
  // danger, not warning. Amber for 0.00 and amber for 49.99 is the defect: one of those is a
  // caution and the other is a stop, and colour was the only thing distinguishing them from
  // a comfortable balance at all.
  zero: { fill: "bg-danger-soft", ink: "text-danger-strong" },
  low: { fill: "bg-warning-soft", ink: "text-warning-strong" },
  fine: { fill: "bg-bg-muted", ink: "text-text-secondary" },
};

/** The top-up control's own label, which changes with the state because the errand does. */
export const TOP_UP_LABEL: Record<BalanceLevel, string> = {
  zero: "Top up to start booking",
  low: "Top up",
  fine: "Top up",
};

/**
 * What a member is told when money arrives while they are looking at the screen.
 *
 * <p>
 * <b>A number silently changing in a corner is not an event anybody notices</b>, and for a
 * screen-reader user it is not an event at all: a rendered figure is not a live region, and
 * nothing announces it. GOAL item 8 is really about this moment — an admin credits a member
 * at the desk while the member watches their phone — so it gets one announcement, with the
 * amount in it, and the amount is the one the ledger recorded rather than a subtraction.
 * </p>
 *
 * <p>
 * <b>Attribution is read off the ledger row, never assumed.</b> "The club added 200 credits"
 * is false if the member's partner just cancelled a court in another tab, and this page has
 * no way to know which happened — except that the movement it is announcing has a row, and
 * the row says what it was. Where the row cannot be matched the sentence is the neutral one,
 * which is true whoever caused it.
 * </p>
 */
export function creditArrivedSentence(amount: number, entryType: LedgerEntryType | null, from: string | null): string {
  const credits = `${amount.toFixed(2)} credits`;
  switch (entryType) {
    case "AdminAdjustment":
      // Named, because "the club" is a building and a member wants to know who to thank — and
      // because an adjustment they did not expect is the one movement worth querying.
      return from
        ? `${from} added ${credits} to your wallet.`
        : `The club added ${credits} to your wallet.`;
    case "TopUp":
      return `Your top-up landed: ${credits} are in your wallet.`;
    case "CancellationRefund":
      return `A cancelled booking put ${credits} back in your wallet.`;
    case "PaymentReversal":
      return `A payment was reversed: ${credits} are back in your wallet.`;
    case "ShareTransfer":
      // Either a partner paid their share or a share of the member's own came back; both are
      // shares, and "held" is said on the card, not squeezed into a toast.
      return `A share of a split booking moved ${credits} into your wallet.`;
    default:
      return `Your wallet went up by ${credits}.`;
  }
}

/** And the other direction, which is deliberately quieter. See the note in `useWalletLive`. */
export function creditLeftSentence(amount: number, entryType: LedgerEntryType | null): string {
  const credits = `${amount.toFixed(2)} credits`;
  switch (entryType) {
    case "BookingCharge": return `${credits} went on a court booking.`;
    case "LightsPurchase": return `${credits} went on court time at the box.`;
    case "NoShowPenalty": return `${credits} went on a no-show charge.`;
    case "LateCancellationPenalty": return `${credits} went on a late-cancellation charge.`;
    case "ShareTransfer": return `${credits} went on a share of a split booking.`;
    default: return `${credits} left your wallet.`;
  }
}

/** Said once under the ledger, not on every row — the same rule the door history follows. */
export const LEDGER_CLOCK_NOTE = "Times are the club's own.";

/* ─────────────────────────────── held credits (D11 §3a) ─────────────────────────────── */

/** Under the held line on the wallet card: the figure every spend decision reads. */
export function spendableLine(spendable: number): string {
  // P11: owing partners more than the balance makes spendable negative. "You can spend −4.00 cr"
  // reads as a debt the member can spend; the honest sentence is nothing, and what clears it.
  if (spendable < 0) return `You can spend 0.00 cr until ${formatCredits(-spendable)} more comes in`;
  return `You can spend ${formatCredits(spendable)}`;
}

/** The chip's hover title when part of the balance is held or owed back to partners. */
export function chipHeldTitle(held: number, owedBack = 0): string {
  const parts = [
    held > 0 ? `${formatCredits(held)} of it held for partners` : null,
    owedBack > 0 ? `${formatCredits(owedBack)} owed back to partners` : null,
  ].filter(Boolean);
  return `Wallet balance — ${parts.join(", ")}. Tap to top up.`;
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
 * Organiser: "Shares for Court 1 · Tue 30 Sep: +50.00 cr from 2 partners".
 * Partner: "Your share · Court 1 · Tue 30 Sep: −25.00 cr".
 */
export function shareGroupSentence(input: ShareGroupInput): string {
  const where = sharePlace(input.place, input.timezone);
  const amount = formatSignedCredits(input.net);
  if (input.side === "partner") {
    return where ? `Your share · ${where}: ${amount}` : `Your share of a split booking: ${amount}`;
  }
  const head = where ? `Shares for ${where}` : "Shares for a split booking";
  if (input.net === 0) return `${head}: ${amount} — paid and returned`;
  if (input.partners === null || input.partners === 0) return `${head}: ${amount}`;
  return `${head}: ${amount} from ${input.partners} partner${input.partners === 1 ? "" : "s"}`;
}

export type ShareRowInput = {
  side: "organiser" | "partner";
  signed: number;
  place: SharePlace;
  /** The other person on this movement — the organiser for a partner, a partner for the organiser. */
  other: string | null;
};

/**
 * One share movement, as a sentence. "25.00 cr moved to Nomsa for your share of Court 1".
 * Nobody owes anybody: a partner's share MOVES, and a returned one COMES BACK.
 */
export function shareRowSentence(input: ShareRowInput): string {
  const amount = formatCredits(Math.abs(input.signed));
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
  /** The disclosure's state, spoken after the line itself. */
  movements: (n: number) => `${n} movement${n === 1 ? "" : "s"}`,
} as const;
