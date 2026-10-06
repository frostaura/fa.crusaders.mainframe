import { describe, expect, it } from "vitest";
import { refusalReason } from "./bookingsCopy";

/** R17 E17-6 / J17-7 — the desk's new cancel 409s are worded on a bulk result row, never "didn't go through". */
describe("bulk cancel rows for BE17b's 409s (R17)", () => {
  it.each([["booking_not_open", /already cancelled/], ["not_cancellable", /isn't open any more/]])("%s", (code, said) => {
    expect(refusalReason(code)).toMatch(said);
    expect(refusalReason(code)).not.toBe("That one didn't go through.");
  });
});
