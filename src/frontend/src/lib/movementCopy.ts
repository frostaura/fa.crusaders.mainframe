import { firstName } from "./playersNames";
import { minutesSpoken } from "./minutes";
import { placeAt, plainMovementSentence, sharePlace, type MovementPart, type MovementWho } from "./walletCopy";

/**
 * The chip's precise money sentences — a movement this tab did not cause, said with its cause, its
 * booking and the people on it. NOT in the entry chunk (R16): the chip loads this module with the
 * first frame it has to say, and says `plainMovementSentence` if it cannot be fetched. Never import
 * it from `walletCopy` or anything `main.tsx` imports statically.
 */

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
  // `mixed` without its rows, and anything unknown: true whoever caused it.
  return caused ?? plainMovementSentence(amount, reason);
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
  no_show_settled: (s, i, o) => (o > 0
    ? `${missed(s)} was settled: ${minutesSpoken(i)} refunded and ${minutesSpoken(o)} charged as a no-show penalty`
    : `${missed(s)} was refunded: ${minutesSpoken(i)} came back`),
  outage_refund: (_s, i) => `The court's box was offline, so your booking was refunded: ${minutesSpoken(i)} came back`,
  no_show_reversed: (s, i, o) => `${noShowReversedLead(s)}: ${
    i > 0 ? `the ${minutesSpoken(i)} penalty came back and ${takenBack(o)}` : takenBack(o)}`,
  outage_refund_reversed: (s, _i, o) => `${reversedLead(s, "the outage refund was taken back", "An outage refund was taken back — you were checked in after all")}: ${takenBack(o)}`,
};

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

/**
 * R16 J16-4 — a toast stands alone, so a no-show's says which booking when the frame places it:
 * "Your missed booking on Court 2 · Mon 5 Oct, 18:30" / "A missed booking" unplaced.
 */
function missed(s: Said): string {
  return s.whereAt ? `Your missed booking on ${s.whereAt}` : "A missed booking";
}

/** R16 J16-4 — "The no-show on Court 2 · … was reversed — you were checked in after all" / "Dan checked in on …, so …". */
function noShowReversedLead(s: Said): string {
  if (!s.whereAt) return reversedLead(s, "the no-show was reversed", "A no-show was reversed — you were checked in after all");
  return s.by ? `${s.by} checked in on ${s.whereAt}, so the no-show was reversed` : `The no-show on ${s.whereAt} was reversed — you were checked in after all`;
}

/** R16 J16-4 — "Your booking on Court 2 · Mon 5 Oct, 18:30: " before a placed sentence; nothing unplaced. */
function onBooking(s: Said): string {
  return s.whereAt ? `Your booking on ${s.whereAt}: ` : "";
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
    ? `${missed(s)} was settled: ${s.split.back} refunded and ${s.split.charged} charged as a no-show penalty, ${net(s)}.`
    : s.up ? `${missed(s)} was refunded: ${s.minutes} back in your wallet.`
      : `${s.minutes} went on a no-show charge${s.whereAt ? ` for your missed booking on ${s.whereAt}` : ""}.`,
  no_show_reversed: (s) => {
    const lead = noShowReversedLead(s);
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
    // R16 E16-4 — whose BOOKING it was ("Oona's court on Court 2" said "court" twice).
    : `${s.minutes} went on ${s.other ? `${s.other}'s` : "another member's"} booking${s.whereAt ? ` on ${s.whereAt}` : ""}, paid at the box.`,
  displaced_refund: (s) => s.up
    // R14 E14-7 — which booking: the court and the time.
    ? s.whereAt
      ? `Your booking on ${s.whereAt} was refunded — the court was already in use by an earlier game: ${s.minutes} back in your wallet.`
      : `A booking was refunded — its court was already in use by an earlier game: ${s.minutes} back in your wallet.`
    : `${s.minutes} of a refund were taken back.`,
  // A refund and a charge in one move (a cancellation inside the penalty window, say): both, then the net.
  mixed: (s) => s.split
    ? `${onBooking(s)}${s.split.back} came back and ${s.split.charged} went on a charge, ${net(s)}.`
    : s.up ? `Your wallet went up by ${s.minutes}.` : `${s.minutes} left your wallet.`,
  // R14 (BE14b §5) — the club cancelled a session that had started: nothing moved, said with where and when.
  cancelled_no_refund: (s) => `The club cancelled your session${s.whereAt ? ` on ${s.whereAt}` : ""} — it had started, so nothing was refunded.`,
  // R16 J16-7 — the partner's side of it: nothing moved, and their share stands.
  cancelled_share_stands: (s) => `The club cancelled ${s.whereAt ?? "your game"} — it had started, so your share stands.`,
  // R16 J16-4 — which booking, where the frame says.
  displaced_reinstated: (s) => s.up
    ? `${s.whereAt ? `Your booking on ${s.whereAt}` : "A booking"} was reinstated: ${s.minutes} back in your wallet.`
    : `${s.whereAt ? `Your refunded booking on ${s.whereAt}` : "A refunded booking"} was reinstated: ${s.minutes} went back on it.`,
};
