import { describe, expect, it } from "vitest";
import { memberLedgerComment, movementSentence } from "./walletCopy";
import { shareMovementPlain } from "./shareMovementCopy";

/**
 * R13 — the money toasts' words (lane FC13).
 * X13-2 / J13-8 / E13-6: the organiser's club-cancel toast said "went back to your partners for their
 * shares" with ONE partner, and named nobody, while their own cancel sheet names each ("Back to Sam").
 * X13-3 / E13-6: the partner's share-return toast on a club cancel said "the booking was cancelled" —
 * not that the club cancelled it — although the frame carries `cancelled_by: "club"`.
 * J13-4: a member the club took off a game was told "A share of a split booking moved 10 minutes…":
 * no court, and not that it was THEIR share coming back.
 */

const refund = (n: number) => ({ reason: "cancellation_refund", delta_minutes: n });
const share = (n: number, name?: string | null) => ({ reason: "share_transfer", delta_minutes: n, ...(name === undefined ? {} : { counterparty_name: name }) });

describe("R13 X13-2 — the organiser's club-cancel toast names each partner", () => {
  it("one partner, named: singular, by first name", () => {
    expect(movementSentence(23, "cancellation_refund", [refund(30), share(-7, "Sam Partner")], { cancelledBy: "club" }))
      .toBe("The club cancelled your booking: 30 minutes came back, 7 minutes went back to Sam for their share, so 23 minutes came back to your wallet.");
  });
  it("two partners, named: each with their own figure", () => {
    expect(movementSentence(16, "cancellation_refund", [refund(30), share(-7, "Sam Partner"), share(-7, "Nomsa Dube")], { cancelledBy: "club" }))
      .toBe("The club cancelled your booking: 30 minutes came back, 7 minutes went back to Sam and 7 minutes to Nomsa for their shares, so 16 minutes came back to your wallet.");
  });
  it("two rows for one partner are one figure", () => {
    expect(movementSentence(16, "cancellation_refund", [refund(30), share(-7, "Sam Partner"), share(-7, "Sam Partner")], { cancelledBy: "club" }))
      .toBe("The club cancelled your booking: 30 minutes came back, 14 minutes went back to Sam for their share, so 16 minutes came back to your wallet.");
  });
  it("one partner, no name on the wire: 'your partner', singular — never 'your partners'", () => {
    const said = movementSentence(15, "cancellation_refund", [refund(30), share(-15)], { cancelledBy: "club" });
    expect(said).toBe("The club cancelled your booking: 30 minutes came back, 15 minutes went back to your partner for their share, so 15 minutes came back to your wallet.");
    expect(said).not.toMatch(/partners/);
  });
  it("two partners, no names: counted", () => {
    expect(movementSentence(16, "cancellation_refund", [refund(30), share(-7, null), share(-7, null)], { cancelledBy: "club" }))
      .toBe("The club cancelled your booking: 30 minutes came back, 14 minutes went back to your 2 partners for their shares, so 16 minutes came back to your wallet.");
  });
  it("a late-cancellation charge is still said, after the partners", () => {
    expect(movementSentence(8, "cancellation_refund", [refund(30), share(-7, "Sam Partner"), { reason: "penalty", delta_minutes: -15 }], { cancelledBy: "club" }))
      .toBe("The club cancelled your booking: 30 minutes came back, 7 minutes went back to Sam for their share, 15 minutes went on a late-cancellation charge, so 8 minutes came back to your wallet.");
  });
});

describe("R13 X13-3 — the partner is told the club cancelled", () => {
  it("cancelled_by club: 'the club cancelled the booking'", () => {
    expect(shareMovementPlain(7, "booking_cancelled", undefined, undefined, { cancelledBy: "club" }))
      .toBe("7 minutes of your share of a split booking came back — the club cancelled the booking.");
  });
  it("cancelled_by member (the organiser): 'the booking was cancelled'", () => {
    expect(shareMovementPlain(7, "booking_cancelled", undefined, undefined, { cancelledBy: "member" }))
      .toBe("7 minutes of your share of a split booking came back — the booking was cancelled.");
  });
  it("names the court when the frame carries it", () => {
    expect(shareMovementPlain(7, "booking_cancelled", undefined, undefined, { cancelledBy: "club", place: { courtName: "Court 4", startsAt: "2026-10-05T10:00:00Z" } }))
      .toBe("7 minutes of your share of Court 4 · Mon 5 Oct came back — the club cancelled the booking.");
  });
});

