import { describe, expect, it } from "vitest";
import { MINUTES_RULES, parseAmount, parseMinutesAmount } from "./amount";
import { AMOUNT_COPY, amountProblemSentence } from "./amountCopy";

/** F3.18: one parser for every money field — decimal comma yes, exponent no, reasons that fit. */
describe("parseAmount", () => {
  const value = (text: string, rules = {}) => {
    const r = parseAmount(text, rules);
    return r.ok ? r.value : r.problem.kind;
  };

  it("accepts a decimal point, a decimal comma and space-grouped thousands", () => {
    expect(value("150")).toBe(150);
    expect(value("12.50")).toBe(12.5);
    expect(value("1,5")).toBe(1.5);
    expect(value(" 1 000 ")).toBe(1000);
    expect(value("1 000,25")).toBe(1000.25);
  });

  it("refuses programmer notation and stray characters as not a number", () => {
    for (const text of ["1e3", "0x10", "200abc", "1.2.3", "1,2,3", "Infinity", "NaN", "+5"]) {
      expect(value(text), text).toBe("not_a_number");
    }
  });

  it("gives each other refusal its own reason", () => {
    expect(value("")).toBe("empty");
    expect(value("-5")).toBe("negative");
    expect(value("−5")).toBe("negative");
    expect(value("0")).toBe("zero");
    expect(value("0", { allowZero: true })).toBe(0);
    expect(value("1.234")).toBe("ambiguous");
    expect(value("1,000")).toBe("ambiguous");
    expect(value("1.2345")).toBe("too_precise");
    expect(value("99999999999", { max: 99_999_999.99 })).toBe("too_large");
  });

  it("never tells a decimal comma to be greater than zero", () => {
    const r = parseAmount("1,5");
    expect(r.ok).toBe(true);
    expect(amountProblemSentence({ kind: "not_a_number" }, "rand")).toBe(AMOUNT_COPY.notANumber("rand"));
  });
});

/** P13 §7.1 — a minutes field parses with 0 decimals: whole minutes or a reason, never a rounding. */
describe("parseMinutesAmount", () => {
  const value = (text: string, rules = {}) => {
    const r = parseMinutesAmount(text, rules);
    return r.ok ? r.value : r.problem.kind;
  };

  it("takes whole minutes, space-grouped thousands included", () => {
    expect(MINUTES_RULES.decimals).toBe(0);
    expect(value("45")).toBe(45);
    expect(value("1 440")).toBe(1440);
  });

  it("refuses a fraction of a minute as too precise — never rounds it", () => {
    expect(value("1,5")).toBe("too_precise");
    expect(value("90.25")).toBe("too_precise");
    expect(value("1,000")).toBe("ambiguous");
  });

  it("keeps a caller's bound and cannot be talked into decimals", () => {
    expect(value("1000000", { max: 999_999 })).toBe("too_large");
    expect(value("1.5", { decimals: 2 } as never)).toBe("too_precise");
  });

  it("says minutes in minutes' words: whole numbers, a ceiling as an amount, no '1,00'", () => {
    expect(amountProblemSentence({ kind: "too_precise", decimals: 0 }, "minutes")).toBe(AMOUNT_COPY.tooPrecise("minutes"));
    expect(AMOUNT_COPY.tooPrecise("minutes")).toMatch(/whole numbers/);
    expect(amountProblemSentence({ kind: "too_large", max: 90 }, "minutes")).toBe("The most this can be is 1 h 30 min.");
    expect(amountProblemSentence({ kind: "ambiguous" }, "minutes")).toBe(AMOUNT_COPY.ambiguousMinutes);
    expect(amountProblemSentence({ kind: "ambiguous" }, "rand")).toBe(AMOUNT_COPY.ambiguous);
    for (const kind of ["empty", "not_a_number"] as const) {
      expect(amountProblemSentence({ kind }, "minutes")).not.toMatch(/credit/i);
    }
  });
});
