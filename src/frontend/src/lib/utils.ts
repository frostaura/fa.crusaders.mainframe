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
 * Credits, formatted for display.
 *
 * The unit of account is credits, not rand. A member tops up R100 and receives 160
 * credits at the Regular rate or 240 at the League group's rate, and court prices are
 * quoted in credits — so rendering a credit balance with a rand sign is not a cosmetic
 * slip. At 1.6–2.4 credits per rand it overstates what a member has by 60% to 140%,
 * on the wallet header, the booking grid, the reports and the admin member list at once.
 *
 * That bug was live in six places. This function exists so there is one answer to
 * "how is money shown", and `formatMoney` exists so the places that genuinely handle
 * rand can say so.
 */
/**
 * The one minus sign every displayed amount uses: U+2212, never the hyphen (R1, F3 follow-up).
 * `formatMoney` printed "-R50.00" beside `formatSignedCredits`' "−50.00 cr" — two glyphs of two
 * widths for one idea, misaligned in a tabular column and read differently by a screen reader.
 */
export const MINUS = "\u2212";

/** "−5.00" / "5.00" — two places, the minus sign above, and no sign on a figure that rounds to zero. */
function signedFixed(value: number): string {
  const magnitude = Math.abs(value).toFixed(2);
  return value < 0 && Number(magnitude) !== 0 ? `${MINUS}${magnitude}` : magnitude;
}

export function formatCredits(value: number, options?: { long?: boolean }) {
  const amount = signedFixed(value);
  return options?.long ? `${amount} credits` : `${amount} cr`;
}

/**
 * Real money, formatted for display, in the club's own currency symbol.
 *
 * Only for amounts that really are money: the top-up screens, where a member is paying
 * PayFast, and the admin reconciliation views. Everything else is credits — the symbol
 * is deliberately scoped to this function, and the reasoning is in `currency.ts`.
 *
 * The symbol PRECEDES the amount, which forces a choice a trailing unit never did: the
 * sign goes outside the symbol. "-R50.00" is how a negative amount of money is written;
 * "R-50.00" — what `R${value.toFixed(2)}` produced — reads as a symbol followed by a
 * malformed number. It is not hypothetical: `net_zar` on the club revenue card goes
 * negative in any period whose refunds beat its top-ups.
 */
export function formatMoney(value: number) {
  // `Math.abs` before `toFixed` so a negated zero cannot arrive here as "-0.00". Zero has
  // no direction, exactly as it has none in `formatSignedCredits`.
  const magnitude = Math.abs(value).toFixed(2);
  const sign = value < 0 && Number(magnitude) !== 0 ? MINUS : "";
  return `${sign}${clubCurrencySymbol()}${magnitude}`;
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
  // Zero has no direction, so it gets no sign. This used to render "+0.00 cr", and the
  // reports card — hardcoding its own minus around `formatCredits` rather than coming
  // through here — rendered "−0.00 cr" for a member who had spent nothing and been
  // penalised nothing. On the one screen whose whole job is to reconcile, a signed zero
  // reads as a movement that did not happen. Note `-0 === 0`, so a negated zero lands here.
  if (value === 0) return formatCredits(0);
  return `${value > 0 ? "+" : MINUS}${formatCredits(Math.abs(value))}`;
}

/**
 * A conversion rate as a bare number — trailing zeros trimmed.
 *
 * `credits_per_zar_*` accepts four decimals, so this cannot be `toFixed(2)`: a club on
 * 1.6667 would be quoted 1.67 on the screen and settled at 1.6667 in the ledger.
 *
 * It is the NUMBER only. Say the rate to a member through {@link formatRatePerRand},
 * which owns the unit noun beside it — see the singular trap recorded there.
 */
export function formatRate(value: number) {
  return String(Number(value.toFixed(4)));
}

/**
 * The top-up rate, said as a member reads it — <b>both legs, each in its own unit</b>.
 *
 * <p>
 * This is the one sentence in the product that spans the conversion, so it is the one place
 * the rate is visible at all. It used to read "1.6 credits / R1", which is accurate and
 * which a volunteer at the desk could not act on: it asks the reader to do the multiplication
 * that the sentence exists to save them.
 * </p>
 *
 * <p>
 * So it names what leaves the card and what arrives in the wallet: <i>"Every R1.00 you pay
 * adds 1.60 cr to your wallet."</i> The money leg wears the club's configurable symbol, the
 * wallet leg keeps the credit unit, and the two being visibly different units is the whole
 * point — a member paying R100 for 160 cr must not be able to read that as R160.
 * </p>
 *
 * <p>
 * It also retires a trap the old wording carried. "1 credit / R1" needed the noun to agree
 * with the number, because trimming 1.0000 to "1" left a singular quantity beside a plural
 * noun, and a club on a 1:1 rate was being told "At 1 credits / R1" — seen live on the
 * re-quote screen. "cr" does not inflect, so the agreement problem cannot come back.
 * </p>
 *
 * <p>
 * Still no rounding: {@link formatCredits} keeps two decimals and the rate itself may carry
 * four, so a club on 1.6667 reads "adds 1.67 cr" while the ledger settles on 1.6667. That is
 * a quote-versus-settlement gap the old wording had too, and it is why the sentence says what
 * ONE unit of money buys rather than what the member's whole top-up buys — a per-R1 figure
 * rounds to something a member can check, and a per-R1000 figure would not.
 * </p>
 */
export function describeTopUpRate(rate: number) {
  return `Every ${formatMoney(1)} you pay adds ${formatCredits(rate)} to your wallet`;
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