describe("R13 J13-4 — a member taken off a game is told their share came back", () => {
  it("club_removed, no booking readable: 'your share … came back — the club took you off the game'", () => {
    expect(shareMovementPlain(10, "club_removed", undefined))
      .toBe("The club took you off the game — 10 minutes came back.");
  });
  it("club_removed with the court from the frame", () => {
    expect(shareMovementPlain(10, "club_removed", undefined, undefined, { place: { courtName: "Court 1", startsAt: "2026-10-05T10:00:00Z" } }))
      .toBe("The club took you off Court 1 · Mon 5 Oct — 10 minutes came back.");
  });
  it("an organiser paid a share is unchanged; no cause is unchanged", () => {
    expect(shareMovementPlain(10, "share_paid", undefined)).toBe("A share of a split booking moved 10 minutes into your wallet.");
    expect(shareMovementPlain(10, undefined, undefined)).toBe("A share of a split booking moved 10 minutes into your wallet.");
  });
});

/**
 * R13 E13-5 (contract C13-2) — the sweep and a late reversal on a SHARED booking are one frame: the
 * settlement's rows and the partners' share rows together. The share rows are not part of the
 * penalty or the refund — they are said as what went back to (or came back from) the partners.
 */
describe("R13 E13-5 — one sentence for a settlement with the partners' shares in it", () => {
  const pen = (n: number) => ({ reason: "penalty", delta_minutes: n });
  it("no-show sweep, one partner (C13-2's first example): the penalty is 4, not 10", () => {
    const said = movementSentence(5, "no_show_settled", [refund(15), pen(-4), share(-6)]);
    expect(said).toBe("A missed booking was settled: 15 minutes refunded and 4 minutes charged as a no-show penalty, 6 minutes went back to your partner for their share, so 5 minutes came back to your wallet.");
  });
  it("no-show sweep, two named partners", () => {
    expect(movementSentence(-1, "no_show_settled", [refund(15), pen(-4), share(-6, "Sam Partner"), share(-6, "Nomsa Dube")]))
      .toBe("A missed booking was settled: 15 minutes refunded and 4 minutes charged as a no-show penalty, 6 minutes went back to Sam and 6 minutes to Nomsa for their shares, so 1 minute left your wallet.");
  });
  it("outage sweep with a partner: refunded, the share went back, the net", () => {
    expect(movementSentence(8, "outage_refund", [refund(15), share(-7)]))
      .toBe("The court's box was offline, so your booking was refunded: 15 minutes came back, 7 minutes went back to your partner for their share, so 8 minutes came back to your wallet.");
  });
  it("outage refund reversed by the partner's scan (C13-2's second example)", () => {
    const said = movementSentence(-8, "outage_refund_reversed", [refund(-15), share(7)], { checkedInBy: "Pat Partner" });
    expect(said).toBe("Pat Partner checked in, so the outage refund was taken back: the 15 minutes refund was taken back, 7 minutes came back from your partner for their share, so 8 minutes left your wallet.");
    expect(said).not.toMatch(/you were checked in/);
  });
  it("no-show reversed with two partners paying again", () => {
    expect(movementSentence(-1, "no_show_reversed", [pen(4), refund(-15), share(5, "Sam Partner"), share(5, "Nomsa Dube")], { checkedInBy: "Sam Partner" }))
      .toBe("Sam Partner checked in, so the no-show was reversed: the 4 minutes penalty came back and the 15 minutes refund was taken back, 5 minutes came back from Sam and 5 minutes from Nomsa for their shares, so 1 minute left your wallet.");
  });
  it("without share rows the R10/R12 sentences are unchanged", () => {
    expect(movementSentence(11, "no_show_settled", [refund(15), pen(-4)]))
      .toBe("A missed booking was settled: 15 minutes refunded and 4 minutes charged as a no-show penalty, so 11 minutes came back to your wallet.");
    expect(movementSentence(15, "outage_refund", [refund(15)])).toBe("The court's box was offline, so your booking was refunded: 15 minutes back in your wallet.");
  });
});

/**
 * R13 E13-3 (contract C13-5) — the stored outage-reversal reason names the scanner when it was
 * somebody else; the wallet says that as stored. Only the club's "the member was checked in" (the
 * payer's own scan) becomes "you were checked in".
 */
describe("R13 E13-3 — the wallet never says 'you were checked in' for somebody else's scan", () => {
  it("a named scanner is left as stored", () => {
    expect(memberLedgerComment("Outage refund reversed — Pat Partner checked in after all"))
      .toBe("Outage refund reversed — Pat Partner checked in after all");
    expect(memberLedgerComment("Outage refund reversed — Pat Partner checked in after all, net of the desk's own adjustment"))
      .not.toMatch(/you were/);
  });
  it("the payer's own scan is said to them", () => {
    expect(memberLedgerComment("Outage refund reversed — the member was checked in after all, net of the desk's own adjustment"))
      .toBe("Outage refund reversed — you were checked in after all, net of the desk's own adjustment");
  });
});
