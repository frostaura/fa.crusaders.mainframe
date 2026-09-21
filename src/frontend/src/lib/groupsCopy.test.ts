import { describe, expect, it } from "vitest";
import {
  GROUP_REFUSAL_CODES, MOST_RESTRICTIVE_STANDING, addMembersLabel, addResultLine,
  capResolutionSentence, deleteRefusalSentence, emptyIntersectionSentence, explainGroupRefusal,
  groupChangeConsequence, memberCountLine, paintedRunAnnouncement, paintedWeekSentence,
  misalignedWindowNote, previewSummary, ratePerBlockSentence, slicePriceLine,
} from "./groupsCopy";
import { UNLIMITED, capOverrideIsInert } from "./groupRules";
import { ApiError } from "./api";

/**
 * Every sentence this surface says, in one module — the discipline `doorsCopy` established.
 *
 * <p>
 * <b>Both halves of every conditional, and 0 / 1 / 2 for everything countable.</b> The reason
 * copy became a module rather than strings in JSX is that the same sentence is needed in a
 * button label, in an `aria-label` and in a result row, and the third copy is the one that
 * drifts. The reason it is TESTED is narrower: half of these sentences exist to describe a
 * state nobody can reach on purpose — a group whose price the server has not sent, two groups
 * whose times do not overlap — and an untested branch of that kind is discovered by an admin.
 * </p>
 */

/**
 * The fixture club's own week — weekdays 06:00–22:00, Saturday 07:00–20:00, Sunday shut.
 *
 * <p>
 * 372 slots at 15 minutes, which is NOT the 118 in D3 §6.2's worked example: that example is
 * written for a smaller club. The example's SHAPE is what this module owes it — day runs
 * collapsed, the odd day named, the count said against what the club is actually open for —
 * and asserting its arithmetic against a different club would be asserting the prose.
 * </p>
 */
const CLUB_WEEK = {
  mon: [{ start: 360, end: 1320 }], tue: [{ start: 360, end: 1320 }],
  wed: [{ start: 360, end: 1320 }], thu: [{ start: 360, end: 1320 }],
  fri: [{ start: 360, end: 1320 }], sat: [{ start: 420, end: 1200 }],
  sun: [],
};

describe("the standing statement, which is the whole feature in three sentences", () => {
  it("says the rule, the consequence and the thing it does not override", () => {
    expect(MOST_RESTRICTIVE_STANDING).toContain("strictest one wins");
    expect(MOST_RESTRICTIVE_STANDING).toContain("only where both allow it");
    // The half an admin forgets: a group cannot lift the club's own limits.
    expect(MOST_RESTRICTIVE_STANDING).toContain("club-wide limits");
  });
});

