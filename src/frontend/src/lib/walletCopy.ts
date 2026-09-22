import type { LedgerEntryType } from "./api";
import type { WalletTone } from "./balance";
import { formatMoney } from "./utils";

/**
 * The wallet's own words, and the one distinction the product kept getting wrong.
 *
 * <p>
 * <b>Zero is not "running low".</b> `lib/balance.walletLabel` has two arms, so a member with
 * exactly R0.00 was told their balance was <i>running low</i> — measured, on a real account,
 * in the same amber as 49.99. It is not low, it is empty: they cannot book anything at all,
 * and the sentence that describes a warning is being used for a stop. Three states, three
 * sentences, and the zero one says what it stops and what fixes it.
 * </p>
 *
 * <p>
 * The chip in the header is the UI lane's; this is the wallet and top-up pages' half. They no
 * longer read one threshold and decide separately — they ask `walletTone` and look the answer
 * up in the tables below, which is what makes "must not drift" a fact rather than an intention.
 * </p>
 *
 * <p>
 * <b>Every amount here goes through `formatMoney`, and these sentences are READ.</b> The chip's
 * `aria-label` is the one wallet string a person only ever HEARS, and it takes `spokenMoney`
 * instead — see `lib/balance.walletLabel`. Nothing in this file composes a unit by hand: that
 * is how six screens each ended up with their own.
 * </p>
 */

/**
 * The three states a balance can be in.
 *
 * <p>
 * The type is {@link WalletTone}, and the RULE that picks between them lives with it in
 * `lib/balance` — one question, asked in one place, because three lanes each answered it and
 * their answers disagreed at a balance of 0.004. What lives here is only what each state SAYS.
 * </p>
 */
export type BalanceLevel = WalletTone;

/**
 * What the wallet card says under the figure.
 *
 * <p>
 * The "zero" sentence names the CONSEQUENCE rather than the number, because the number is
 * already three times its size directly above it. "R0.00" is a fact a member can read; "you
 * can't book a court until you top up" is the thing they came to find out.
 * </p>
 *
 * <p>
 * <b>The "fine" sentence is a conversion boundary in miniature, and it is why it changed.</b>
 * It used to read <i>"Credits are what court time is bought with. Top up in rand and the club
 * converts at your member rate."</i> — a sentence that worked only while the wallet and a card
 * payment wore different units. They now wear the same symbol, so "converts at your member
 * rate" names a conversion that is invisible on this screen and quotes a rate this card cannot
 * show. What must survive is the FACT of the bonus: a club on 1.6 gives 60% more than the
 * member pays, and a member who is never told so has no reason to top up at all. So the
 * sentence states both legs in words — what comes off the card, what lands in the wallet —
 * and sends them to the one screen that carries the figure. This is the rule `currency.ts`
 * imposes, obeyed by a sentence that has no rate in hand.
 * </p>
 */
export const BALANCE_SENTENCE: Record<BalanceLevel, string> = {
  zero: "You can't book a court until you top up.",
  low: "That's enough for a slot or two. Top up before it runs out.",
  fine: "This is what court time is bought with. A top-up adds more to your wallet than it comes to on your card — the top-up screen says how much.",
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
 * <b>Attribution is read off the ledger row, never assumed.</b> "The club added R200.00" is
 * false if the member's partner just cancelled a court in another tab, and this page has no
 * way to know which happened — except that the movement it is announcing has a row, and the
 * row says what it was. Where the row cannot be matched the sentence is the neutral one,
 * which is true whoever caused it.
 * </p>
 *
 * <p>
 * The amount comes from {@link formatMoney}. It used to be composed here as
 * <code>`${amount.toFixed(2)} credits`</code>, which is the whole reason the unit could drift
 * — and the plural it forced ("R200.00 <i>are</i> in your wallet") is wrong now that the
 * amount is one quantity of money rather than a count of things.
 * </p>
 */
export function creditArrivedSentence(amount: number, entryType: LedgerEntryType | null, from: string | null): string {
  const money = formatMoney(amount);
  switch (entryType) {
    case "AdminAdjustment":
      // Named, because "the club" is a building and a member wants to know who to thank — and
      // because an adjustment they did not expect is the one movement worth querying.
      return from
        ? `${from} added ${money} to your wallet.`
        : `The club added ${money} to your wallet.`;
    case "TopUp":
      return `Your top-up landed: ${money} is in your wallet.`;
    case "CancellationRefund":
      return `A cancelled booking put ${money} back in your wallet.`;
    case "PaymentReversal":
      return `A payment was reversed: ${money} is back in your wallet.`;
    default:
      return `Your wallet went up by ${money}.`;
  }
}

/** And the other direction, which is deliberately quieter. See the note in `useWalletLive`. */
export function creditLeftSentence(amount: number, entryType: LedgerEntryType | null): string {
  const money = formatMoney(amount);
  switch (entryType) {
    case "BookingCharge": return `${money} went on a court booking.`;
    case "LightsPurchase": return `${money} went on court time at the box.`;
    case "NoShowPenalty": return `${money} went on a no-show charge.`;
    case "LateCancellationPenalty": return `${money} went on a late-cancellation charge.`;
    default: return `${money} left your wallet.`;
  }
}

/** Said once under the ledger, not on every row — the same rule the door history follows. */
export const LEDGER_CLOCK_NOTE = "Times are the club's own.";
