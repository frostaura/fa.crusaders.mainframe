import type { SplitMode } from "@/lib/playersApi";

/**
 * The split, worked out on the phone — a mirror of the backend's `SplitCalculator` (D11 §2),
 * for INSTANT validation as the organiser types and for tests. The server's
 * `POST /players/split-preview` stays the figure the sheet displays; this only decides whether
 * a figure is worth asking for, and says "the amounts add up to more than the court" the moment
 * they do rather than a debounce later.
 *
 * <p>
 * <b>The rules, exactly as the server applies them.</b> Partners under an equal or ratio split
 * are rounded DOWN to whole credits; the organiser (seat 1) takes the remainder, fractions
 * included, so the shares sum to the price by construction. Under an amount split the partners'
 * figures are the organiser's own (≥ 0, at most two decimal places) and the organiser again takes
 * the remainder, refused below zero. Guests carry 0 and are not a head.
 * </p>
 *
 * <p>
 * <b>Integer cents throughout.</b> `0.1 + 0.2` is the reason: a sum that must equal the price
 * EXACTLY cannot be done in binary floating point, so every figure is scaled to cents, worked in
 * integers, and scaled back once at the end.
 * </p>
 */

export const MAX_WEIGHT = 100;

/** A partner seat going into the split (seat 1 is implied — it is always the organiser). */
export type MathSeat = { seat: number; isGuest: boolean; weight?: number; amount?: number };

/** One seat coming out of it, seat 1 first. */
export type MathShare = { seat: number; share: number; weight: number };

export type MathResult = { ok: true; shares: MathShare[] } | { ok: false; error: string };

const refuse = (error: string): MathResult => ({ ok: false, error });

function toCents(credits: number): number {
  return Math.round(credits * 100);
}

/** Whether a figure has at most two decimal places — the ledger's scale. */
export function hasTwoPlaces(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

function isWeight(weight: number): boolean {
  return Number.isInteger(weight) && weight >= 0 && weight <= MAX_WEIGHT;
}

/** Seat 1 first, then the partners in seat order — the server's order. */
function assemble(priceCents: number, organiserWeight: number, partners: { seat: number; cents: number; weight: number }[]): MathResult {
  const taken = partners.reduce((n, p) => n + p.cents, 0);
  const ordered = [...partners].sort((a, b) => a.seat - b.seat);
  return {
    ok: true,
    shares: [
      { seat: 1, share: (priceCents - taken) / 100, weight: organiserWeight },
      ...ordered.map((p) => ({ seat: p.seat, share: p.cents / 100, weight: p.weight })),
    ],
  };
}

function byWeight(priceCents: number, organiserWeight: number, partners: readonly MathSeat[], equal: boolean): MathResult {
  const weightOf = (s: MathSeat) => (equal ? 1 : s.weight ?? 1);
  const own = equal ? 1 : organiserWeight;
  const total = own + partners.filter((s) => !s.isGuest).reduce((n, s) => n + weightOf(s), 0);
  if (total <= 0) return refuse("split_weight_invalid");
  const rows = partners.map((s) => {
    if (s.isGuest) return { seat: s.seat, cents: 0, weight: 0 };
    // ⌊P × w / Σw⌋ in whole credits, on integers: ⌊Pc × w / (Σw × 100)⌋ × 100.
    const whole = Math.floor((priceCents * weightOf(s)) / (total * 100));
    return { seat: s.seat, cents: whole * 100, weight: weightOf(s) };
  });
  return assemble(priceCents, own, rows);
}

function byAmount(priceCents: number, partners: readonly MathSeat[]): MathResult {
  const rows: { seat: number; cents: number; weight: number }[] = [];
  for (const s of partners) {
    if (s.isGuest) {
      rows.push({ seat: s.seat, cents: 0, weight: 0 });
      continue;
    }
    const amount = s.amount ?? 0;
    if (!(amount >= 0) || !hasTwoPlaces(amount)) return refuse("split_amount_invalid");
    rows.push({ seat: s.seat, cents: toCents(amount), weight: 0 });
  }
  if (rows.reduce((n, r) => n + r.cents, 0) > priceCents) return refuse("split_exceeds_price");
  return assemble(priceCents, 0, rows);
}

/**
 * Splits `price` between the organiser and `partners`. Refusals use the server's codes, so the
 * sentence for each is `playersRefusal`'s.
 */
export function splitShares(price: number, mode: SplitMode, organiserWeight: number, partners: readonly MathSeat[]): MathResult {
  if (!(price >= 0)) return refuse("split_amount_invalid");
  const priceCents = toCents(price);
  if (mode === "equal") return byWeight(priceCents, 1, partners, true);
  if (mode === "ratio") {
    const weights = [organiserWeight, ...partners.filter((s) => !s.isGuest).map((s) => s.weight ?? 1)];
    if (!weights.every(isWeight)) return refuse("split_weight_invalid");
    return byWeight(priceCents, organiserWeight, partners, false);
  }
  if (mode === "amount") return byAmount(priceCents, partners);
  return refuse("split_mode_invalid");
}

/** What the partners are asked for in all — the "you get Y back as they accept" figure. */
export function partnersTotal(shares: readonly { seat: number; share_minutes?: number; share?: number }[]): number {
  const cents = shares
    .filter((s) => s.seat !== 1)
    .reduce((n, s) => n + toCents(s.share_minutes ?? s.share ?? 0), 0);
  return cents / 100;
}