describe("the sentence the painter means — the accessible summary, not a decoration", () => {
  /**
   * This sentence is what a screen-reader user gets INSTEAD of a 7 × 56 grid, so it is the
   * primary rendering of the rule and not a caption under it. D3 §6.2's own example.
   */
  it("collapses a run of identical days and names the odd one out", () => {
    const painted = {
      mon: [{ start: 360, end: 960 }], tue: [{ start: 360, end: 960 }], wed: [{ start: 360, end: 960 }],
      thu: [{ start: 360, end: 960 }], fri: [{ start: 360, end: 960 }],
      sat: [{ start: 420, end: 1200 }], sun: [],
    };
    expect(paintedWeekSentence(painted, CLUB_WEEK, 15))
      // Mon–Fri 06:00–16:00 is 40 slots each, Saturday 07:00–20:00 is 52: 252 of the 372 the
      // club is open. The club's Saturday is painted whole and its weekdays are not, which is
      // what makes the two-phrase form the honest rendering rather than a stylistic choice.
      .toBe("Mondays to Fridays 06:00–16:00, and Saturdays 07:00–20:00. 252 of the 372 slots the club is open.");
  });

  it("says AND rather than TO for exactly two days, because “Mondays to Tuesdays” is not English", () => {
    const painted = { mon: [{ start: 360, end: 420 }], tue: [{ start: 360, end: 420 }] };
    expect(paintedWeekSentence(painted, CLUB_WEEK, 15)).toContain("Mondays and Tuesdays 06:00–07:00");
  });

  it("names one day on its own", () => {
    const painted = { wed: [{ start: 1020, end: 1260 }] };
    expect(paintedWeekSentence(painted, CLUB_WEEK, 15)).toContain("Wednesdays 17:00–21:00");
  });

  it("keeps a real gap as two runs on one day", () => {
    const painted = { tue: [{ start: 360, end: 540 }, { start: 1020, end: 1260 }] };
    expect(paintedWeekSentence(painted, CLUB_WEEK, 15)).toContain("Tuesdays 06:00–09:00 and 17:00–21:00");
  });

  /**
   * <b>Nothing painted is the dangerous state and it gets the loudest sentence.</b> An empty
   * painter over a group that HAS windows elsewhere means those members cannot book, and the
   * summary is the only thing on the screen that would ever say so.
   */
  it("says what nothing painted actually means, rather than leaving a blank", () => {
    expect(paintedWeekSentence({}, CLUB_WEEK, 15))
      .toBe("Nothing painted. Members of this group cannot book at any time — paint the hours they are allowed.");
  });

  it("says the whole week plainly when every open hour is painted", () => {
    expect(paintedWeekSentence(CLUB_WEEK, CLUB_WEEK, 15))
      .toBe("Every hour the club is open. All 372 slots.");
  });

  it("counts in the club's OWN slice, not in a 15 it assumed", () => {
    // Vary the fixture, not just the code: at 30 minutes a slice the same club is 186 slots,
    // and a summary that had assumed 15 would tell an admin twice the truth.
    expect(paintedWeekSentence(CLUB_WEEK, CLUB_WEEK, 30)).toBe("Every hour the club is open. All 186 slots.");
  });

  it("counts one slot in the singular", () => {
    const painted = { tue: [{ start: 360, end: 375 }] };
    expect(paintedWeekSentence(painted, CLUB_WEEK, 15)).toContain("1 of the 372 slots");
  });

  /**
   * <b>A surviving mutant found this one.</b> Dropping the clip to the club's own hours left
   * every count green, because no fixture painted outside them — and an admin who drags to the
   * top of the column paints 06:00 on a Saturday the club opens at 07:00. The summary would
   * then have claimed 64 of 372 slots on a day that has 52, which is a sentence nobody can
   * reconcile against the grid in front of them.
   */
  it("counts only what the club is actually open for, however wide the paint goes", () => {
    const painted = { sat: [{ start: 360, end: 1320 }] };
    expect(paintedWeekSentence(painted, CLUB_WEEK, 15)).toContain("52 of the 372 slots");
    // The PHRASE still reads back what was painted, because that is what is on the grid — the
    // count is what has to be true of the club.
    expect(paintedWeekSentence(painted, CLUB_WEEK, 15)).toContain("Saturdays 06:00–22:00");
  });

  /**
   * A saved window that cannot be drawn in whole cells is NARROWED by the painter, which is the
   * right direction to fail for a permission and the wrong thing to do silently: an admin who
   * opened a group to change its name would otherwise save a different rule than they opened.
   */
  it("owns up to a saved time the grid cannot draw, in both the one and the several", () => {
    expect(misalignedWindowNote(["Tuesdays 06:07–09:00"], 15))
      .toBe("One of this group's saved times doesn't line up with the club's 15-minute slots "
        + "(Tuesdays 06:07–09:00). Painting here saves the whole slots inside it, which is "
        + "slightly less time — leave the painter alone and save nothing else if you want it "
        + "kept as it is.");
    expect(misalignedWindowNote(["Tuesdays 06:07–09:00", "Fridays 17:03–21:00"], 15))
      .toContain("Some of this group's saved times");
  });

  it("speaks a painted run once, with the day and both edges", () => {
    expect(paintedRunAnnouncement("tue", 1080, 1260)).toBe("Tuesday 18:00 to 21:00 allowed.");
    expect(paintedRunAnnouncement("tue", 1080, 1260, false)).toBe("Tuesday 18:00 to 21:00 not allowed.");
  });
});

