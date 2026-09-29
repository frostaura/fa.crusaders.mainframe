import { describe, expect, it } from "vitest";
import { parseAmount } from "./amount";
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
    expect(value("1 000,25")).toBe(1000.25);
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
    expect(amountProblemSentence({ kind: "not_a_number" }, "credits")).toBe(AMOUNT_COPY.notANumber("credits"));
  });
});
