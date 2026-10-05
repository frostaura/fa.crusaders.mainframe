import { describe, expect, it } from "vitest";
import { CHANGE_SPLIT, DETAIL_ACTIONS, DETAIL_ADMIN, acceptedLine } from "@/lib/playersCopy";

/** R15 J15-11 — the UI's words agree with their figures and say what this act did. */
describe("R15 J15-11 — verbs agree with the amount", () => {
  it("Remove: '20 minutes they paid go back'; one minute 'goes'", () => {
    expect(DETAIL_ACTIONS.removeBodyFor("Sid", { paid: 20, share: 20 })).toContain("the 20 minutes they paid go back to them");
    expect(DETAIL_ACTIONS.removeBodyFor("Sid", { paid: 1, share: 0 })).toContain("the 1 minute they paid goes back to them");
  });

  it("Change split: '15 minutes go back to Tess'; '1 minute goes back'", () => {
    expect(CHANGE_SPLIT.goesBack("Tess", "15 minutes")).toBe("15 minutes go back to Tess.");
    expect(CHANGE_SPLIT.goesBack("Tess", "1 minute")).toBe("1 minute goes back to Tess.");
    expect(CHANGE_SPLIT.goesBack("Tess", "1 hour")).toBe("1 hour goes back to Tess.");
  });

  it("the return's go-ahead agrees too", () => {
    expect(DETAIL_ADMIN.overdraftReturn("Mia Member", { returned: "20 minutes", covered: "5 minutes", short: "15 minutes", partner: "Sid" }))
      .toContain("20 minutes go back to Sid, 5 minutes of it are covered");
  });
});

describe("R15 J15-11 — the accept's confirmation says what this accept paid", () => {
  it("'Accept and pay 10 minutes' on a seat already paid 20: 10 paid to Mia, 30 in all", () => {
    expect(acceptedLine(10, "Mia", 30)).toBe("10 minutes paid to Mia — 30 minutes in all. See you on court.");
  });

  it("a first payment: just what was paid", () => {
    expect(acceptedLine(22, "Sam", 22)).toBe("22 minutes paid to Sam. See you on court.");
    expect(acceptedLine(0, "Sam", 20)).toBe("See you on court.");
  });
});
