import { describe, expect, it } from "vitest";
import { selectionCapSentence, selectionCapShort } from "./bookingsCopy";
import { nextDayAction, quotaBannerBody } from "./gridCopy";

/**
 * R9 J9-4 — the daily-cap words. The pill read "2 of 4 on Sun 4 Oct" while the refusal said
 * "That's 2 slots — the most you can book on Sun 4 Oct, the club's daily limit": 2 was what was
 * LEFT, said as the limit. "Try tomorrow" moved on from the SHOWN day, so on Sun 4 Oct it went to
 * Mon 5 Oct — not tomorrow. And a cap a group sets was said as "The club caps it".
 */
describe("J9-4 — the cap is said in the pill's own figures", () => {
  it("names what is already booked and the real limit when some is booked", () => {
    const s = selectionCapSentence(2, "Sun 4 Oct", { booked: 2, max: 4 });
    expect(s).toContain("2 of your 4 slots");
    expect(s).toContain("2 more");
    expect(s).not.toMatch(/That's 2 slots — the most/);
    expect(selectionCapShort(2, "Sun 4 Oct", { booked: 2, max: 4 })).toBe("Limit reached: 4 of 4 on Sun 4 Oct.");
  });

  it("with nothing booked yet the choice IS the limit", () => {
    expect(selectionCapSentence(4, null, { booked: 0, max: 4 })).toMatch(/^That's 4 slots — your daily limit today\./);
  });

  it("never says the club caps it — the cap may be a group's", () => {
    expect(quotaBannerBody(4)).not.toMatch(/club caps/i);
    expect(quotaBannerBody(4)).toContain("Your daily limit is 4 slots");
    expect(selectionCapSentence(1, "Thu 12 Sep")).not.toMatch(/club's daily limit/);
  });

  it("the way on names the day it goes to unless that is tomorrow", () => {
    expect(nextDayAction("2026-10-04", false).label).toBe("Try Mon 5 Oct");
    expect(nextDayAction("2026-10-04", true).label).toBe("Try tomorrow");
  });
});
