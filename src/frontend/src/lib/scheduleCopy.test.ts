import { describe, expect, it } from "vitest";
import {
  CHANGES_UNDELETABLE, CHECK_FAILED, CHECK_STALE, CREATE_LABEL, LIST_EMPTY_HINT,
  LIST_EMPTY_TITLE, NOTHING_CHANGED_YET, checkLabel, checkingLabel, clampedNotice,
  clearAllLabel, clubDateLong, clubDateShort, conflictRefundPhrase, conflictsHeadline,
  consequenceLine, courtsPhrase, daysPhrase, editScopeOptions, editScopeQuestion,
  endConsequence, nextOccurrenceLine, nothingInTheWay, occurrenceStatusWord, occurrencesNoun,
  partialMaterialisation, pastNeverChanges, ruleSentence, scheduleCodes, skipChipLabel,
  skipConsequence, weekdayName, weekdayPlural,
} from "./scheduleCopy";

/**
 * Every sentence this surface says, both halves of every conditional, at 0, 1 and 2.
 *
 * <p>
 * The discipline is `doorsCopy`'s, and the reason is the same one that turned door wording
 * into a module: the same sentence is needed in a button's label, in an `aria-label` and in a
 * result row, and the third copy of it is where they start to disagree. On this surface the
 * cost of disagreement is unusually concrete — the primary button's label restates what the
 * admin chose, so that the last thing read before the press is what will happen. A label
 * composed at the call site is a label that can say something the panel above it does not.
 * </p>
 *
 * <p>
 * <b>The absent arm is tested as hard as the present one.</b> Three backend lanes are writing
 * these endpoints right now, so `would_refund_credits`, `next_occurrence` and
 * `materialised_through` will all arrive missing for a while. A sentence that reads a missing
 * refund as zero tells an admin nobody gets their money back, which is the exact opposite of
 * the truth and is read immediately before a destructive press.
 * </p>
 */

describe("weekday words", () => {
  it("names a day and its plural", () => {
    expect(weekdayName("tue")).toBe("Tuesday");
    expect(weekdayPlural("tue")).toBe("Tuesdays");
    expect(weekdayName("thu")).toBe("Thursday");
    expect(weekdayPlural("sat")).toBe("Saturdays");
  });

  it("joins a day set the way a person would say it", () => {
    expect(daysPhrase([])).toBe("no days yet");
    expect(daysPhrase(["tue"])).toBe("Tuesdays");
    expect(daysPhrase(["tue", "thu"])).toBe("Tuesdays and Thursdays");
    expect(daysPhrase(["mon", "wed", "fri"])).toBe("Mondays, Wednesdays and Fridays");
    // Always in week order, whatever order they were ticked in — a sentence that reads
    // "Fridays, Mondays and Wednesdays" makes a reader stop and re-read it.
    expect(daysPhrase(["fri", "mon", "wed"])).toBe("Mondays, Wednesdays and Fridays");
    expect(daysPhrase(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])).toBe("every day");
  });

  it("counts occurrences in the weekday's own word when there is only one weekday", () => {
    expect(occurrencesNoun(10, ["tue"])).toBe("10 Tuesdays");
    expect(occurrencesNoun(1, ["tue"])).toBe("1 Tuesday");
    expect(occurrencesNoun(0, ["tue"])).toBe("no Tuesdays");
    expect(occurrencesNoun(2, ["tue"])).toBe("2 Tuesdays");
    // Two weekdays have no shared noun, so it falls back to a word that is true for both.
    expect(occurrencesNoun(10, ["tue", "thu"])).toBe("10 dates");
    expect(occurrencesNoun(1, ["tue", "thu"])).toBe("1 date");
    expect(occurrencesNoun(0, [])).toBe("no dates");
  });
});

