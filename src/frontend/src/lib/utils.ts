import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-style className composer. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Credits, formatted for display.
 *
 * The unit of account is credits, not rand. A member tops up R100 and receives 160
 * credits at the Regular rate or 240 at the League/senior rate, and court prices are
 * quoted in credits — so rendering a credit balance with a rand sign is not a cosmetic
 * slip. At 1.6–2.4 credits per rand it overstates what a member has by 60% to 140%,
 * on the wallet header, the booking grid, the reports and the admin member list at once.
 *
 * That bug was live in six places. This function exists so there is one answer to
 * "how is money shown", and `formatZar` exists so the places that genuinely handle
 * rand can say so.
 */
export function formatCredits(value: number, options?: { long?: boolean }) {
  const amount = value.toFixed(2);
  return options?.long ? `${amount} credits` : `${amount} cr`;
}

/**
 * Rand, formatted for display.
 *
 * Only for amounts that really are rand: the top-up screens, where a member is paying
 * PayFast, and the admin reconciliation views. Everything else is credits.
 */
export function formatZar(value: number) {
  return `R${value.toFixed(2)}`;
}

/**
 * A signed credit figure, with the sign shown explicitly.
 *
 * The ledger table built this inline as `+`/`−` plus `toFixed(2)` plus a literal " cr",
 * so the one table where the sign carries the meaning was the one place not going through
 * `formatCredits`. Uses U+2212 MINUS, not a hyphen, so a debit lines up under a credit in
 * the tabular-nums column.
 */
export function formatSignedCredits(value: number) {
  return `${value >= 0 ? "+" : "−"}${formatCredits(Math.abs(value))}`;
}

/**
 * A rate, as "1.6 credits / R1" would read it — trailing zeros trimmed.
 *
 * `credits_per_zar_*` accepts four decimals, so this cannot be `toFixed(2)`: a club on
 * 1.6667 would be quoted 1.67 on the screen and settled at 1.6667 in the ledger.
 */
export function formatRate(value: number) {
  return String(Number(value.toFixed(4)));
}

/**
 * A timestamp, in the reader's own locale.
 *
 * One helper so the wallet, the admin ledger and the reports cannot each pick their own
 * format. Server-composed strings — a ledger comment naming a booking's slot — are
 * rendered in the CLUB's timezone by the API and are not re-formatted here; this is for
 * the `at` field of a movement, which is an instant and belongs in the reader's clock.
 */
export function formatInstant(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/** Minutes as a person says them: "45 min", "1 h 15 min", "2 h". */
export function formatMinutes(total: number) {
  if (total <= 0) return "0 min";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
