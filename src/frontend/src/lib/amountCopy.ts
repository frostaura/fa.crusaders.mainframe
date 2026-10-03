import type { AmountProblem } from "./amount";
import { minutesSpoken } from "./minutes";
import { formatMoney } from "./utils";

/**
 * What each amount refusal says, per unit (F3.18). One sentence per problem, so the money fields
 * that share `parseAmount` also share their words — and "1,5" is never told to be "greater than
 * zero" again.
 *
 * <p>
 * P13: the club's unit is whole minutes. A minutes field parses with no decimals
 * (`MINUTES_RULES`), so its "too precise" sentence says minutes are whole, and its ceiling is
 * said the way every amount is ("1 h 30 min"), never as "1.5".
 * </p>
 */
export type AmountUnit = "minutes" | "rand";

const NOUN: Record<AmountUnit, string> = { minutes: "a number of minutes", rand: "an amount in rand" };

const EXAMPLE: Record<AmountUnit, string> = { minutes: "like 45 or 90", rand: "like 150 or 12,50" };

const isRand = (unit: AmountUnit) => unit === "rand";

export const AMOUNT_COPY = {
  empty: (unit: AmountUnit) => `Enter ${NOUN[unit]}.`,
  negative: "Enter the amount without a minus sign.",
  notANumber: (unit: AmountUnit) => `That isn't a number — enter ${NOUN[unit]}, ${EXAMPLE[unit]}.`,
  ambiguous: "Is that a thousand or one? Write it without the separator (1000), or with two decimals (1,00).",
  /** Minutes have no decimals, so the only honest way to write a thousand is without a separator. */
  ambiguousMinutes: "Is that a thousand or one? Write minutes without a separator, like 1000.",
  zero: "Enter an amount greater than zero.",
  tooPrecise: (unit: AmountUnit) => (isRand(unit) ? "Rand go to two decimal places (cents)." : "Minutes are whole numbers — leave off the decimals."),
  tooLarge: (unit: AmountUnit, max: number) => `The most this can be is ${isRand(unit) ? formatMoney(max) : minutesSpoken(max)}.`,
} as const;

export function amountProblemSentence(problem: AmountProblem, unit: AmountUnit): string {
  switch (problem.kind) {
    case "empty": return AMOUNT_COPY.empty(unit);
    case "negative": return AMOUNT_COPY.negative;
    case "not_a_number": return AMOUNT_COPY.notANumber(unit);
    case "ambiguous": return isRand(unit) ? AMOUNT_COPY.ambiguous : AMOUNT_COPY.ambiguousMinutes;
    case "zero": return AMOUNT_COPY.zero;
    case "too_precise": return AMOUNT_COPY.tooPrecise(unit);
    case "too_large": return AMOUNT_COPY.tooLarge(unit, problem.max);
  }
}
