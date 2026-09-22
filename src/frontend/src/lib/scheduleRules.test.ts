import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { WeeklyRule } from "./scheduleRules";
import {
  addDays, daysBetween, enumerateOccurrences, formatHhMm, inIntervalPhase, isSliceAligned,
  isoWeekStart, parseHhMm, rowsToCreate, slotsHeld, slotsPerOccurrence, validateRule,
  clubToday, weekdayIndex, weekdayOf,
} from "./scheduleRules";

/**
 * The schedule arithmetic, tested where it is actually dangerous: across a DST transition.
 *
 * <p>
 * <b>Why the runner's zone is a fixture here, exactly as it is in `clubClock.test.ts`.</b>
 * `vite.config.ts` pins `TZ=Africa/Johannesburg`, and South Africa has had no daylight saving
 * since 1944. So the one class of defect this module can have — counting a week by adding
 * 604 800 000 milliseconds to an instant, or reading a date string through the *runner's*
 * calendar — is invisible under the default runner. Every case below therefore runs three
 * times: in the club's own zone, in a northern-hemisphere zone whose clocks move
 * (`America/Chicago`, and west of UTC, so a UTC-midnight date string reads as the previous
 * day there), and in a southern-hemisphere zone whose clocks move the other way
 * (`Pacific/Auckland`, and far east of UTC).
 * </p>
 *
 * <p>
 * <b>The rule the whole module is built on: count in LOCAL DATES, never by subtracting
 * hours.</b> A club-local `YYYY-MM-DD` is not an instant and must never become one on the way
 * to being counted. `2026-11-01` in Chicago is a 25-hour day, `2027-03-14` a 23-hour one, and
 * a weekly series that goes through either by instant arithmetic lands an hour out and then,
 * the moment anybody re-derives a date from it, a whole day out. 18:00 stays 18:00 because
 * nothing here ever leaves the local calendar.
 * </p>
 */

/** The club's own zone, a DST zone west of UTC, and a DST zone far east of it. */
const RUNNER_ZONES = ["Africa/Johannesburg", "America/Chicago", "Pacific/Auckland"] as const;

/** A Tuesday. US clocks go back on 2026-11-01, so this season straddles the transition. */
const LEAGUE: WeeklyRule = {
  days: ["tue"],
  start: "18:00",
  end: "21:00",
  startDate: "2026-10-06",
  endDate: "2026-12-15",
};

const realTz = process.env.TZ;
afterAll(() => { process.env.TZ = realTz; });

