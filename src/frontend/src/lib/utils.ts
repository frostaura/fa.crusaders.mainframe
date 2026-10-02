import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { clubCurrencySymbol } from "./currency";

/**
 * tailwind-merge only knows Tailwind's stock spacing scale, so our named steps (`touch`,
 * `appbar`, `tabbar` — tailwind.config.ts) were never recognised as conflicting: `h-touch h-auto`
 * kept BOTH, the earlier one won in the stylesheet, and a Button told to grow for wrapped text
 * stayed 44px tall with its label spilling out (R3 F3 finding). Teaching it the names makes the
 * caller's class win, as it does for every stock size.
 */
const twMerge = extendTailwindMerge({ extend: { theme: { spacing: ["touch", "appbar", "tabbar"] } } });

/** shadcn-style className composer. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The one minus sign every displayed amount uses: U+2212, never the hyphen (R1, F3 follow-up).
 * `formatMoney` printed "-R50.00" beside the ledger's "−50" — two glyphs of two
 * widths for one idea, misaligned in a tabular column and read differently by a screen reader.
 */
export const MINUS = "\u2212";

/**
 * Real money, formatted for display, in the club's own currency symbol.
 *
 * Only for amounts that really are money: package prices, what a member pays PayFast, and
 * the admin reconciliation views. Everything else is minutes (`lib/minutes.ts`) — the symbol
 * is deliberately scoped to this function, and the reasoning is in `currency.ts`.
 *
 * The symbol PRECEDES the amount, which forces a choice a trailing unit never did: the
 * sign goes outside the symbol. "-R50.00" is how a negative amount of money is written;
 * "R-50.00" — what `R${value.toFixed(2)}` produced — reads as a symbol followed by a
 * malformed number. It is not hypothetical: `net_zar` on the club revenue card goes
 * negative in any period whose refunds beat its sales.
 */
export function formatMoney(value: number) {
  // `Math.abs` before `toFixed` so a negated zero cannot arrive here as "-0.00". Zero has
  // no direction.
  const magnitude = Math.abs(value).toFixed(2);
  const sign = value < 0 && Number(magnitude) !== 0 ? MINUS : "";
  return `${sign}${clubCurrencySymbol()}${magnitude}`;
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
