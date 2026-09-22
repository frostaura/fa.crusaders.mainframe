import { describe, expect, it } from "vitest";
import { readBookResults, readCancelResults, summariseBook, summariseCancel } from "./bulkResults";
import { bulkHeading, cancelTotalsSentence } from "./bulkCopy";

/**
 * Reading a batch's outcomes — the screen that moves other people's money in bulk.
 *
 * <p>
 * <b>D2 §5.1: partial failure is data, not a status code.</b> Both routes answer 200 with a
 * per-item array, because each booking is its own money movement behind its own payer lock, a
 * slot collision in a 20-slot league book-out is NORMAL traffic, and the honest answer to a
 * list of ticks is a list of outcomes. So the only thing that can go wrong on the client is
 * misreading the list — a row rendered as a blank because a key was spelt the other way, on
 * the one screen an admin audits a refund from.
 * </p>
 *
 * <p>
 * <b>`already_cancelled` is a SUCCESS.</b> D2 §5.2 is explicit and gives the reason: today
 * `CancelAsync` answers NotFound for a row that is not Booked, so a retried batch whose first
 * attempt half-landed reports its own successes as errors — and an admin reading "6 failed"
 * about six bookings they successfully cancelled forty seconds ago will cancel something else
 * to compensate. Every test below that counts a success exists because of that sentence.
 * </p>
 */

describe("readCancelResults", () => {
  it("reads D2 §5.2's rows as written", () => {
    const rows = readCancelResults({
      requested: 3, succeeded: 2, failed: 1,
      total_refunded_credits: 150, total_penalty_credits: 0,
      results: [
        { booking_id: "b1", status: "cancelled", refund_credits: 100, penalty_credits: 0, member_name: "Priya Naidoo", court_name: "Court 2", starts_at: "2026-09-22T16:00:00Z" },
        { booking_id: "b2", status: "already_cancelled", refund_credits: 0, penalty_credits: 0 },
        { booking_id: "b3", status: "failed", error: "booking_not_found" },
      ],
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: "b1", ok: true, status: "cancelled", refundCredits: 100, memberName: "Priya Naidoo" });
    expect(rows[1].ok).toBe(true);
    expect(rows[2]).toMatchObject({ ok: false, error: "booking_not_found" });
  });

  it("counts a lifted club hold as a success, not as a different kind of failure", () => {
    const rows = readCancelResults({ results: [{ booking_id: "b1", status: "block_lifted" }] });
    expect(rows[0].ok).toBe(true);
    expect(summariseCancel(rows).succeeded).toBe(1);
  });

  it("reads a camelCase server exactly as well as a snake_case one", () => {
    const rows = readCancelResults({
      results: [{ bookingId: "b1", status: "cancelled", refundCredits: 42, penaltyCredits: 8, memberName: "Jason" }],
    });
    expect(rows[0]).toMatchObject({ id: "b1", refundCredits: 42, penaltyCredits: 8, memberName: "Jason" });
  });

  it("treats an unrecognised status as a failure rather than silently as a success", () => {
    // A status this client has never heard of is the server doing something this screen cannot
    // describe. Counting it as done would report a cancellation that may not have happened.
    const rows = readCancelResults({ results: [{ booking_id: "b1", status: "quantum" }] });
    expect(rows[0].ok).toBe(false);
  });

  it("survives a response with no results array at all", () => {
    expect(readCancelResults({})).toEqual([]);
    expect(readCancelResults(null as never)).toEqual([]);
  });

  it("sums what actually came back rather than trusting the envelope's totals", () => {
    // The envelope and the rows disagreeing is a server bug; believing the envelope would
    // print a refund total that no row accounts for, on a screen used to audit refunds.
    const rows = readCancelResults({
      total_refunded_credits: 999,
      results: [
        { booking_id: "b1", status: "cancelled", refund_credits: 100, penalty_credits: 30 },
        { booking_id: "b2", status: "cancelled", refund_credits: 50, penalty_credits: 0 },
      ],
    });
    const totals = summariseCancel(rows);
    expect(totals.refundCredits).toBe(150);
    expect(totals.penaltyCredits).toBe(30);
    expect(totals.succeeded).toBe(2);
  });
});

describe("readBookResults", () => {
  it("reads the four statuses and keeps request order", () => {
    const rows = readBookResults({
      results: [
        { index: 0, status: "booked", booking_id: "b1", court_name: "Court 1", amount_credits: 32 },
        { index: 1, status: "failed", error: "slot_taken", court_name: "Court 2" },
        { index: 2, status: "duplicate", booking_id: "b3" },
        { index: 3, status: "blocked", booking_id: "b4" },
      ],
    });
    expect(rows.map((r) => r.ok)).toEqual([true, false, true, true]);
    expect(rows[0].amountCredits).toBe(32);
    expect(summariseBook(rows).chargedCredits).toBe(32);
  });

  it("carries the halt forward so the retry can be offered with the override", () => {
    const halted = summariseBook(readBookResults({ halted_at: 5, halted_reason: "insufficient_balance" }), {
      halted_at: 5, halted_reason: "insufficient_balance",
    });
    expect(halted.haltedReason).toBe("insufficient_balance");
  });
});

describe("the sentences", () => {
  it("says how many of how many, in the words an admin reads", () => {
    expect(bulkHeading(4, 6)).toBe("4 of 6 done.");
    expect(bulkHeading(1, 1)).toBe("1 of 1 done.");
  });

  it("says the penalty and the nothing-back cases out loud, and only when they happened", () => {
    expect(cancelTotalsSentence({ succeeded: 2, failed: 0, refundCredits: 270, penaltyCredits: 0, nothingBack: 0 }))
      .toBe("R270.00 goes back.");
    const full = cancelTotalsSentence({ succeeded: 4, failed: 0, refundCredits: 270, penaltyCredits: 30, nothingBack: 1 });
    expect(full).toContain("R30.00 is kept as a late-cancellation penalty.");
    // "nothing back once the lights have been on" — said at the moment it costs somebody money.
    expect(full).toContain("1 booking gets nothing back");
  });
});
