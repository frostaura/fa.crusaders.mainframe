import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { CANCEL_REFUSAL_TEXT, describeBookingError, provesStaleGrid } from "./bookingErrors";

/**
 * R17 E17-6 / J17-7 (BE17b 12337219) — the club's cancel of a booking that is not open answers 409:
 * `booking_not_open` when it was already cancelled, `not_cancellable {status}` when it was played,
 * missed or is a hold (it was a 404 "no longer there"). Each is said as what it is, and each proves
 * the grid behind the sheet stale. Varied: every status, and one this build does not know.
 */
const refused = (body: object) => new ApiError(409, body);

describe("R17 — the desk's cancel refusals say why", () => {
  it("already cancelled", () => {
    const e = refused({ error: "booking_not_open" });
    expect(describeBookingError(e, "fallback", { action: "cancel" })).toBe(CANCEL_REFUSAL_TEXT.alreadyCancelled);
    expect(provesStaleGrid(e)).toBe(true);
  });

  it.each([
    ["completed", CANCEL_REFUSAL_TEXT.completed],
    ["no_show", CANCEL_REFUSAL_TEXT.no_show],
    ["blocked", CANCEL_REFUSAL_TEXT.blocked],
    ["something_new", CANCEL_REFUSAL_TEXT.other],
  ])("not cancellable: %s", (status, said) => {
    const e = refused({ error: "not_cancellable", status });
    expect(describeBookingError(e, "fallback", { action: "cancel" })).toBe(said);
    expect(said).toMatch(/can't be cancelled|already cancelled|hold/);
    expect(provesStaleGrid(e)).toBe(true);
  });
});

describe("R17 — the conflict panel's per-row words", () => {
  it("names the refusal, and leaves anything else to the generic sentence", async () => {
    const { cancelRefusal } = await import("./bookingErrors");
    expect(cancelRefusal(refused({ error: "not_cancellable", status: "no_show" }))).toBe(CANCEL_REFUSAL_TEXT.no_show);
    expect(cancelRefusal(refused({ error: "booking_not_open" }))).toBe(CANCEL_REFUSAL_TEXT.alreadyCancelled);
    expect(cancelRefusal(refused({ error: "slot_taken" }))).toBeNull();
  });
});