describe("the empty intersection, named rather than rendered as an empty grid", () => {
  it("names the groups and the day, for a member the admin has in mind", () => {
    expect(emptyIntersectionSentence(["League members", "Non-league members"], "tue", "Aisha Patel"))
      .toBe("Aisha Patel is in League members and Non-league members, and their times do not overlap. "
        + "There is nothing she can book on a Tuesday.");
  });

  it("says the same thing without a name when no member is in hand", () => {
    expect(emptyIntersectionSentence(["League members", "Non-league members"], "tue"))
      .toBe("A member in both League members and Non-league members can book nothing on a Tuesday: "
        + "their times do not overlap.");
  });

  it("handles three groups without saying “both”", () => {
    expect(emptyIntersectionSentence(["A", "B", "C"], "sat")).toContain("A, B and C");
    expect(emptyIntersectionSentence(["A", "B", "C"], "sat")).not.toContain("both");
  });
});

describe("the per-day ceiling, said where it is set — item 19", () => {
  it("states the group's own limit and what everybody else gets", () => {
    expect(capResolutionSentence("League or senior", 2, 4))
      .toBe("League or senior members may book 2 slots a day. Everyone else gets the club's 4. "
        + "Admins are never limited.");
  });

  /**
   * <b>Ruling 3: a group may lower a cap and never raise one.</b> D3 §6.3's own example has a
   * group at 8 over a club at 4, which cannot happen — and the failure it would otherwise
   * produce is the worst kind: a save that reports success and changes nothing, for ever.
   */
  it("refuses to claim an override that cannot bite", () => {
    expect(capResolutionSentence("League or senior", 8, 4))
      .toBe("League or senior members may book 4 slots a day — the club's own limit. A group can "
        + "lower that and never raise it, so 8 would change nothing. Admins are never limited.");
  });

  it("says the club's own number where a group overrides nothing", () => {
    expect(capResolutionSentence("Regular", null, 4))
      .toBe("Regular members get the club's limit of 4 slots a day. Admins are never limited.");
  });

  it("says “no limit” rather than “0 slots”, at the club and at the group", () => {
    expect(capResolutionSentence("Regular", null, UNLIMITED))
      .toBe("Regular members have no limit on how many slots they book in a day, because the club "
        + "has not set one. Admins are never limited.");
    expect(capResolutionSentence("Regular", 3, UNLIMITED))
      .toBe("Regular members may book 3 slots a day. Everybody else has no limit, because the club "
        + "has not set one. Admins are never limited.");
  });

  it("says one slot in the singular", () => {
    expect(capResolutionSentence("Regular", 1, 4)).toContain("may book 1 slot a day");
  });

  /**
   * <b>Unknown is never false, and this is the field where it costs most.</b> The club-wide slot
   * ceiling is a key a backend lane is shipping in parallel with this screen, so it will be
   * ABSENT — and "the club has set no limit" is a claim an admin would act on, where "the club's
   * system hasn't said" is the only true sentence available.
   */
  it("will not turn a key the API has not shipped into a club with no limit", () => {
    expect(capResolutionSentence("Regular", null, null))
      .toBe("The club's system hasn't said a limit on slots a day, and Regular doesn't set one "
        + "either — so nothing on this screen limits how many slots a day they book. Admins are "
        + "never limited.");
    expect(capResolutionSentence("Regular", 3, null))
      .toBe("Regular members may book 3 slots a day. The club's system hasn't said what everybody "
        + "else gets. Admins are never limited.");
    // And nothing can be inert against a bound nobody has stated.
    expect(capOverrideIsInert(8, null)).toBe(false);
  });
});

