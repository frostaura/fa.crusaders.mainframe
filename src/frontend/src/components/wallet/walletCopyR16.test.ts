import { describe, expect, it } from "vitest";
import { movementSentence } from "@/lib/movementCopy";

/**
 * Review round 16 (FE16m) — a money toast stands alone, so it says which booking.
 *
 * J16-4 / E16-4: the no-show sweep, its reversal, a mixed refund-and-charge and a reinstated
 * displacement named no court and no day, though the frame carries both (`court_name` +
 * `booking_starts_at`). E16-4: the pay-for payer's toast said "Oona's court on Court 2".
 */

const where = { place: { courtName: "Court 2", startsAt: "2026-10-05T16:30:00Z" } };
const AT = "Court 2 · Mon 5 Oct, 18:30";

describe("R16 J16-4 — the no-show sweep's toast names the booking", () => {
  it("settled, refund and penalty", () => {
    expect(movementSentence(6, "no_show_settled", [{ reason: "cancellation_refund", delta_minutes: 10 }, { reason: "penalty", delta_minutes: -4 }], where))
      .toBe(`Your missed booking on ${AT} was settled: 10 minutes refunded and 4 minutes charged as a no-show penalty, so 6 minutes came back to your wallet.`);
  });

  it("refunded only", () => {
    expect(movementSentence(10, "no_show_settled", [{ reason: "cancellation_refund", delta_minutes: 10 }], where))
      .toBe(`Your missed booking on ${AT} was refunded: 10 minutes back in your wallet.`);
  });

  it("charged only", () => {
    expect(movementSentence(-4, "no_show_settled", [{ reason: "penalty", delta_minutes: -4 }], where))
      .toBe(`4 minutes went on a no-show charge for your missed booking on ${AT}.`);
  });

  it("the organiser's side, with a partner's share going back", () => {
    expect(movementSentence(-1, "no_show_settled", [
      { reason: "cancellation_refund", delta_minutes: 10 }, { reason: "penalty", delta_minutes: -4 },
      { reason: "share_transfer", delta_minutes: -7, counterparty_name: "Sam Petersen" },
    ], where)).toBe(`Your missed booking on ${AT} was settled: 10 minutes refunded and 4 minutes charged as a no-show penalty, 7 minutes went back to Sam for their share, so 1 minute left your wallet.`);
  });

  it("no place on the wire (an older server): the sentence it always said", () => {
    expect(movementSentence(10, "no_show_settled", [{ reason: "cancellation_refund", delta_minutes: 10 }]))
      .toBe("A missed booking was refunded: 10 minutes back in your wallet.");
  });
});

describe("R16 J16-4 — a reversed no-show names the booking", () => {
  it("own check-in", () => {
    expect(movementSentence(-6, "no_show_reversed", [{ reason: "penalty", delta_minutes: 4 }, { reason: "cancellation_refund", delta_minutes: -10 }], where))
      .toBe(`The no-show on ${AT} was reversed — you were checked in after all: the 4 minutes penalty came back and the 10 minutes refund was taken back, so 6 minutes left your wallet.`);
  });

  it("someone else's check-in", () => {
    expect(movementSentence(-6, "no_show_reversed", [{ reason: "penalty", delta_minutes: 4 }, { reason: "cancellation_refund", delta_minutes: -10 }], { ...where, checkedInBy: "Dan Splitter" }))
      .toBe(`Dan checked in on ${AT}, so the no-show was reversed: the 4 minutes penalty came back and the 10 minutes refund was taken back, so 6 minutes left your wallet.`);
  });

  it("with partners' shares paid again", () => {
    expect(movementSentence(1, "no_show_reversed", [
      { reason: "penalty", delta_minutes: 4 }, { reason: "cancellation_refund", delta_minutes: -10 },
      { reason: "share_transfer", delta_minutes: 7, counterparty_name: "Sam Petersen" },
    ], where)).toBe(`The no-show on ${AT} was reversed — you were checked in after all: the 4 minutes penalty came back and the 10 minutes refund was taken back, 7 minutes came back from Sam for their share, so 1 minute came back to your wallet.`);
  });
});

describe("R16 J16-4 — mixed and reinstated name the booking", () => {
  it("mixed", () => {
    expect(movementSentence(11, "mixed", [{ reason: "cancellation_refund", delta_minutes: 15 }, { reason: "penalty", delta_minutes: -4 }], where))
      .toBe(`Your booking on ${AT}: 15 minutes came back and 4 minutes went on a charge, so 11 minutes came back to your wallet.`);
  });

  it("mixed without a place keeps its sentence", () => {
    expect(movementSentence(11, "mixed", [{ reason: "cancellation_refund", delta_minutes: 15 }, { reason: "penalty", delta_minutes: -4 }]))
      .toBe("15 minutes came back and 4 minutes went on a charge, so 11 minutes came back to your wallet.");
  });

  it.each([
    [-45, `Your refunded booking on ${AT} was reinstated: 45 minutes went back on it.`],
    [45, `Your booking on ${AT} was reinstated: 45 minutes back in your wallet.`],
  ])("reinstated (%i)", (amount, said) => {
    expect(movementSentence(amount, "displaced_reinstated", [], where)).toBe(said);
  });
});

describe("R16 E16-4 — the pay-for payer's toast says whose booking, not whose court", () => {
  it("named", () => {
    expect(movementSentence(-30, "pay_for_charge", [{ reason: "booking_charge", delta_minutes: -30, counterparty_name: "Oona Organiser" }], where))
      .toBe(`30 minutes went on Oona's booking on ${AT}, paid at the box.`);
  });

  it("unnamed", () => {
    expect(movementSentence(-30, "pay_for_charge", [{ reason: "booking_charge", delta_minutes: -30 }], where))
      .toBe(`30 minutes went on another member's booking on ${AT}, paid at the box.`);
  });
});

describe("R16 E16-3 — the club's cancel of a started session names who checked in", () => {
  it("someone else checked in", () => {
    expect(movementSentence(0, "cancelled_no_refund", [], { ...where, cancelledBy: "club", checkedInBy: "Pat Player" }))
      .toBe(`The club cancelled your session on ${AT} — Pat had already checked in, so nothing was refunded.`);
  });

  it("nobody named (the member themself, or an older server): as before", () => {
    expect(movementSentence(0, "cancelled_no_refund", [], { ...where, cancelledBy: "club" }))
      .toBe(`The club cancelled your session on ${AT} — it had started, so nothing was refunded.`);
  });

  it("the partner's side: who checked in, and the share stands", () => {
    expect(movementSentence(0, "cancelled_share_stands", [], { ...where, cancelledBy: "club", checkedInBy: "Pat Player" }))
      .toBe(`The club cancelled ${AT} — Pat had already checked in, so your share stands.`);
  });
});
