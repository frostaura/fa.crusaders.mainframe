import { describe, expect, it } from "vitest";
import { COURTS_COPY } from "./courtsCopy";

/** BA-15: "In use" read as "being played on now" beside the control board; it means bookable. */
describe("a court's bookable switch, in words", () => {
  it("says bookable, never in use", () => {
    expect(COURTS_COPY.count(2, 3)).toBe("2 bookable · 3 courts");
    expect(COURTS_COPY.inUse).toBe("Bookable");
    expect(COURTS_COPY.notInUse).toBe("Hidden from booking");
    for (const words of [COURTS_COPY.count(1, 1), COURTS_COPY.inUse, COURTS_COPY.notInUse, COURTS_COPY.activeOn, COURTS_COPY.activeOff]) {
      expect(words).not.toMatch(/in use/i);
    }
  });
});
