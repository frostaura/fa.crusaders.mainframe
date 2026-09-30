import { describe, expect, it } from "vitest";
import { quotaCellLabel } from "./gridCopy";

/**
 * R2 F1-5 — a quota-locked cell's accessible name said "…your 4 slots for today" on Thursday's
 * grid. The count is the SHOWN day's, so the name says which day unless it is today.
 */
describe("quotaCellLabel", () => {
  it("says 'for today' on today's grid", () => {
    expect(quotaCellLabel("Court 1 at 17:00", 4, null)).toBe("Court 1 at 17:00 — you've booked your 4 slots for today");
  });

  it("names the day on any other day's grid", () => {
    expect(quotaCellLabel("Court 1 at 17:00", 4, "Thu 1 Oct")).toBe("Court 1 at 17:00 — you've booked your 4 slots on Thu 1 Oct");
  });

  it("is singular for a one-slot cap", () => {
    expect(quotaCellLabel("Court 1 at 17:00", 1, "Thu 1 Oct")).toBe("Court 1 at 17:00 — you've booked your 1 slot on Thu 1 Oct");
  });
});
