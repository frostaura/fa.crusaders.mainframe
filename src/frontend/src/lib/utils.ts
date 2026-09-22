import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { clubCurrencySymbol, spokenCurrencyName } from "./currency";

/** shadcn-style className composer. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * An amount of the club's money, formatted for display. <b>The only place a unit is ever
 * composed.</b>
 *
 * <p>
 * The owner's ruling, given twice: the symbol is configurable, it PRECEDES the amount, and
 * neither "cr" nor the word "credits" survives as a unit. There used to be two functions
 * here — one for the wallet, one for what a member paid the gateway — because those are two
 * quantities that convert at `credits_per_zar_*`. They are now written identically, which is
 * what the ruling asks for and which makes the exchange rate invisible everywhere except at
 * the conversion itself. `currency.ts` carries the whole decision and the rule it imposes on
 * the top-up screens; read it before adding a caller.
 * </p>
 *
 * <p>
 * The symbol PRECEDES the amount, which forces a choice a trailing unit never did: the sign
 * goes OUTSIDE the symbol. "-R50.00" is how a negative amount of money is written; "R-50.00"
 * — what `R${value.toFixed(2)}` produced — reads as a symbol followed by a malformed number.
 * Both a wallet and the revenue card's net go negative in production.
 * </p>
 */
export function formatMoney(value: number) {
  // `Math.abs` before `toFixed` so a negated zero cannot arrive here as "-0.00". Zero has
  // no direction, exactly as it has none in {@link formatSignedMoney}.
  const magnitude = Math.abs(value).toFixed(2);
  const sign = value < 0 ? "-" : "";
  return `${sign}${clubCurrencySymbol()}${magnitude}`;
}

/**
 * A signed amount, with the direction shown explicitly.
 *
 * <p>
 * For the one column where the SIGN carries the meaning — the ledger. The ledger table used
 * to build this inline from `+`/`−` plus `toFixed(2)` plus a literal " cr", so the one table
 * whose whole job is to reconcile was the one place not going through the shared formatter.
 * Uses U+2212 MINUS, not a hyphen, so a debit lines up under a credit in the tabular-nums
 * column.
 * </p>
 */
export function formatSignedMoney(value: number) {
  // Zero has no direction, so it gets no sign. This used to render "+0.00 cr" here and
  // "−0.00 cr" on the reports card, which hardcoded its own minus. Nothing moved, so
  // nothing carries a direction. Note `-0 === 0`, so a negated zero lands here.
  if (value === 0) return formatMoney(0);
  return `${value > 0 ? "+" : "−"}${formatMoney(Math.abs(value))}`;
}

/**
 * An amount as a screen reader should SAY it.
 *
 * <p>
 * <b>The visible unit is a symbol, and a symbol is not speakable.</b> An `aria-label`
 * replaces an element's contents as its accessible name, so "R240.00" is announced with the
 * R as a letter — the same defect "cr" had. This is the form that goes into a label, a
 * `role="status"` sentence or anything else a person hears rather than reads.
 * </p>
 *
 * <p>
 * The noun comes from {@link spokenCurrencyName}, which answers null for a symbol it cannot
 * name rather than guessing — so this degrades to a bare number inside a sentence that says
 * what the number is, which is still understandable, rather than to a wrong currency.
 * </p>
 */
export function spokenMoney(value: number) {
  const magnitude = Math.abs(value).toFixed(2);
  // U+2212, read aloud as "minus" — a hyphen is often announced as "dash" or skipped.
  const sign = value < 0 ? "\u2212" : "";
  const name = spokenCurrencyName();
  return `${sign}${magnitude}${name ? ` ${name}` : ""}`;
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
 * The top-up rate, said as a member reads it — <b>both legs, in words</b>.
 *
 * <p>
 * <b>This function carries the rule `currency.ts` imposes.</b> Now that a wallet and a card
 * payment are written with the same symbol, the exchange rate is invisible everywhere except
 * here and in the top-up email. It used to read "1.6 credits / R1", which worked only because
 * the two quantities had different units; with one unit, "1.6 / R1" would be meaningless and
 * "R100 buys R160" would look like a typo rather than a 60% bonus.
 * </p>
 *
 * <p>
 * So it names what leaves the card and what arrives in the wallet, as a sentence: <i>"Every
 * R1.00 you pay adds R1.60 to your wallet."</i> A club on 1:1 reads "adds R1.00", which is
 * honest rather than silly — it is the club that has chosen no bonus, and a sentence that
 * quietly disappeared at 1:1 would leave that screen saying nothing about the rate at all.
 * </p>
 *
 * <p>
 * The rate itself keeps every decimal the column holds — see {@link formatRate}. A club on
 * 1.6667 quoted 1.67 is a quote the club will not honour, because the ledger settles on the
 * stored figure; here that surfaces as the AMOUNT the wallet gains, which is the number the
 * member can actually check against their balance afterwards.
 * </p>
 */
export function describeTopUpRate(rate: number) {
  return `Every ${formatMoney(1)} you pay adds ${formatMoney(rate)} to your wallet`;
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