describe("court words", () => {
  it("joins court names the way a person would say them", () => {
    expect(courtsPhrase([])).toBe("no courts yet");
    expect(courtsPhrase(["Court 1"])).toBe("Court 1");
    expect(courtsPhrase(["Court 1", "Court 2"])).toBe("Courts 1 and 2");
    expect(courtsPhrase(["Court 1", "Court 2", "Court 3"])).toBe("Courts 1, 2 and 3");
    // A club whose courts are not called "Court n" keeps its own names in full.
    expect(courtsPhrase(["Glass court", "Back court"])).toBe("Glass court and Back court");
  });
});

describe("dates, written without ever becoming an instant", () => {
  it("writes a club-local date in the club's own format", () => {
    expect(clubDateShort("2026-10-06")).toBe("Tue 6 Oct");
    expect(clubDateLong("2026-10-06")).toBe("6 October 2026");
    // One club date format: three-letter months, "Sep" never "Sept" (R1, F4.10).
    expect(clubDateShort("2026-09-22")).toBe("Tue 22 Sep");
    expect(clubDateLong("2026-12-15")).toBe("15 December 2026");
  });

  it("hands back what it was given rather than inventing a date it cannot read", () => {
    expect(clubDateShort("")).toBe("");
    expect(clubDateShort("not-a-date")).toBe("not-a-date");
  });
});

describe("the sentence and its consequence", () => {
  const base = {
    courtNames: ["Court 1", "Court 2", "Court 3"],
    days: ["tue"] as const,
    start: "18:00",
    end: "21:00",
    label: "League night",
    startDate: "2026-10-06",
    endDate: "2026-11-30",
  };

  it("reads back as one sentence", () => {
    expect(ruleSentence(base)).toBe(
      "Holds Courts 1, 2 and 3 on Tuesdays from 18:00 to 21:00, called “League night”, "
      + "from Tue 6 Oct until Mon 30 Nov.",
    );
  });

  it("says an open-ended series is open-ended rather than leaving the reader to notice", () => {
    expect(ruleSentence({ ...base, endDate: null })).toBe(
      "Holds Courts 1, 2 and 3 on Tuesdays from 18:00 to 21:00, called “League night”, "
      + "from Tue 6 Oct with no end date.",
    );
  });

  it("says every other week when it is every other week", () => {
    expect(ruleSentence({ ...base, intervalWeeks: 2 })).toContain("every 2 weeks on Tuesdays");
    // And does NOT say it for the ordinary case, which would be noise on every row.
    expect(ruleSentence({ ...base, intervalWeeks: 1 })).not.toContain("every 1 week");
  });

  it("states the consequence in slots, courts and members", () => {
    expect(consequenceLine({
      occurrences: 10, days: ["tue"], courtCount: 3, slotsPerOccurrence: 12,
      label: "League night", truncated: false, openEnded: false,
    })).toBe(
      "That is 10 Tuesdays. 3 courts × 12 slots = 360 slots held. "
      + "Members will see “League night” and cannot book them.",
    );
  });

  it("says one court and one slot in the singular", () => {
    expect(consequenceLine({
      occurrences: 1, days: ["tue"], courtCount: 1, slotsPerOccurrence: 1,
      label: "Coaching", truncated: false, openEnded: false,
    })).toBe(
      "That is 1 Tuesday. 1 court × 1 slot = 1 slot held. "
      + "Members will see “Coaching” and cannot book it.",
    );
  });

  it("does not claim a total it cannot know for an open-ended rule", () => {
    const line = consequenceLine({
      occurrences: 9, days: ["tue"], courtCount: 3, slotsPerOccurrence: 12,
      label: "League night", truncated: true, openEnded: true, horizonDays: 60,
    });
    expect(line).toContain("the next 60 days");
    expect(line).toContain("carries on after that");
    // The bare "That is 9 Tuesdays." would be a false total for a series with no end.
    expect(line).not.toBe(consequenceLine({
      occurrences: 9, days: ["tue"], courtCount: 3, slotsPerOccurrence: 12,
      label: "League night", truncated: false, openEnded: false,
    }));
  });

  it("says plainly when the sentence holds nothing at all", () => {
    expect(consequenceLine({
      occurrences: 0, days: ["tue"], courtCount: 3, slotsPerOccurrence: 12,
      label: "League night", truncated: false, openEnded: false,
    })).toBe("That is no Tuesdays in those dates, so nothing would be held.");
  });

  it("asks for the missing half rather than computing a consequence of nothing", () => {
    expect(consequenceLine({
      occurrences: 10, days: ["tue"], courtCount: 3, slotsPerOccurrence: 0,
      label: "League night", truncated: false, openEnded: false,
    })).toBe("Set a start and an end time to see what this would hold.");
    expect(consequenceLine({
      occurrences: 10, days: ["tue"], courtCount: 0, slotsPerOccurrence: 12,
      label: "League night", truncated: false, openEnded: false,
    })).toBe("Choose at least one court to see what this would hold.");
  });

  it("keeps the last clause true when nobody has named the hold yet", () => {
    expect(consequenceLine({
      occurrences: 10, days: ["tue"], courtCount: 3, slotsPerOccurrence: 12,
      label: "", truncated: false, openEnded: false,
    })).toContain("Members will see this hold on the grid and cannot book those slots.");
  });
});