describe.each(RUNNER_ZONES)("with the runner's own clock in %s", (runnerZone) => {
  beforeEach(() => { process.env.TZ = runnerZone; });

  describe("local-date arithmetic", () => {
    it("adds a day across the hour the clocks go back", () => {
      // 2026-11-01 is 25 hours long in Chicago. The mutant this kills is the obvious one:
      // `const d = new Date(date); d.setDate(d.getDate() + n)` — `new Date("2026-11-01")` is
      // UTC midnight, which is 19:00 on 31 October in Chicago, so the LOCAL setDate lands on
      // 1 November 19:00 and the date read back out of it is the 2nd. One day, silently
      // skipped, only in a zone west of UTC.
      expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
      expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
      // And the hour the clocks go forward, in the other hemisphere's autumn.
      expect(addDays("2027-03-13", 1)).toBe("2027-03-14");
      expect(addDays("2027-03-14", 1)).toBe("2027-03-15");
    });

    it("adds a week as seven local days, whatever the clocks did in between", () => {
      expect(addDays("2026-10-27", 7)).toBe("2026-11-03");
      expect(daysBetween("2026-10-27", "2026-11-03")).toBe(7);
      // Backwards too, and across a year boundary.
      expect(addDays("2027-01-05", -7)).toBe("2026-12-29");
      expect(daysBetween("2026-12-29", "2027-01-05")).toBe(7);
    });

    it("reads a club-local date's weekday from the club's calendar, not the reader's", () => {
      // Chicago is behind UTC, so parsing this string as an instant and asking a LOCAL
      // getDay() answers Monday. It is a Tuesday in the club's calendar and in every other.
      expect(weekdayIndex("2026-10-06")).toBe(2);
      expect(weekdayOf("2026-10-06")).toBe("tue");
      expect(weekdayOf("2026-11-01")).toBe("sun");
      expect(weekdayOf("2026-12-19")).toBe("sat");
    });

    it("puts a date in its ISO week, which starts on Monday", () => {
      expect(isoWeekStart("2026-10-06")).toBe("2026-10-05");
      // A Sunday belongs to the week that STARTED six days earlier, not the one beginning
      // the next day. Getting this backwards shifts every other-week series by one week.
      expect(isoWeekStart("2026-10-11")).toBe("2026-10-05");
      expect(isoWeekStart("2026-10-12")).toBe("2026-10-12");
    });
  });

  describe("the club's today", () => {
    // 2026-09-21 22:30 UTC. It is already Tuesday the 22nd in Johannesburg (+02:00), still
    // Monday the 21st in Chicago (-05:00), and Tuesday the 22nd in Auckland (+12:00).
    const LATE = Date.parse("2026-09-21T22:30:00.000Z");

    it("is the CLUB's calendar day, not the reader's and not UTC's", () => {
      expect(clubToday("Africa/Johannesburg", LATE)).toBe("2026-09-22");
      expect(clubToday("America/Chicago", LATE)).toBe("2026-09-21");
      expect(clubToday("Pacific/Auckland", LATE)).toBe("2026-09-22");
      // This is D3-B01..03's family: a grid whose "today" came out of UTC opened on
      // yesterday every evening for a club east of Greenwich. The default date an admin is
      // offered for a new series is the same question.
      expect(clubToday("UTC", LATE)).toBe("2026-09-21");
    });

    it("falls back to the reader's own day rather than guessing a zone", () => {
      // Nothing here may invent a club zone. With none known, the reader's own calendar day
      // is the honest answer — and the editor's date field is editable, which is what makes
      // that acceptable where a heading reading "club time" would not be.
      process.env.TZ = runnerZone;
      const own = new Date(LATE).toLocaleDateString("en-CA");
      expect(clubToday(undefined, LATE)).toBe(own);
    });
  });

  describe("the interval anchor", () => {
    it("is every week when the interval is 1", () => {
      for (const d of ["2026-10-06", "2026-10-13", "2026-10-20"]) {
        expect(inIntervalPhase(d, "2026-10-06", 1)).toBe(true);
      }
    });

    it("counts whole ISO weeks from the start date's own week", () => {
      expect(inIntervalPhase("2026-10-06", "2026-10-06", 2)).toBe(true);
      expect(inIntervalPhase("2026-10-13", "2026-10-06", 2)).toBe(false);
      expect(inIntervalPhase("2026-10-20", "2026-10-06", 2)).toBe(true);
      // Across the transition, because this is where an hours-based week count drifts.
      // 3 November is four whole ISO weeks after 6 October, so it is on. 10 November is five
      // and is off — and a count that had drifted by even one hour would answer the opposite
      // for both, because 4.99 weeks floors to 4.
      expect(inIntervalPhase("2026-11-03", "2026-10-06", 2)).toBe(true);
      expect(inIntervalPhase("2026-11-10", "2026-10-06", 2)).toBe(false);
    });

    it("treats a missing or nonsense interval as every week rather than as none", () => {
      expect(inIntervalPhase("2026-10-13", "2026-10-06", 0)).toBe(true);
      expect(inIntervalPhase("2026-10-13", "2026-10-06", Number.NaN)).toBe(true);
    });
  });

  describe("enumerating a weekly rule", () => {
    it("lists every Tuesday in the range and nothing else", () => {
      const { dates, openEnded, truncated } = enumerateOccurrences(LEAGUE);
      expect(dates).toEqual([
        "2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27",
        "2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24",
        "2026-12-01", "2026-12-08", "2026-12-15",
      ]);
      expect(openEnded).toBe(false);
      expect(truncated).toBe(false);
    });

    it("keeps 18:00 at 18:00 on both sides of the hour the clocks move", () => {
      // The whole point of storing local minutes past midnight rather than an instant. The
      // last October Tuesday is CDT, the first November one is CST, and the sentence an admin
      // reads — and the sentence the members read on the grid — is the same on both.
      const { dates } = enumerateOccurrences(LEAGUE);
      const beforeTransition = dates.filter((d) => d < "2026-11-01");
      const afterTransition = dates.filter((d) => d > "2026-11-01");
      expect(beforeTransition.length).toBeGreaterThan(0);
      expect(afterTransition.length).toBeGreaterThan(0);
      for (const _ of dates) {
        expect(formatHhMm(parseHhMm(LEAGUE.start)!)).toBe("18:00");
        expect(formatHhMm(parseHhMm(LEAGUE.end)!)).toBe("21:00");
      }
      // And every consecutive pair is seven local days apart — the assertion that fails if
      // anybody ever counts a week in milliseconds.
      for (let i = 1; i < dates.length; i += 1) {
        expect(daysBetween(dates[i - 1], dates[i])).toBe(7);
      }
    });

    it("includes the start date itself when it falls on a chosen day", () => {
      expect(enumerateOccurrences({ ...LEAGUE, startDate: "2026-10-06" }).dates[0]).toBe("2026-10-06");
      // And does not start before it when it does not.
      expect(enumerateOccurrences({ ...LEAGUE, startDate: "2026-10-07" }).dates[0]).toBe("2026-10-13");
    });

    it("includes the end date itself — the range is inclusive at both ends", () => {
      const { dates } = enumerateOccurrences({ ...LEAGUE, endDate: "2026-10-20" });
      expect(dates).toEqual(["2026-10-06", "2026-10-13", "2026-10-20"]);
      // One day earlier and the last Tuesday is gone. An off-by-one here is a league night
      // the club expected and did not get.
      expect(enumerateOccurrences({ ...LEAGUE, endDate: "2026-10-19" }).dates)
        .toEqual(["2026-10-06", "2026-10-13"]);
    });

    it("lists several weekdays in date order, not in weekday order", () => {
      const { dates } = enumerateOccurrences({
        ...LEAGUE, days: ["thu", "tue"], endDate: "2026-10-16",
      });
      expect(dates).toEqual(["2026-10-06", "2026-10-08", "2026-10-13", "2026-10-15"]);
    });

    it("honours the interval, anchored on the start date's week", () => {
      const { dates } = enumerateOccurrences({ ...LEAGUE, intervalWeeks: 2, endDate: "2026-11-17" });
      expect(dates).toEqual(["2026-10-06", "2026-10-20", "2026-11-03", "2026-11-17"]);
    });

    it("runs an open-ended rule to the club's horizon and says it was cut short", () => {
      const open = enumerateOccurrences({ ...LEAGUE, endDate: null }, { horizonDays: 60 });
      expect(open.openEnded).toBe(true);
      expect(open.truncated).toBe(true);
      // 60 days from 6 October is 5 December; the Tuesdays inside that are nine.
      expect(open.dates).toHaveLength(9);
      expect(open.dates[0]).toBe("2026-10-06");
      expect(open.dates.at(-1)).toBe("2026-12-01");
    });

    it("stops at the cap rather than walking a mis-typed century", () => {
      const runaway = enumerateOccurrences({ ...LEAGUE, endDate: "2126-12-15" }, { maxOccurrences: 12 });
      expect(runaway.dates).toHaveLength(12);
      expect(runaway.truncated).toBe(true);
      expect(runaway.openEnded).toBe(false);
    });

    it("returns nothing, and does not throw, for a rule that cannot happen", () => {
      // An empty result is a real answer here — the copy layer says "no Tuesdays in that
      // range" — and it has to be distinguishable from a rule that is simply not typed yet.
      expect(enumerateOccurrences({ ...LEAGUE, days: [] }).dates).toEqual([]);
      expect(enumerateOccurrences({ ...LEAGUE, endDate: "2026-10-05" }).dates).toEqual([]);
      expect(enumerateOccurrences({ ...LEAGUE, startDate: "not-a-date" }).dates).toEqual([]);
    });
  });

  describe("clock faces and slices", () => {
    it("parses and writes a 24-hour face, and refuses anything else", () => {
      expect(parseHhMm("18:00")).toBe(1080);
      expect(parseHhMm("00:00")).toBe(0);
      expect(parseHhMm("06:05")).toBe(365);
      expect(parseHhMm("24:00")).toBeNull();
      expect(parseHhMm("6:05")).toBeNull();
      expect(parseHhMm("18:60")).toBeNull();
      expect(parseHhMm("")).toBeNull();
      expect(formatHhMm(1080)).toBe("18:00");
      expect(formatHhMm(365)).toBe("06:05");
    });

    it("counts the slices one occurrence holds, on each court", () => {
      expect(slotsPerOccurrence(LEAGUE, 15)).toBe(12);
      // Vary the fixture, not the code: the same sentence on a club with half-hour slices
      // holds half as many slots, and the consequence line has to say so.
      expect(slotsPerOccurrence(LEAGUE, 30)).toBe(6);
      expect(slotsPerOccurrence({ ...LEAGUE, start: "18:00", end: "18:15" }, 15)).toBe(1);
      expect(slotsPerOccurrence({ ...LEAGUE, start: "18:00", end: "18:00" }, 15)).toBe(0);
    });

    it("calls a range aligned only when BOTH ends land on a slice boundary", () => {
      expect(isSliceAligned(1080, 1260, 15)).toBe(true);
      // D2's own counterexample, 18:05–20:50, is 165 minutes — a whole multiple of 15. A
      // duration-only check passes it, and it is exactly the off-grid range D2 describes as
      // blanking two extra grid cells every week for a season. Both ends, or neither.
      expect(isSliceAligned(1085, 1250, 15)).toBe(false);
      expect(isSliceAligned(1080, 1250, 15)).toBe(false);
      expect(isSliceAligned(1085, 1260, 15)).toBe(false);
      // On a 30-minute club, 18:00–20:45 stops being aligned although it was on a 15.
      expect(isSliceAligned(1080, 1245, 15)).toBe(true);
      expect(isSliceAligned(1080, 1245, 30)).toBe(false);
    });

    it("measures alignment from the club's day start, not from midnight", () => {
      // A club whose day starts at 06:10 on 20-minute slices has its grid boundaries at
      // 06:10, 06:30, 06:50 … — and 18:00 is not one of them. Measuring from midnight would
      // call it aligned and blank a cell every week.
      expect(isSliceAligned(1080, 1200, 20, 370)).toBe(false);
      expect(isSliceAligned(1090, 1210, 20, 370)).toBe(true);
    });

    it("multiplies out to rows and to held slots", () => {
      expect(rowsToCreate(10, 3)).toBe(30);
      expect(slotsHeld(10, 3, 12)).toBe(360);
      expect(slotsHeld(0, 3, 12)).toBe(0);
    });
  });

  describe("validating a sentence before it may be checked", () => {
    const ctx = { sliceMinutes: 15, dayStartMinute: 360, maxRows: 2000, activeCourtIds: ["c1", "c2", "c3"] };
    const body: WeeklyRule & { name: string; label: string; courtIds: string[] } = {
      name: "Tuesday league", label: "League night", days: ["tue"],
      start: "18:00", end: "21:00", startDate: "2026-10-06", endDate: "2026-12-15",
      intervalWeeks: 1, courtIds: ["c1", "c2", "c3"],
    };

    const codes = (b: Partial<typeof body>) => validateRule({ ...body, ...b }, ctx).map((r) => r.code);

    it("passes a sentence the club could actually run", () => {
      expect(validateRule(body, ctx)).toEqual([]);
    });

    it("names D2's own refusal code for each way the sentence can be wrong", () => {
      expect(codes({ name: "T" })).toContain("schedule_name_invalid");
      expect(codes({ name: "x".repeat(129) })).toContain("schedule_name_invalid");
      expect(codes({ label: "" })).toContain("schedule_label_invalid");
      expect(codes({ days: [] })).toContain("schedule_days_invalid");
      expect(codes({ start: "21:00", end: "18:00" })).toContain("schedule_time_range_invalid");
      expect(codes({ start: "18:00", end: "18:00" })).toContain("schedule_time_range_invalid");
      expect(codes({ start: "18:05", end: "20:50" })).toContain("schedule_not_slice_aligned");
      expect(codes({ intervalWeeks: 9 })).toContain("schedule_interval_out_of_range");
      expect(codes({ intervalWeeks: 0 })).toContain("schedule_interval_out_of_range");
      expect(codes({ endDate: "2026-10-05" })).toContain("schedule_date_range_invalid");
      expect(codes({ courtIds: [] })).toContain("schedule_courts_invalid");
      expect(codes({ courtIds: ["c1", "not-this-club"] })).toContain("schedule_courts_invalid");
    });

    it("carries the number an admin needs with the refusal that mentions one", () => {
      const notAligned = validateRule({ ...body, start: "18:05", end: "20:50" }, ctx)
        .find((r) => r.code === "schedule_not_slice_aligned");
      expect(notAligned?.sliceMinutes).toBe(15);

      const tooLarge = validateRule(
        { ...body, endDate: "2029-12-15" },
        { ...ctx, maxRows: 100 },
      ).find((r) => r.code === "schedule_too_large");
      expect(tooLarge?.rows).toBeGreaterThan(100);
    });

    it("does not refuse a sentence for being too large when it is not", () => {
      expect(codes({})).not.toContain("schedule_too_large");
    });

    it("says nothing about courts it has not been told about", () => {
      // Unknown is never false. A page whose court list has not loaded must not tell an admin
      // their courts are invalid — it must decline to judge.
      expect(validateRule(body, { ...ctx, activeCourtIds: undefined })).toEqual([]);
    });
  });
});
