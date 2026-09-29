import type { AmountProblem } from "./amount";
import { formatCredits, formatMoney } from "./utils";

/**
 * What each amount refusal says, per unit (F3.18). One sentence per problem, so the four money
 * fields that share `parseAmount` also share their words — and "1,5" is never told to be
 * "greater than zero" again.
 */
export type AmountUnit = "credits" | "rand";

const NOUN: Record<AmountUnit, string> = { credits: "an amount of credits", rand: "an amount in rand" };

export const AMOUNT_COPY = {
  empty: (unit: AmountUnit) => `Enter ${NOUN[unit]}.`,
  negative: "Enter the amount without a minus sign.",
  notANumber: (unit: AmountUnit) => `That isn't a number — enter ${NOUN[unit]}, like 150 or 12,50.`,
  ambiguous: "Is that a thousand or one? Write it without the separator (1000), or with two decimals (1,00).",
  zero: "Enter an amount greater than zero.",
  tooPrecise: (unit: AmountUnit) => (unit === "rand" ? "Rand go to two decimal places (cents)." : "Credits go to two decimal places."),
  tooLarge: (unit: AmountUnit, max: number) => `The most this can be is ${unit === "rand" ? formatMoney(max) : formatCredits(max)}.`,
} as const;

export function amountProblemSentence(problem: AmountProblem, unit: AmountUnit): string {
  switch (problem.kind) {
    case "empty": return AMOUNT_COPY.empty(unit);
    case "negative": return AMOUNT_COPY.negative;
    case "not_a_number": return AMOUNT_COPY.notANumber(unit);
    case "ambiguous": return AMOUNT_COPY.ambiguous;
    case "zero": return AMOUNT_COPY.zero;
    case "too_precise": return AMOUNT_COPY.tooPrecise(unit);
    case "too_large": return AMOUNT_COPY.tooLarge(unit, problem.max);
  }
}
