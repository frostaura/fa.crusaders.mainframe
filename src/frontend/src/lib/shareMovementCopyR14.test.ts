import { describe, expect, it } from "vitest";
import { shareMovementPlain, shareRowSentence } from "./shareMovementCopy";

/**
 * R14 §9 — a member's wallet reads "The club" for an admin actor. A name that is "The club" must
 * never be cut to a first name ("The took you off…"), and a blank one never names anybody.
 */
const PLACE = { courtName: "Court 3", startsAt: "2030-10-07T16:00:00Z" };

describe("R14 §9 — 'The club' and blank actors read right", () => {
  it.each([
    ["organiser_removed", "The club took you off Court 3 · Mon 7 Oct — 7 minutes came back."],
    ["split_changed", "The club changed the split on Court 3 · Mon 7 Oct — 7 minutes came back."],
  ])("%s with actor 'The club'", (cause, said) => {
    expect(shareMovementPlain(7, cause, undefined, undefined, { place: PLACE, actor: "The club" })).toBe(said);
  });

  it("a blank or whitespace actor names nobody", () => {
    expect(shareMovementPlain(7, "organiser_removed", undefined, undefined, { place: PLACE, actor: "  " }))
      .toBe("The organiser took you off Court 3 · Mon 7 Oct — 7 minutes came back.");
  });

  it("the named path: 'The club' as the other party stays whole", () => {
    expect(shareRowSentence({ side: "partner", signed: 7, place: PLACE, other: "The club", cause: "share_back" }))
      .toBe("7 minutes of your share of Court 3 · Mon 7 Oct came back");
    expect(shareRowSentence({ side: "organiser", signed: -7, place: PLACE, other: "The club", cause: "organiser_removed" }))
      .not.toMatch(/\bThe\b(?! club)/);
  });
});
