import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { describeBookingError } from "./bookingErrors";

/**
 * The peak refusal after D2 — groups replaced the member class, and a group can WITHHOLD peak
 * priority. `peak_hours_league_only` then carries `withheld_by_groups: [names]`, and a member told
 * "reserved for league members" who is in the league group needs the group's name to know what to
 * ask the club about.
 */
describe("peak_hours_league_only, with the groups that withheld it", () => {
  const refusal = (extra: Record<string, unknown>) =>
    new ApiError(403, { error: "peak_hours_league_only", peak_start: "17:00", peak_end: "19:00", regular_advance_hours: 1, ...extra });

  it("names the one group that withheld it, and when the slot opens anyway", () => {
    expect(describeBookingError(refusal({ withheld_by_groups: ["Probation"] }), "x"))
      .toBe("17:00–19:00 is peak time. Your group Probation doesn't get early peak booking, so you book peak hours "
        + "like everyone else. You can take it if it's still free an hour before it starts.");
  });

  it("names several, as a list a person reads", () => {
    expect(describeBookingError(refusal({ withheld_by_groups: ["Probation", "Juniors"] }), "x"))
      .toMatch(/Your groups Probation and Juniors don't get early peak booking/);
  });

  it("says what it always said when no group withheld it (the member simply has no priority)", () => {
    expect(describeBookingError(refusal({ withheld_by_groups: [] }), "x"))
      .toBe("17:00–19:00 is reserved for league and senior members until an hour before the slot. "
        + "You can take it if it's still free an hour before it starts.");
  });

  it("still names the group when the figures are missing", () => {
    expect(describeBookingError(new ApiError(403, { error: "peak_hours_league_only", withheld_by_groups: ["Probation"] }), "x"))
      .toMatch(/^Your group Probation doesn't get early peak booking/);
  });
});
