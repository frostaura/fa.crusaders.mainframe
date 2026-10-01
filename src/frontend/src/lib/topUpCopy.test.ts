import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  ADJUST_MAX_MINUTES, MINUS_REFUSED, adjustRefusal, balanceSentence, confirmConsequence, countsAsRevenue, doneSentence,
  overdraftWarning, parseMinutes, receiptHeader, sheetTitle, validateAmount,
} from "./topUpCopy";
import { AMOUNT_COPY } from "./amountCopy";
import { formatMoney } from "./utils";

/** The desk adjustment's refusals, by the server's codes and figures (P13 §3.7). */
describe("adjustRefusal", () => {
  it("reads the ceiling from max_minutes, or from the contract's max, and says it in minutes", () => {
    expect(adjustRefusal(new ApiError(400, { error: "amount_out_of_range", max_minutes: 999_999 }))).toContain("694 d 10 h 39 min");
    expect(adjustRefusal(new ApiError(400, { error: "amount_out_of_range", max: 90 }))).toContain("1 h 30 min");
  });

  it("asks for the rand received on a revenue top-up", () => {
    expect(adjustRefusal(new ApiError(400, { error: "zar_received_required" }))).toMatch(/how much money was received/);
  });

  it("says a rand figure out of range, with the server's ceiling", () => {
    const said = adjustRefusal(new ApiError(400, { error: "zar_received_out_of_range", max: 1_000_000 }));
    expect(said).toContain(formatMoney(1_000_000));
    expect(said).toMatch(/Nothing was changed/);
  });

  it("leaves anything else to the generic sentence", () => {
    expect(adjustRefusal(new ApiError(400, { error: "something_new" }))).toBeNull();
    expect(adjustRefusal(new Error("offline"))).toBeNull();
  });

  it("counts all three desk top-up codes — cash, EFT and card offline — as revenue that needs rand", () => {
    expect(["top_up_cash", "top_up_eft", "top_up_card_offline"].every((c) => countsAsRevenue(c as never))).toBe(true);
    expect(countsAsRevenue("goodwill")).toBe(false);
  });
});

/** P13 — the desk's figures are whole minutes in the one compact form; never "cr", never a decimal. */
describe("the desk's sentences in minutes", () => {
  it("states balance and result before the press", () => {
    expect(balanceSentence("Thandi", 370, 100, "add")).toBe("Thandi has 6 h 10 min. After +1 h 40 min: 7 h 50 min.");
    expect(balanceSentence("Thandi", 370, null, "add")).toBe("Thandi has 6 h 10 min.");
    expect(confirmConsequence("Thandi", 30, 45, "take_back")).toBe("Take 45 min back from Thandi? They end on −15 min. This goes on the ledger and cannot be deleted.");
    expect(overdraftWarning(30, 45)).toMatch(/^That takes them to −15 min — they would owe the club 15 min/);
    expect(receiptHeader("Thandi", 60, 30, "add")).toBe("Thandi had 1 h. +30 min → 1 h 30 min.");
    expect(doneSentence("Thandi", 1500)).toBe("Done. Thandi now has 1 d 1 h.");
    expect(sheetTitle("take_back", "Thandi")).toBe("Take minutes back from Thandi");
  });

  it("parses whole minutes only, with the server's ceiling", () => {
    expect(parseMinutes("90")).toBe(90);
    expect(parseMinutes("1,5")).toBeNull();
    expect(validateAmount("1,5")).toBe(AMOUNT_COPY.tooPrecise("minutes"));
    expect(validateAmount(String(ADJUST_MAX_MINUTES + 1))).toMatch(/^The most this can be is /);
    expect(validateAmount("-5")).toBe(MINUS_REFUSED);
  });

  it("never says credit in a sentence a volunteer reads", () => {
    const said = [
      balanceSentence("T", null, 5, "add"), balanceSentence("T", null, 5, "take_back"), MINUS_REFUSED,
      sheetTitle("add", "T"), sheetTitle("take_back", "T"), confirmConsequence("T", 10, 5, "add"),
    ];
    for (const line of said) expect(line).not.toMatch(/credit|\bcr\b/i);
  });
});
