import { afterEach, describe, expect, it } from "vitest";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "./currency";
import {
  ADD_LINK, MINUS_REFUSED, TAKE_BACK_LINK, balanceSentence, confirmConsequence, doneSentence,
  overdraftWarning, sheetTitle, validateAmount,
} from "./topUpCopy";
import { cancelConsequence, cancelTotalsSentence, haltSentence, rowOutcome } from "./bulkCopy";
import { recentBookingsFrom } from "./creditAdjustment";
import type { LedgerRow } from "./api";

afterEach(resetClubCurrencySymbol);

/**
 * The desk's own money surfaces, under the owner's ruling.
 *
 * <p>
 * <b>Two different uses of the word, and only one of them is the ruling's target.</b> "100.00
 * credits" is a unit bolted to a number and goes. "Take credit back" is a flow NAME — a verb
 * phrase about moving money, with no number attached — so mechanical substitution does not
 * apply to it. It changes anyway, and deliberately: the product no longer has a thing called a
 * credit for the desk to take back, and a volunteer reading "Take credit back" beside a figure
 * written "R100.00" is being shown two vocabularies for one balance. "Money" is what is left
 * once the unit is gone, and it is the word a person at a desk would use.
 * </p>
 */
describe("the two paths an admin moves money along", () => {
  it("names each path after what it does to the wallet, not after a unit", () => {
    expect(sheetTitle("add", "Thandi")).toBe("Top up Thandi");
    expect(sheetTitle("take_back", "Thandi")).toBe("Take money back from Thandi");
    expect(TAKE_BACK_LINK).toBe("Take money back instead");
    expect(ADD_LINK).toBe("Add money instead");
  });

  it("refuses a typed minus by naming the other path exactly as that path is labelled", () => {
    // The refusal is only useful if the control it names is the control on screen. A sign is
    // not a decision a person makes — it is a character they type — which is the whole of
    // D3-B08, and the way out has to be findable.
    expect(MINUS_REFUSED).toContain("Take money back");
    expect(MINUS_REFUSED).not.toMatch(/credits?\b/i);
  });

  it("states the three figures before the press, with the symbol in front of each", () => {
    expect(balanceSentence("Thandi", 370, 100, "add"))
      .toBe("Thandi has R370.00. After +R100.00: R470.00.");
    expect(balanceSentence("Thandi", 370, 100, "take_back"))
      .toBe("Thandi has R370.00. After −R100.00: R270.00.");
    expect(balanceSentence("Thandi", 370, null, "add")).toBe("Thandi has R370.00.");
  });

  it("refuses to do arithmetic on a balance it could not read, and says which path still works", () => {
    // A balance the console could not read is NOT zero. Three states, not two.
    expect(balanceSentence("Thandi", null, 100, "add"))
      .toContain("Couldn't read Thandi's balance. You can still add money,");
    expect(balanceSentence("Thandi", null, 100, "take_back"))
      .toContain("You can still take money back,");
  });

  it("says what an overdraft costs, in both directions of the same figure", () => {
    expect(overdraftWarning(50, 200))
      .toBe("That takes them to -R150.00 — they would owe the club R150.00 and cannot book until it is made up.");
    expect(overdraftWarning(500, 200)).toBeNull();
  });

  it("arms the confirm with the figure and the fact that it cannot be deleted", () => {
    expect(confirmConsequence("Thandi", 370, 100, "add"))
      .toBe("Add R100.00 to Thandi? They end on R470.00. This goes on the ledger and cannot be deleted.");
    expect(confirmConsequence("Thandi", null, 100, "take_back"))
      .toBe("Take R100.00 back from Thandi? This goes on the ledger and cannot be deleted.");
  });

  it("leaves a receipt on screen rather than a four-second toast", () => {
    expect(doneSentence("Thandi", 470)).toBe("Done. Thandi now has R470.00.");
  });

  it("says what the two-decimal rule is about without naming a unit", () => {
    expect(validateAmount("1.005")).toBe("Amounts go to two decimal places.");
    expect(validateAmount("100")).toBeNull();
    expect(validateAmount("-100")).toBe(MINUS_REFUSED);
  });

  it("follows the club's own symbol through every figure on the sheet", () => {
    setClubCurrencySymbol("CHF");
    expect(balanceSentence("Thandi", 370, 100, "add"))
      .toBe("Thandi has CHF370.00. After +CHF100.00: CHF470.00.");
    expect(doneSentence("Thandi", 470)).toBe("Done. Thandi now has CHF470.00.");
  });

  it("behaves exactly as the default when the club has said nothing usable", () => {
    setClubCurrencySymbol("R50");
    const absent = doneSentence("Thandi", 470);
    resetClubCurrencySymbol();
    expect(absent).toBe(doneSentence("Thandi", 470));
    expect(absent).toContain("R470.00");
  });

  it("carries no 'credit' or 'credits' anywhere a volunteer reads", () => {
    const said = [
      sheetTitle("add", "Thandi"), sheetTitle("take_back", "Thandi"), TAKE_BACK_LINK, ADD_LINK,
      MINUS_REFUSED, balanceSentence("Thandi", null, 100, "take_back"),
      balanceSentence("Thandi", 370, 100, "add"), overdraftWarning(50, 200) ?? "",
      confirmConsequence("Thandi", 370, 100, "take_back"), doneSentence("Thandi", 470),
      validateAmount("1.005") ?? "",
    ];
    for (const line of said) {
      expect(line).not.toMatch(/credits?\b/i);
      expect(line).not.toMatch(/\bcr\b/);
    }
  });
});

