import type { LedgerEntryType } from "./api";
import type { WalletTone } from "./balance";
import { firstName, playersWhen } from "./playersCopy";
import { formatCredits } from "./utils";

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

/**
 * D4 — the chip's one toast for a movement this tab did not cause, worded from the stream frame's
 * `reason` rather than always blaming "the club". "The club took 20.00 credits off your wallet"
 * was said to an organiser whose PARTNER had paid them, and about money the club never touched.
 * `share_transfer` gets a named sentence from the ledger where it can be read (see the chip);
 * this is the sentence for every other reason, and the fallback for that one.
 */
export function movementSentence(amount: number, reason: string | undefined): string {
  const credits = `${Math.abs(amount).toFixed(2)} credits`;
  const up = amount > 0;
  switch (reason) {
    case "top_up": return up ? `Your top-up landed: ${credits} are in your wallet.` : `${credits} of a top-up were taken back.`;
    case "booking_charge": return up ? `${credits} came back from a booking.` : `${credits} went on a court booking.`;
    case "cancellation_refund": return `A cancelled booking put ${credits} back in your wallet.`;
    case "penalty": return `${credits} went on a late-cancellation or no-show charge.`;
    case "lights_purchase": return `${credits} went on court time at the box.`;
    case "share_transfer": return up ? `A share of a split booking moved ${credits} into your wallet.` : `${credits} went on a share of a split booking.`;
    case "correction": return up ? `A payment was reversed: ${credits} are back in your wallet.` : `A payment was reversed: ${credits} left your wallet.`;
    default: return up ? `The club added ${credits} to your wallet.` : `The club took ${credits} off your wallet.`;
  }
}

/** Said once under the ledger, not on every row — the same rule the door history follows. */
export const LEDGER_CLOCK_NOTE = "Times are the club's own.";

/** R4 form factor (SPEC 3.4) — the balance rail beside the ledger, and the phone's docked top-up. */
export const WALLET_LAYOUT = {
  railLabel: "Your balance",
  actionsLabel: "Wallet actions",
} as const;

/** The rail's last-30-days figures under the balance (R5 M5-9, SPEC 3.4). */
export const WALLET_MINI_COPY = {
  title: "Last 30 days",
  topUps: "Top-ups",
  spent: "Spent",
  net: "Net",
  readAction: "read the last 30 days",
  failed: "Couldn't read the last 30 days.",
  offline: "The last 30 days need a connection.",
  retry: "Try again",
  more: "See activity",
} as const;

/* ─────────────────────────────── held credits (D11 §3a) ─────────────────────────────── */

/** Under the held line on the wallet card: the figure every spend decision reads. */
export function spendableLine(spendable: number): string {
  // P11: owing partners more than the balance makes spendable negative. "You can spend −4.00 cr"
  // reads as a debt the member can spend; the honest sentence is nothing, and what clears it.
  if (spendable < 0) return `You can spend 0.00 cr until ${formatCredits(-spendable)} more comes in`;
  return `You can spend ${formatCredits(spendable)}`;
}

/**
 * F4-18 (C4) — each held part with its own release: "25.00 cr until Fri 2 Oct, 06:45 · 35.00 cr
 * until Sun 4 Oct, 10:30". Null when there is one part or none, and the single held line stands.
 */
export function heldPartsLine(parts: readonly { credits: number; until: string }[] | undefined, timezone?: string): string | null {
  if (!parts || parts.length < 2) return null;
  return parts.map((p) => `${formatCredits(p.credits)} until ${playersWhen(p.until, timezone)}`).join(" · ");
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
 * Organiser: "Shares for Court 1 · Tue 30 Sep from 2 partners".
 * Partner: "Your share · Court 1 · Tue 30 Sep".
 *
 * <p>
 * D10 — no amount: the line sits in the ledger's own row, whose Amount column already carries
 * the net, and "Your share · Court 1 · Tue 29 Sep: −20.00 cr" beside "−20.00 cr" said it twice.
 * </p>
 */
export function shareGroupSentence(input: ShareGroupInput): string {
  const where = sharePlace(input.place, input.timezone);
  if (input.side === "partner") {
    const own = where ? `Your share · ${where}` : "Your share of a split booking";
    // R1 F2.14 — a share that came back in full nets to 0.00: say why, or it reads as a glitch.
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
  /** D10 — the To column of a partner's share line names the person: "Olivia (organiser)". */
  organiserNamed: (name: string) => `${name} (organiser)`,
  /** The disclosure's state, spoken after the line itself. */
  movements: (n: number) => `${n} movement${n === 1 ? "" : "s"}`,
} as const;

/**
 * R4 M4-2 — the member's running top-up limit. The club caps what one member may put in
 * (`TopupMaxZarPerMember`), and `/credit/topup/options` says how much of it is left; the page
 * offered R500 and R1000 and "Max R1000" to a member with R100 left, and only the POST refused.
 */
export const TOP_UP_LIMIT = {
  /** The limits line when the member has used part of the ceiling. */
  limits: (min: string, remaining: string, already: string, max: string, block: string) =>
    `Min ${min} · Up to ${remaining} more (${already} of your ${max} used) · Multiples of ${block} only`,
  /** An amount above what is left. */
  overRemaining: (remaining: string, max: string) =>
    `You can top up ${remaining} more — the club's limit is ${max} per member.`,
  /** Nothing left at all: the form is not offered. */
  reachedTitle: "You've reached the club's top-up limit",
  reached: (max: string) =>
    `You've topped up ${max}, the most the club takes from one member by card. Speak to the club if you need more credit.`,
} as const;
