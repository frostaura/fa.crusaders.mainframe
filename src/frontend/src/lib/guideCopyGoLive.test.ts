import { describe, expect, it } from "vitest";
import { boxStuckSentence, guideSteps, slotSentence } from "./onboardingCopy";

/**
 * Go-live BM-12 — the guide hard-coded "fifteen minutes" (slice_minutes is a tenant setting), said
 * "tap Member code" (the screen is My Code) and promised the club's number on a code screen that
 * said the club had given none.
 */
const text = (input: Parameters<typeof guideSteps>[0]) => guideSteps(input).flatMap((s) => s.body).join("\n");

describe("the guide says what is true at THIS club (BM-12)", () => {
  it("names the club's own slot length, whatever it is", () => {
    expect(text({ sliceMinutes: 15 })).toContain("Each box is one court for 15 minutes.");
    expect(text({ sliceMinutes: 30 })).toContain("Each box is one court for 30 minutes.");
    expect(text({ sliceMinutes: 30 })).not.toMatch(/fifteen/i);
  });

  it("claims no length while the slot is unknown", () => {
    expect(slotSentence(null)).not.toMatch(/\d|fifteen/i);
    expect(text({})).toContain(slotSentence(null));
  });

  it("calls the screen My Code, never Member code", () => {
    expect(text({})).toContain("open My Code");
    expect(text({})).not.toMatch(/Member code/);
  });

  it("points at the number only where the club has given one", () => {
    expect(text({ contact: "yes" })).toContain("the club's number is at the bottom of your code screen");
    expect(boxStuckSentence("no")).not.toMatch(/bottom of your code screen/);
    expect(text({ contact: "no" })).toContain(boxStuckSentence("no"));
    expect(boxStuckSentence("unknown")).toMatch(/If the club has given the app a number/);
  });
});
