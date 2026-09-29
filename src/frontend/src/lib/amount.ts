/**
 * The one way an amount a person typed becomes a number — admin top-up, member top-up, a split
 * share, a monthly goal.
 *
 * <p>
 * <b>Review round 1, F3.18.</b> Four fields parsed money four ways: the admin top-up took
 * `Number()`, so "1e3" was a thousand credits and "1,5" was refused as "greater than zero"; the
 * member top-up had its own regex. A South African volunteer types a decimal comma, and a
 * member who meant 13 and typed "1e3" must be told, not quoted eighty times what they meant.
 * </p>
 *
 * <ul>
 *   <li><b>Accepted:</b> digits, with at most one decimal separator — a point OR a comma — and
 *   spaces (including the no-break and thin spaces an `en-ZA` formatter writes) as thousands
 *   separators.</li>
 *   <li><b>Refused, each with its own reason:</b> empty, a minus sign (either kind), anything
 *   else (letters, exponents, two separators), zero when zero is not allowed, more decimals
 *   than the unit has, more than the field's maximum.</li>
 * </ul>
 *
 * <p>
 * A separator followed by exactly three digits ("1,000" / "1.000") is refused as ambiguous
 * rather than guessed at: it is a thousand to one reader and one to another, and on a money
 * field the two guesses differ by a factor of a thousand.
 * </p>
 */
export type AmountProblem =
  | { kind: "empty" }
  | { kind: "negative" }
  | { kind: "not_a_number" }
  | { kind: "ambiguous" }
  | { kind: "zero" }
  | { kind: "too_precise"; decimals: number }
  | { kind: "too_large"; max: number };

export type AmountResult = { ok: true; value: number } | { ok: false; problem: AmountProblem };

export type AmountRules = {
  /** Decimal places the unit carries — 2 for credits and rand. */
  decimals?: number;
  /** The largest amount the field accepts, inclusive. */
  max?: number;
  /** A monthly goal of 0 is a real answer; a top-up of 0 is not. */
  allowZero?: boolean;
};

const SPACES = /[\s   ]/g;
const PLAIN = /^\d+(?:[.,]\d+)?$/;
const MINUS = /^[-−–]/;

export function parseAmount(text: string, rules: AmountRules = {}): AmountResult {
  const decimals = rules.decimals ?? 2;
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, problem: { kind: "empty" } };
  if (MINUS.test(trimmed)) return { ok: false, problem: { kind: "negative" } };
  const compact = trimmed.replace(SPACES, "");
  if (!PLAIN.test(compact)) return { ok: false, problem: { kind: "not_a_number" } };
  const fraction = compact.split(/[.,]/)[1];
  if (fraction !== undefined && fraction.length === 3 && decimals < 3) {
    return { ok: false, problem: { kind: "ambiguous" } };
  }
  if (fraction !== undefined && fraction.length > decimals) {
    return { ok: false, problem: { kind: "too_precise", decimals } };
  }
  const value = Number(compact.replace(",", "."));
  if (!Number.isFinite(value)) return { ok: false, problem: { kind: "not_a_number" } };
  if (value === 0 && !rules.allowZero) return { ok: false, problem: { kind: "zero" } };
  if (rules.max !== undefined && value > rules.max) return { ok: false, problem: { kind: "too_large", max: rules.max } };
  return { ok: true, value };
}