describe("the clash check", () => {
  it("names the count it is about to check, in the weekday's own word", () => {
    expect(checkLabel(10, ["tue"])).toBe("Check 10 Tuesdays");
    expect(checkLabel(1, ["tue"])).toBe("Check 1 Tuesday");
    expect(checkLabel(0, ["tue"])).toBe("Check these dates");
    expect(checkLabel(10, ["tue", "thu"])).toBe("Check 10 dates");
    expect(checkingLabel(10, ["tue"])).toBe("Checking 10 Tuesdays…");
  });

  it("says nothing was created when the check itself failed", () => {
    // The one sentence on this surface that must never be followed by a Save button.
    expect(CHECK_FAILED).toBe("The check didn't finish, so nothing was created. Try again.");
  });

  it("says a check no longer describes the sentence above it", () => {
    expect(CHECK_STALE).toBe(
      "The sentence changed after that check, so it no longer says what would happen. Check again.",
    );
  });

  it("states the all-clear with the numbers it was checking", () => {
    expect(nothingInTheWay({ slots: 360, occurrences: 10, days: ["tue"] })).toBe(
      "Nothing is in the way. All 360 slots are free on all 10 Tuesdays.",
    );
    expect(nothingInTheWay({ slots: 1, occurrences: 1, days: ["tue"] })).toBe(
      "Nothing is in the way. The 1 slot is free on the 1 Tuesday.",
    );
  });

  it("counts what is in the way, and says nothing has happened yet", () => {
    expect(conflictsHeadline(4)).toBe("4 bookings are in the way.");
    expect(conflictsHeadline(1)).toBe("1 booking is in the way.");
    expect(NOTHING_CHANGED_YET).toBe("Nothing has changed yet.");
  });

  it("never reads an unknown refund as nothing", () => {
    expect(conflictRefundPhrase({ would_refund_credits: 36, member_name: "Priya Naidoo" }))
      .toBe("36.00 cr would go back to Priya Naidoo.");
    expect(conflictRefundPhrase({ would_refund_credits: 36 }))
      .toBe("36.00 cr would go back.");
    expect(conflictRefundPhrase({ would_refund_credits: 0, member_name: "Priya Naidoo" }))
      .toBe("Nothing would go back to Priya Naidoo.");
    // The arm that matters: the backend has not shipped the quote yet. "Nothing would go
    // back" is the opposite of the truth and it is read immediately before a refund.
    expect(conflictRefundPhrase({ member_name: "Priya Naidoo" }))
      .toBe("What would go back to Priya Naidoo isn't known yet.");
    expect(conflictRefundPhrase({ would_refund_credits: null }))
      .toBe("What would go back isn't known yet.");
  });

  it("restates the chosen option in the button that does it", () => {
    expect(clearAllLabel(4, 350)).toBe("Cancel 4 bookings and refund 350.00 cr in full");
    expect(clearAllLabel(1, 36)).toBe("Cancel 1 booking and refund 36.00 cr in full");
    // Unknown total, again: the button promises the refund without inventing its size.
    expect(clearAllLabel(4, null)).toBe("Cancel 4 bookings and refund them in full");
    expect(CREATE_LABEL).toBe("Create the hold");
  });
});

