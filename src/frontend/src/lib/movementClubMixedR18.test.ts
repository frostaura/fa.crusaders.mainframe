import { describe, expect, it } from "vitest";
import { movementSentence } from "./movementCopy";
import { flyoutHeldNote } from "./walletCopy";

/**
 * R18 E18-1 — the desk cancelled a member's booking inside the penalty window: one `mixed` frame
 * (the refund and the penalty), `cancelled_by: "club"`. It was said as an anonymous "30 minutes
 * came back and 9 minutes went on a charge" — never that the club had cancelled anything.
 */
const PLACE = { courtName: "Court 2", startsAt: "2026-10-09T16:00:00Z" };
const REFUND_AND_PENALTY = [
  { reason: "cancellation_refund", delta_minutes: 30 },
  { reason: "penalty", delta_minutes: -9 },
];

describe("a club's late cancel is said as the club's cancel (R18 E18-1)", () => {
  it("placed: the club, the booking, the refund, the late-cancellation charge, the net", () => {
    const said = movementSentence(21, "mixed", REFUND_AND_PENALTY, { cancelledBy: "club", place: PLACE });
    expect(said).toMatch(/^The club cancelled your booking on Court 2/);
    expect(said).toMatch(/30 minutes came back/);
    expect(said).toMatch(/9 minutes went on a late-cancellation charge/);
  });

  it("unplaced: still the club's cancel", () => {
    expect(movementSentence(21, "mixed", REFUND_AND_PENALTY, { cancelledBy: "club" })).toMatch(/^The club cancelled your booking: /);
  });

  it("the same pair without cancelled_by club keeps its own sentence (the member's own cancel)", () => {
    expect(movementSentence(21, "mixed", REFUND_AND_PENALTY, {})).not.toMatch(/The club cancelled/);
  });
});

describe("the chip flyout's held note (R18 E18-12)", () => {
  it("says what went into, or came out of, what is held", () => {
    expect(flyoutHeldNote("6 min", true)).toBe("6 min held");
    expect(flyoutHeldNote("1 h 15 min", false)).toBe("1 h 15 min freed");
  });
});
