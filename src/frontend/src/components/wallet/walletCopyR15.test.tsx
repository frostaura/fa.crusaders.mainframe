import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { LedgerRow } from "@/lib/api";
import { movementSentence, shareGroupSentence } from "@/lib/walletCopy";
import { shareMovementPlain, shareRowSentence } from "@/lib/shareMovementCopy";
import { DETAIL_CANCELLED } from "@/lib/playersCopy";
import { renderPage, stubFetch } from "@/test/harness";
import { LedgerTable } from "../LedgerTable";
import { shareBookingsFrom } from "./useShareBookings";

/** Review round 15 (FE15m) — the member's money words: names, days and start times. */

const ME = "44444444-4444-4444-4444-444444444444";
const OLIVIA = "77777777-7777-7777-7777-777777777777";
const ADMIN = "99999999-9999-9999-9999-999999999999";
const COURT4 = { courtName: "Court 4", startsAt: "2026-10-17T16:00:00Z" };

afterEach(() => { vi.unstubAllGlobals(); });

describe("R15 J15-8 — a share group's line says its start time", () => {
  it("two games on one court and day read apart", () => {
    const early = shareGroupSentence({ side: "partner", net: -7, place: { courtName: "Court 1", startsAt: "2026-09-30T16:00:00Z" }, partners: null });
    const late = shareGroupSentence({ side: "partner", net: -7, place: { courtName: "Court 1", startsAt: "2026-09-30T17:00:00Z" }, partners: null });
    expect(early).toBe("Your share · Court 1 · Wed 30 Sep, 18:00");
    expect(late).toBe("Your share · Court 1 · Wed 30 Sep, 19:00");
  });
});

describe("R15 J15-5 — a share toast carries the day", () => {
  it("named: a partner paid (one partner), the organiser's side", () => {
    expect(shareRowSentence({ side: "organiser", signed: 7, place: COURT4, other: "Sid O'Partner", dated: true }))
      .toBe("Sid paid you 7 minutes for their share of Court 4 · Sat 17 Oct");
  });

  it("named: the club collected it", () => {
    expect(shareRowSentence({ side: "organiser", signed: 25, place: COURT4, other: "Tess Thirdwheel Jr", cause: "club_collected", dated: true }))
      .toBe("Tess paid you 25 minutes for their share of Court 4 · Sat 17 Oct — the club collected it");
  });

  it("named: the club cancelled, the partner's side", () => {
    expect(shareRowSentence({ side: "partner", signed: 15, place: COURT4, other: "Owen Organiser", cause: "booking_cancelled", cancelledBy: "club", dated: true }))
      .toBe("15 minutes of your share of Court 4 · Sat 17 Oct came back — the club cancelled the booking");
  });

  it("a ledger line under its group keeps the court alone", () => {
    expect(shareRowSentence({ side: "organiser", signed: 7, place: COURT4, other: "Sid O'Partner" }))
      .toBe("Sid paid you 7 minutes for their share of Court 4");
  });

  it("plain (booking unreadable), placed by the frame: a share paid, and a share collected", () => {
    expect(shareMovementPlain(-7, "share_paid", undefined, undefined, { place: COURT4 }))
      .toBe("7 minutes went on your share of Court 4 · Sat 17 Oct.");
    expect(shareMovementPlain(25, "club_collected", undefined, undefined, { place: COURT4 }))
      .toBe("25 minutes came in for a share of Court 4 · Sat 17 Oct — the club collected it.");
  });
});

describe("R15 E15-7 — a pay-for toast names the person, the court and the day", () => {
  const where = { place: { courtName: "Court 2", startsAt: "2026-10-05T16:30:00Z" } };

  it("the booker: who paid, on which court and when", () => {
    expect(movementSentence(30, "pay_for_refund", [{ reason: "cancellation_refund", delta_minutes: 30, counterparty_name: "Vic Volunteer" }], where))
      .toBe("Vic paid for your booking on Court 2 · Mon 5 Oct, 18:30 at the court, so its 30 minutes came back to your wallet.");
  });

  it("the volunteer: whose court, and when", () => {
    expect(movementSentence(-30, "pay_for_charge", [{ reason: "booking_charge", delta_minutes: -30, counterparty_name: "Bea Booker" }], where))
      .toBe("30 minutes went on Bea's court on Court 2 · Mon 5 Oct, 18:30, paid at the box.");
  });

  it("no name on the wire (an older server): still the court and the day", () => {
    expect(movementSentence(30, "pay_for_refund", [{ reason: "cancellation_refund", delta_minutes: 30 }], where))
      .toBe("Another member paid for your booking on Court 2 · Mon 5 Oct, 18:30 at the court, so its 30 minutes came back to your wallet.");
  });
});

describe("R15 J14-7 — the cancelled Money panel's partners, counted", () => {
  it("one partner is one share, by name", () => {
    expect(DETAIL_CANCELLED.splitRefundNote(null, ["Sam"]))
      .toBe("You got back what you paid for the court, less the share Sam had paid you — that went straight back to Sam.");
    expect(DETAIL_CANCELLED.splitRefundPenaltyNote("Olga", "15 minutes", ["Sam"])).toMatch(/less the share Sam had paid them — that went straight back to Sam\.$/);
  });

  it("two partners: their shares, both named", () => {
    expect(DETAIL_CANCELLED.splitRefundNote(null, ["Sam", "Alex"]))
      .toBe("You got back what you paid for the court, less the shares Sam and Alex had paid you — those went straight back to them.");
  });
});

/** R15 J15-7 / E15-9 — a share line names the person the To / From column names. */
function row(id: string, signed: number, actor: string, other: string): LedgerRow {
  return {
    id, at: "2026-10-05T16:03:00Z", from: signed < 0 ? "Me Member" : other, to: signed < 0 ? other : "Me Member",
    amountMinutes: Math.abs(signed), signedAmountMinutes: signed, type: "ShareTransfer", comment: "Share of a split booking",
    subjectUserId: ME, subjectName: "Me Member", actorUserId: actor, actorName: null, relatedBookingId: "b1",
  };
}

describe("R15 J15-7 / E15-9 — share lines name the other member", () => {
  it("booking unreadable: 'moved to Olivia', never 'moved to the organiser'", async () => {
    stubFetch([]);
    renderPage(<LedgerTable rows={[row("s1", -7, ME, "Olivia Organiser")]} label="Wallet ledger" groupShares shareBookings={shareBookingsFrom({ b1: null })} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Your share/ }));
    expect(await screen.findByText("7 minutes moved to Olivia for your share of a split booking")).toBeInTheDocument();
    expect(screen.queryByText(/the organiser for your share/)).toBeNull();
  });

  it("a club collection (an admin acted): 'Tess paid you', never 'A partner paid you'", async () => {
    stubFetch([]);
    const booking = {
      booking_id: "b1", court_name: "Court 4", starts_at: "2026-10-15T16:00:00Z",
      organiser: { user_id: ME, name: "Me Member", photo_url: null }, partners: [{ user_id: OLIVIA, name: "Olivia Other", paid_minutes: 0 }],
    };
    renderPage(<LedgerTable rows={[row("s1", 25, ADMIN, "Tess Thirdwheel Jr")]} label="Wallet ledger" groupShares shareBookings={shareBookingsFrom({ b1: booking })} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Shares for Court 4/ }));
    expect(await screen.findByText("Tess paid you 25 minutes for their share of Court 4")).toBeInTheDocument();
    expect(screen.queryByText(/A partner paid you/)).toBeNull();
  });
});
