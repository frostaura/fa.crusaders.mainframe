import { describe, expect, it } from "vitest";
import { movementSentence } from "./movementCopy";
import { placeAt } from "./walletCopy";

/**
 * R17 X17-4 / E17-1 — a booking the desk made for a member reached their phone as "30 minutes went
 * on a court booking": no court, no day, and not who made it. BE17b's booking_charge frame carries
 * `court_name` + `booking_starts_at` and, when the club made it, `actor_name: "The club"`.
 */

const PLACE = { courtName: "Court 2", startsAt: "2026-10-09T16:30:00Z" };
const AT = placeAt(PLACE)!;

describe("a booking charge says which booking, and who made it (R17 X17-4 / E17-1)", () => {
  it("the club booked it: named as the club's, with court and day", () => {
    const said = movementSentence(-30, "booking_charge", undefined, { place: PLACE, actorName: "The club" });
    expect(said).toBe(`The club booked you ${AT} — 30 minutes went on it.`);
  });

  it("placed but not the club's (this member's own, from another tab): the booking, no actor", () => {
    expect(movementSentence(-30, "booking_charge", undefined, { place: PLACE })).toBe(`30 minutes went on your booking on ${AT}.`);
  });

  it("the club's, unplaced (an older frame): still the club's", () => {
    expect(movementSentence(-30, "booking_charge", undefined, { actorName: "The club" })).toBe("The club booked you a court — 30 minutes went on it.");
  });

  it("a charge coming back, placed", () => {
    expect(movementSentence(15, "booking_charge", undefined, { place: PLACE })).toBe(`15 minutes came back from your booking on ${AT}.`);
  });

  it("an older frame with neither keeps the plain words", () => {
    expect(movementSentence(-30, "booking_charge")).toBe("30 minutes went on a court booking.");
  });
});