describe("what a slot costs, in the club's own units", () => {
  it("says the court's own price for a group that inherits", () => {
    expect(slicePriceLine({ mode: "inherit_court", credits: 8, courtPrice: 8 }))
      .toBe("One slot costs what the court costs — 8 credits.");
  });

  it("says the multiplier AND the figure it produces", () => {
    expect(slicePriceLine({ mode: "multiplier", credits: 6, courtPrice: 8, multiplierBps: 7_500 }))
      .toBe("One slot costs 6 credits — 0.75× the court's 8.");
  });

  it("says a flat price is flat, because that is the part an admin misreads", () => {
    expect(slicePriceLine({ mode: "flat_per_slice", credits: 12, courtPrice: 8 }))
      .toBe("One slot costs 12 credits, whatever the court charges.");
  });

  it("will not print a price the club's system has not sent", () => {
    expect(slicePriceLine({ mode: "flat_per_slice", credits: 0, courtPrice: 8, unknown: true }))
      .toBe("The club's system hasn't said what one slot costs under this choice yet.");
  });

  /** D3 §6.2: R100 is the club's actual top-up block, and "1.6" means nothing to a volunteer. */
  it("puts the rate in R100 blocks, with what that actually buys", () => {
    expect(ratePerBlockSentence({ creditsPerZar: 1.6, blockZar: 100, slicePrice: 50 }))
      .toBe("R100 buys 160 credits — about 3 slots at today's prices.");
  });

  it("says one slot in the singular and none in words", () => {
    expect(ratePerBlockSentence({ creditsPerZar: 1.6, blockZar: 100, slicePrice: 160 }))
      .toContain("about 1 slot");
    expect(ratePerBlockSentence({ creditsPerZar: 1.6, blockZar: 100, slicePrice: 400 }))
      .toBe("R100 buys 160 credits — not enough for a single slot at today's prices.");
  });

  it("does not divide by a free court", () => {
    expect(ratePerBlockSentence({ creditsPerZar: 1.6, blockZar: 100, slicePrice: 0 }))
      .toBe("R100 buys 160 credits. Courts cost nothing at the moment, so that buys any number of slots.");
  });

  it("says nothing it does not know", () => {
    expect(ratePerBlockSentence({ creditsPerZar: null, blockZar: 100, slicePrice: 50 }))
      .toBe("The club's system hasn't said what R100 buys.");
  });
});

describe("the consequence of moving somebody between groups, stated BEFORE saving", () => {
  it("says what their next top-up buys and what their existing credit does", () => {
    expect(groupChangeConsequence({
      name: "Daniel", creditsPerBlockBefore: 160, creditsPerBlockAfter: 240, blockZar: 100,
    })).toContain("Daniel's next top-up will buy 240 credits per R100 instead of 160. "
      + "Credit he already has does not change.");
  });

  it("says what a slot will cost them, which is the half a group actually changes", () => {
    const said = groupChangeConsequence({ name: "Daniel", sliceBefore: 8, sliceAfter: 12 });
    expect(said).toContain("A slot will cost Daniel 12 credits instead of 8.");
  });

  it("says plainly when nothing about their money changes", () => {
    expect(groupChangeConsequence({ name: "Daniel", sliceBefore: 8, sliceAfter: 8 }))
      .toEqual(["Nothing Daniel pays changes. Which times he may book still might — check the preview."]);
  });

  it("does not invent a consequence out of figures it was not given", () => {
    expect(groupChangeConsequence({ name: "Daniel" }))
      .toEqual(["The club's system hasn't said what this changes for Daniel. Open the preview before saving."]);
  });
});