describe("refusals, as sentences", () => {
  const codes = scheduleCodes({ sliceMinutes: 15, maxRows: 2000 });

  it("has a sentence for every code D2 §11.8 can answer with", () => {
    for (const code of [
      "schedule_name_invalid", "schedule_name_taken", "schedule_label_invalid",
      "schedule_days_invalid", "schedule_time_range_invalid", "schedule_not_slice_aligned",
      "schedule_interval_out_of_range", "schedule_date_range_invalid", "schedule_courts_invalid",
      "schedule_too_large", "schedule_limit_reached", "schedule_conflicts", "occurrence_in_past",
    ]) {
      expect(codes[code], `no sentence for ${code}`).toBeTruthy();
      expect(codes[code]).not.toContain("undefined");
    }
  });

  it("puts the club's own numbers in the two refusals that are about numbers", () => {
    expect(codes.schedule_not_slice_aligned).toContain("15-minute");
    expect(codes.schedule_too_large).toContain("2000");
    // Vary the fixture: a 30-minute club reads its own number, not the fixture's.
    expect(scheduleCodes({ sliceMinutes: 30 }).schedule_not_slice_aligned).toContain("30-minute");
  });

  it("stays true when the club's numbers are not known", () => {
    const blind = scheduleCodes({});
    expect(blind.schedule_not_slice_aligned).toBe(
      "The start and the end both have to land on one of the club's booking marks.",
    );
    expect(blind.schedule_not_slice_aligned).not.toContain("undefined");
    expect(blind.schedule_too_large).not.toContain("undefined");
  });

  it("says what a conflict at save time means — the world moved, nothing was written", () => {
    expect(codes.schedule_conflicts).toContain("Nothing has been created");
    expect(codes.occurrence_in_past).toContain("already happened");
  });
});

describe("editing", () => {
  // D3 §5.4 writes these sentences around "Tue 4 Nov". 4 November 2026 is a WEDNESDAY, and
  // the weekday in this dialog is derived from the date rather than typed beside it precisely
  // so that a design's example cannot ship as a screen that says the wrong day out loud. The
  // Tuesday the design meant is the 3rd.
  it("asks which dates, in the weekday's own word", () => {
    expect(editScopeQuestion("2026-11-03")).toBe("Change which Tuesdays?");
    expect(editScopeQuestion("2026-11-04")).toBe("Change which Wednesdays?");
    expect(editScopeQuestion("2026-11-07")).toBe("Change which Saturdays?");
  });

  it("offers two options and no third", () => {
    expect(editScopeOptions("2026-11-03")).toEqual({
      only: "Just Tue 3 Nov",
      future: "Tue 3 Nov and every Tuesday after it",
    });
  });

  it("states the third fact whether or not anyone asked", () => {
    expect(pastNeverChanges("2026-11-03")).toBe(
      "Tuesdays before 3 November 2026 never change — what already happened stays as it happened.",
    );
  });

  it("says out loud that a date was moved forward rather than refused", () => {
    expect(clampedNotice("2026-09-22")).toBe(
      "That date has already passed, so the change starts from 22 September 2026 instead. "
      + "Dates before then are unchanged.",
    );
  });
});