describe("what a bulk cancel says it moved", () => {
  it("says the net, the penalty and the nothing-back arm only when each happened", () => {
    expect(cancelTotalsSentence({ succeeded: 2, failed: 0, refundCredits: 270, penaltyCredits: 0, nothingBack: 0 }))
      .toBe("R270.00 goes back.");
    const full = cancelTotalsSentence({ succeeded: 4, failed: 0, refundCredits: 270, penaltyCredits: 30, nothingBack: 1 });
    expect(full).toContain("R30.00 is kept as a late-cancellation penalty.");
    expect(full).toContain("1 booking gets nothing back");
  });

  it("arms the destructive confirm with the figure and who gets emailed", () => {
    expect(cancelConsequence(270, 1)).toBe("R270.00 goes back. 1 member is emailed. This cannot be undone.");
  });

  it("says a per-row outcome in the club's money", () => {
    const row = {
      id: "b1", ok: true as const, status: "cancelled",
      refundCredits: 50, penaltyCredits: 15, nothingBack: false,
    };
    expect(rowOutcome(row as never, "cancel", null)).toBe("Cancelled — R35.00 back, R15.00 penalty kept");
  });

  /**
   * <b>The halt sentence, where "credit" was a mass noun rather than a unit.</b> "Ran out of
   * credit part-way through" is grammatical English and says nothing false — but the product
   * has stopped having a thing called credit, and the sentence reads better against the wallet
   * the admin is about to be offered a way around.
   */
  it("says whose wallet ran dry, and offers the way past it", () => {
    expect(haltSentence("insufficient_balance", "Thandi"))
      .toBe("Thandi's wallet ran out part-way through, so the rest were not attempted. "
        + "You can book the rest anyway and leave them owing.");
  });

  it("still works when the batch could not name the payer", () => {
    expect(haltSentence("insufficient_balance", null))
      .toContain("That member's wallet ran out part-way through");
  });

  it("keeps a halt that is NOT about money as its own, quieter sentence", () => {
    // Three states, not two: a stop with a reason, a stop without one, and no stop at all.
    expect(haltSentence("something_else", "Thandi")).toBe("The batch stopped part-way.");
    expect(haltSentence(null, "Thandi")).toBeNull();
  });

  it("follows the club's own symbol", () => {
    setClubCurrencySymbol("CHF");
    expect(cancelConsequence(270, 2)).toBe("CHF270.00 goes back. 2 members are emailed. This cannot be undone.");
  });
});

describe("the bookings an adjustment can be hung on", () => {
  it("labels each one with the amount in the club's money", () => {
    const rows = [{
      id: "e1", at: "2026-09-22T10:00:00Z", type: "NoShowPenalty",
      amountCredits: -15, signedAmountCredits: -15,
      relatedBookingId: "11111111-2222-3333-4444-555555555555",
    }] as unknown as LedgerRow[];
    const [first] = recentBookingsFrom(rows);
    expect(first.label).toContain("No-show penalty -R15.00");
    expect(first.label).not.toMatch(/credits?\b/i);
  });
});
