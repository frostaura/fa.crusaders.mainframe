import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { adjustRefusal, countsAsRevenue } from "./topUpCopy";
import { formatCredits, formatMoney } from "./utils";

/** The desk adjustment's refusals, by the server's codes and figures (review round 1 contract §5, §9). */
describe("adjustRefusal", () => {
  it("reads the ceiling from max_credits, or from the contract's max", () => {
    expect(adjustRefusal(new ApiError(400, { error: "amount_out_of_range", max_credits: 5000 }))).toContain(formatCredits(5000));
    expect(adjustRefusal(new ApiError(400, { error: "amount_out_of_range", max: 750 }))).toContain(formatCredits(750));
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