describe("refusals, as sentences — every code in D2 §4.5's table", () => {
  it("has a sentence for every code the wire can send", () => {
    for (const code of [
      "group_name_invalid", "group_name_taken", "group_description_too_long",
      "group_pricing_mode_invalid", "group_multiplier_out_of_range", "group_flat_price_invalid",
      "group_pricing_field_not_for_mode", "group_max_slots_out_of_range",
      "group_max_minutes_out_of_range", "group_advance_days_out_of_range",
      "group_window_day_invalid", "group_window_range_invalid", "group_windows_too_many",
      "group_windows_overlap", "group_limit_reached", "group_has_members",
      "group_is_system_default", "too_many_members",
    ]) {
      expect(GROUP_REFUSAL_CODES[code], code).toBeTruthy();
      expect(GROUP_REFUSAL_CODES[code], code).not.toMatch(/undefined|_/);
    }
  });

  it("puts the figures the server sent INTO the sentence", () => {
    expect(explainGroupRefusal(new ApiError(409, { error: "group_name_taken", name: "League members" })))
      .toBe("The club already has a group called “League members”. Two groups with one name is an "
        + "admin reading the wrong rule — give this one a different name.");
    expect(explainGroupRefusal(new ApiError(400, { error: "group_window_range_invalid", day: "tue" })))
      .toContain("Tuesday");
    expect(explainGroupRefusal(new ApiError(400, { error: "group_windows_overlap", day: "sat" })))
      .toContain("Saturday");
  });

  it("falls through to a sentence rather than a code for something it has never heard of", () => {
    const said = explainGroupRefusal(new ApiError(400, { error: "flux_capacitor_drift" }));
    expect(said).not.toContain("flux_capacitor_drift");
    expect(said).toMatch(/refused/);
  });

  /**
   * Deleting is REFUSED, not cascaded: a cascade silently changes what every one of those
   * members may book and what they pay, with no screen showing it. The sentence has to carry
   * the escape, or an admin is simply stuck.
   */
  it("explains a refused delete and names archiving as the way out", () => {
    const said = deleteRefusalSentence("group_has_members", { groupName: "Regular", memberCount: 37 });
    expect(said).toContain("37 members");
    expect(said).toContain("Archive");
    expect(said).not.toContain("group_has_members");
  });

  it("explains why the two seeded groups cannot be deleted at all", () => {
    const said = deleteRefusalSentence("group_is_system_default", { groupName: "Regular", memberCount: 0 });
    expect(said).toContain("renamed and edited");
    expect(said).toContain("Archive");
  });

  it("says one member in the singular", () => {
    expect(deleteRefusalSentence("group_has_members", { groupName: "Regular", memberCount: 1 }))
      .toContain("1 member");
  });
});

describe("counts and labels, at 0, 1 and 2", () => {
  it("counts members", () => {
    expect(memberCountLine(0)).toBe("No members yet");
    expect(memberCountLine(1)).toBe("1 member");
    expect(memberCountLine(2)).toBe("2 members");
  });

  it("will not claim a count the server did not send", () => {
    expect(memberCountLine(null)).toBe("Member count not sent");
  });

  it("labels the add button with the number and the group", () => {
    expect(addMembersLabel(7, "League or senior")).toBe("Add 7 members to League or senior");
    expect(addMembersLabel(1, "League or senior")).toBe("Add 1 member to League or senior");
  });

  it("says per item what happened, including the ones that were already in", () => {
    expect(addResultLine({ id: "u1", status: "added" }, "Ada Lovelace")).toBe("Ada Lovelace — added.");
    expect(addResultLine({ id: "u1", status: "already_a_member" }, "Ada Lovelace"))
      .toBe("Ada Lovelace — already in this group; nothing changed.");
    expect(addResultLine({ id: "u1", status: "failed", error: "member_not_found" }, "Ada Lovelace"))
      .toBe("Ada Lovelace — the club's system does not have this member any more.");
  });
});

describe("the preview summary — every rule that bit, with its count", () => {
  it("states the ceiling and each rule that reduced it", () => {
    const said = previewSummary({
      who: "A Regular member", allowedSlots: 84, clubSlots: 118,
      blockedByGroup: 20, ceilingPerDay: 4, daysCounted: 7,
    }).join(" ");
    expect(said).toContain("Can book 84 of the 118 slots the club is open.");
    expect(said).toContain("20 slots are blocked by this group's own times.");
    expect(said).toContain("4 slots a day is the most any one of them can hold");
    // 4 × 7 = 28, and that is the number an admin actually plans against.
    expect(said).toContain("28 slots this week");
  });

  it("says so when nothing at all is blocked, rather than printing a zero", () => {
    const said = previewSummary({
      who: "A Regular member", allowedSlots: 118, clubSlots: 118,
      blockedByGroup: 0, ceilingPerDay: UNLIMITED, daysCounted: 7,
    }).join(" ");
    expect(said).toContain("Nothing is blocked by this group's own times.");
    expect(said).toContain("no per-day limit");
    expect(said).not.toContain("0 slots are blocked");
  });

  it("says the empty week plainly rather than showing a blank grid", () => {
    const said = previewSummary({
      who: "A Regular member", allowedSlots: 0, clubSlots: 118,
      blockedByGroup: 118, ceilingPerDay: 4, daysCounted: 7,
    }).join(" ");
    expect(said).toContain("Can book none of the 118 slots the club is open.");
  });
});
