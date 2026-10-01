import type { SplitMode } from "@/lib/playersApi";

/**
 * The split, worked out on the phone — a mirror of the backend's `SplitCalculator` (D11 §2,
 * P13 §1.2), for INSTANT validation and the live totals as the organiser types, and for tests.
 * The server's `POST /players/split-preview` stays the figure the sheet confirms; this decides
 * whether a figure is worth asking for, says "the amounts add up to more than the court" the
 * moment they do rather than a debounce later, and fills the totals bar while the server answers.
 *
 * <p>
 * <b>The rules, exactly as the server applies them — in whole minutes.</b> A booking costs its
 * playing minutes, an integer. Under an equal or ratio split each partner is
 * `⌊price × weight ÷ Σweight⌋`; the organiser (seat 1) takes `price − Σ partners`, so the shares
 * sum to the price by construction and every remainder is the organiser's. Under an amount split
 * the partners' figures are the organiser's own — whole numbers ≥ 0, else `split_amount_invalid` —
 * their sum at most the price, else `split_exceeds_price`, and the organiser again takes the rest.
 * Guests carry 0 and are not a head.
 * </p>
 */

export const MAX_WEIGHT = 100;

/** A partner seat going into the split (seat 1 is implied — it is always the organiser). */
export type MathSeat = { seat: number; isGuest: boolean; weight?: number; amount?: number };

/** One seat coming out of it, seat 1 first. `share` is whole minutes. */
export type MathShare = { seat: number; share: number; weight: number };

export type MathResult = { ok: true; shares: MathShare[] } | { ok: false; error: string };

const refuse = (error: string): MathResult => ({ ok: false, error });

/** Whether a figure is a whole number of minutes — the ledger's only scale (P13 §1.1). */
export function isWholeMinutes(value: number): boolean {
  return Number.isInteger(value);
}

function isWeight(weight: number): boolean {
  return Number.isInteger(weight) && weight >= 0 && weight <= MAX_WEIGHT;
}

type Row = { seat: number; minutes: number; weight: number };

/** Seat 1 first, then the partners in seat order — the server's order. */
function assemble(price: number, organiserWeight: number, partners: Row[]): MathResult {
  const taken = partners.reduce((n, p) => n + p.minutes, 0);
  const ordered = [...partners].sort((a, b) => a.seat - b.seat);
  return {
    ok: true,
    shares: [
      { seat: 1, share: price - taken, weight: organiserWeight },
      ...ordered.map((p) => ({ seat: p.seat, share: p.minutes, weight: p.weight })),
    ],
  };
}

function byWeight(price: number, organiserWeight: number, partners: readonly MathSeat[], equal: boolean): MathResult {
  const weightOf = (s: MathSeat) => (equal ? 1 : s.weight ?? 1);
  const own = equal ? 1 : organiserWeight;
  const total = own + partners.filter((s) => !s.isGuest).reduce((n, s) => n + weightOf(s), 0);
  if (total <= 0) return refuse("split_weight_invalid");
  const rows = partners.map((s) => (s.isGuest
    ? { seat: s.seat, minutes: 0, weight: 0 }
    // ⌊P × w / Σw⌋ — rounded down, in favour of the partner who pays; the organiser keeps the rest.
    : { seat: s.seat, minutes: Math.floor((price * weightOf(s)) / total), weight: weightOf(s) }));
  return assemble(price, own, rows);
}

function byAmount(price: number, partners: readonly MathSeat[]): MathResult {
  const rows: Row[] = [];
  for (const s of partners) {
    if (s.isGuest) {
      rows.push({ seat: s.seat, minutes: 0, weight: 0 });
      continue;
    }
    const amount = s.amount ?? 0;
    if (!(amount >= 0) || !isWholeMinutes(amount)) return refuse("split_amount_invalid");
    rows.push({ seat: s.seat, minutes: amount, weight: 0 });
  }
  if (rows.reduce((n, r) => n + r.minutes, 0) > price) return refuse("split_exceeds_price");
  return assemble(price, 0, rows);
}

/**
 * Splits `price` (whole minutes) between the organiser and `partners`. Refusals use the server's
 * codes, so the sentence for each is `playersRefusal`'s.
 */
export function splitShares(price: number, mode: SplitMode, organiserWeight: number, partners: readonly MathSeat[]): MathResult {
  if (!(price >= 0) || !isWholeMinutes(price)) return refuse("split_amount_invalid");
  if (mode === "equal") return byWeight(price, 1, partners, true);
  if (mode === "ratio") {
    const weights = [organiserWeight, ...partners.filter((s) => !s.isGuest).map((s) => s.weight ?? 1)];
    if (!weights.every(isWeight)) return refuse("split_weight_invalid");
    return byWeight(price, organiserWeight, partners, false);
  }
  if (mode === "amount") return byAmount(price, partners);
  return refuse("split_mode_invalid");
}

/** What the partners are asked for in all — the "you get Y back as they accept" figure. */
export function partnersTotal(shares: readonly { seat: number; share_minutes?: number; share?: number }[]): number {
  return shares
    .filter((s) => s.seat !== 1)
    .reduce((n, s) => n + Math.trunc(s.share_minutes ?? s.share ?? 0), 0);
}
