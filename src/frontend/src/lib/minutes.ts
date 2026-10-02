/**
 * Minutes — the club's unit of account since P13 ("minutes, not credits").
 *
 * <p>
 * The contract is `docs/specs/minutes-and-packages.md` §7.1, and every output here is pinned
 * by `minutes.test.ts`. One formatter for every amount on every screen, so a balance, a price
 * and a ledger row cannot each pick their own spelling.
 * </p>
 *
 * <ul>
 *   <li><b>Exact, never rounded.</b> Days from 1 440 upward (`d`, `h`, `min`); a zero part is
 *   left out; "0 min" is a real figure.</li>
 *   <li><b>One leading U+2212 on the whole value</b> — "−1 h 30 min", never "−1 h −30 min" —
 *   so a debit lines up under a credit in a tabular column and a screen reader hears one sign.</li>
 *   <li><b>Never `hh:mm` for an amount.</b> The app is full of clock times; "1:30" reads as half
 *   past one. `hh:mm` stays for clock times and `mm:ss` for countdowns.</li>
 *   <li><b>Never a decimal.</b> The ledger holds whole minutes, so a fraction can only be a
 *   caller's bug; it is truncated toward zero rather than shown.</li>
 *   <li><b>Screen readers never hear "h", "d" or "min"</b> — {@link minutesSpoken} is the long
 *   form, in `memberDoorCopy.formatWindowMinutes`'s wording, and `<Minutes>` pairs the two.</li>
 * </ul>
 *
 * <p>
 * Not a duration helper: `utils.formatMinutes` formats how LONG something lasts and stays for
 * that. An amount of the member's minutes always comes through here.
 * </p>
 */

/** U+2212 MINUS SIGN, the same character `utils.MINUS` uses for money. */
export const MINUS_SIGN = "−";

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/** What a non-finite figure (NaN, ±Infinity) renders as: a dash, never a made-up "0 min". */
export const NO_FIGURE = "—";
/** The spoken form of {@link NO_FIGURE}. */
export const NO_FIGURE_SPOKEN = "no figure";

type Parts = { days: number; hours: number; minutes: number };

/** Whole minutes, truncated toward zero; `-0` becomes `0` so it never carries a sign. */
function whole(n: number): number {
  const t = Math.trunc(n);
  return t === 0 ? 0 : t;
}

function partsOf(magnitude: number): Parts {
  return {
    days: Math.floor(magnitude / MINUTES_PER_DAY),
    hours: Math.floor((magnitude % MINUTES_PER_DAY) / MINUTES_PER_HOUR),
    minutes: magnitude % MINUTES_PER_HOUR,
  };
}

function compactMagnitude(magnitude: number): string {
  if (magnitude === 0) return "0 min";
  const { days, hours, minutes } = partsOf(magnitude);
  const out: string[] = [];
  if (days > 0) out.push(`${days} d`);
  if (hours > 0) out.push(`${hours} h`);
  if (minutes > 0) out.push(`${minutes} min`);
  return out.join(" ");
}

const noun = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function spokenMagnitude(magnitude: number): string {
  if (magnitude === 0) return "0 minutes";
  const { days, hours, minutes } = partsOf(magnitude);
  const out: string[] = [];
  if (days > 0) out.push(noun(days, "day", "days"));
  if (hours > 0) out.push(noun(hours, "hour", "hours"));
  if (minutes > 0) out.push(noun(minutes, "minute", "minutes"));
  return out.join(" ");
}

/** "45 min", "1 h 30 min", "1 d 6 h 15 min", "−1 h 30 min", "0 min". */
export function minutesCompact(n: number): string {
  if (!Number.isFinite(n)) return NO_FIGURE;
  const value = whole(n);
  const body = compactMagnitude(Math.abs(value));
  return value < 0 ? `${MINUS_SIGN}${body}` : body;
}

/** A movement: "+1 h", "−45 min"; a zero has no direction and gets no sign ("0 min"). */
export function minutesSigned(n: number): string {
  if (!Number.isFinite(n)) return NO_FIGURE;
  const value = whole(n);
  if (value === 0) return compactMagnitude(0);
  return `${value > 0 ? "+" : MINUS_SIGN}${compactMagnitude(Math.abs(value))}`;
}

/**
 * The long form a screen reader hears: "1 hour 30 minutes", "minus 45 minutes",
 * "2 days 3 hours"; with `signed`, a positive figure is "plus 1 hour". A zero is "0 minutes",
 * signed or not.
 */
export function minutesSpoken(n: number, opts?: { signed?: boolean }): string {
  if (!Number.isFinite(n)) return NO_FIGURE_SPOKEN;
  const value = whole(n);
  const body = spokenMagnitude(Math.abs(value));
  if (value < 0) return `minus ${body}`;
  if (value > 0 && opts?.signed) return `plus ${body}`;
  return body;
}

/** Where a member buys minutes (P13 §3.1). The old `/wallet/topup` redirects here. */
export const BUY_MINUTES_PATH = "/wallet/buy";