describe("skipping and ending", () => {
  it("labels a skipped chip by what pressing it does", () => {
    expect(skipChipLabel("2026-12-16")).toBe("16 December 2026 — restore this Wednesday");
  });

  it("says what opens back up, before the skip happens", () => {
    expect(skipConsequence(3, "2026-12-16")).toBe(
      "3 courts open back up on 16 December 2026. Members will be able to book them.",
    );
    expect(skipConsequence(1, "2026-12-16")).toBe(
      "1 court opens back up on 16 December 2026. Members will be able to book it.",
    );
  });

  it("arms the end of a series with its count, its refunds and what survives", () => {
    expect(endConsequence({ remaining: 9, days: ["tue"], slots: 324, refundCredits: 0 })).toBe(
      "Ending this stops 9 more Tuesdays and releases 324 held slots, which members can then book. "
      + "Nobody is refunded — nobody was charged for a hold. "
      + "Tuesdays that have already happened stay exactly as they are.",
    );
  });

  it("does not promise a release it cannot size", () => {
    const line = endConsequence({ remaining: 9, days: ["tue"], slots: null, refundCredits: 0 });
    expect(line).toContain("stops 9 more Tuesdays");
    expect(line).not.toContain("null");
    expect(line).not.toContain("0 held slots");
  });

  it("does not count the dates ahead when the dates could not be read", () => {
    // "stops 0 more Tuesdays" out of a failed read is the page telling an admin that ending
    // the series costs nothing, in the armed consequence of the control that ends it.
    const line = endConsequence({ remaining: null, days: ["tue"], slots: null, refundCredits: 0 });
    expect(line).toBe(
      "Ending this stops every date still ahead, and the slots it was holding can be booked again. "
      + "Nobody is refunded — nobody was charged for a hold. "
      + "Tuesdays that have already happened stay exactly as they are.",
    );
    expect(line).not.toContain("0 more");
  });
});

describe("the list and the detail page", () => {
  it("teaches the feature in its empty state", () => {
    expect(LIST_EMPTY_TITLE).toBe("No repeating bookings yet.");
    expect(LIST_EMPTY_HINT).toBe(
      "A repeating booking is how you hold Tuesday nights for the league "
      + "without booking 360 slots by hand.",
    );
  });

  it("takes three arms on the next date, because absent is not 'none'", () => {
    expect(nextOccurrenceLine("2026-10-06T16:00:00.000Z", "active", "Africa/Johannesburg"))
      .toBe("Next on Tue 6 Oct, 18:00.");
    expect(nextOccurrenceLine(null, "ended")).toBe("This has ended — there are no more dates.");
    expect(nextOccurrenceLine(null, "active")).toBe("The next date hasn't been worked out yet.");
    expect(nextOccurrenceLine(undefined, undefined)).toBe("The next date hasn't been worked out yet.");
  });

  it("says how much of a series is actually held, and says nothing when it cannot tell", () => {
    expect(partialMaterialisation(8, 10, ["tue"])).toBe(
      "8 of 10 Tuesdays are held. 2 are still being created — check back in a minute.",
    );
    expect(partialMaterialisation(9, 10, ["tue"])).toBe(
      "9 of 10 Tuesdays are held. 1 is still being created — check back in a minute.",
    );
    expect(partialMaterialisation(10, 10, ["tue"])).toBeNull();
    // Unknown is never "all of them", and it is never "none of them" either.
    expect(partialMaterialisation(null, 10, ["tue"])).toBeNull();
  });

  it("names an occurrence's state in a word, including the one it does not know", () => {
    expect(occurrenceStatusWord("scheduled")).toBe("Held");
    expect(occurrenceStatusWord("skipped")).toBe("Skipped");
    expect(occurrenceStatusWord("overridden")).toBe("Moved");
    expect(occurrenceStatusWord("past")).toBe("Already happened");
    expect(occurrenceStatusWord(undefined)).toBe("Not known");
  });

  it("says the record cannot be deleted, in the words the ruling fixes", () => {
    expect(CHANGES_UNDELETABLE).toBe("Nobody can delete these from the app, including admins.");
  });
});

describe("one club date (R1, F4.10)", () => {
  it("writes a calendar date without teaching 'UTC' to the club's zone", async () => {
    const { clubZone, forgetClubZone, rememberClubZone } = await import("./clubZone");
    const { clubCalendarDate } = await import("./clubClock");
    forgetClubZone();
    rememberClubZone("Africa/Johannesburg");
    expect(clubCalendarDate("2026-10-01")).toBe("Thu 1 Oct");
    expect(clubCalendarDate("2026-09-29", { weekday: false, year: true })).toBe("29 Sep 2026");
    expect(clubZone()).toBe("Africa/Johannesburg");
    forgetClubZone();
  });
});
