import { describe, expect, it } from "vitest";
import { clubDayOf, gridNow, shiftClubDay } from "./gridClock";

/**
 * The club's day, and the grid's own clock.
 *
 * <p>
 * <b>D3-B03 / D4 §2.2.</b> `pages/Schedule.tsx` computed "today" as
 * <code>new Date().toISOString().slice(0,10)</code> — the UTC day — while every row label on
 * the same screen was drawn in the club's zone. Multi-tenancy is structural, so this is not a
 * theoretical club: any club west of UTC opens the console in the evening and is shown
 * TOMORROW's grid, and any club far enough east is shown yesterday's in the early morning.
 * </p>
 *
 * <p>
 * <b>D3-B02.</b> The same page stamped "now" once, at load, and every cell compared against
 * that stamp for the life of the tab. A console left open on the club desk went on selling
 * slots that had already started. {@link gridNow} is the fix's arithmetic, tested away from
 * React: the threshold that decides Past moves in slice steps, so the grid repaints once a
 * slice rather than once a second, and the peak clock moves in minute steps ROUNDED UP,
 * because rounding down would make the advance rule more restrictive than the server's and
 * the client must always fail towards offering a slot.
 * </p>
 */
describe("clubDayOf", () => {
  it("answers the club's calendar day, not the browser's, for a club west of UTC", () => {
    // 03:00 UTC on the 22nd is still 21:00 on the 21st in Denver.
    const at = Date.parse("2026-09-22T03:00:00.000Z");
    expect(clubDayOf(at, "America/Denver")).toBe("2026-09-21");
    expect(clubDayOf(at, "UTC")).toBe("2026-09-22");
  });

  it("answers the club's day for a club east of UTC", () => {
    const at = Date.parse("2026-09-21T13:00:00.000Z");
    expect(clubDayOf(at, "Pacific/Auckland")).toBe("2026-09-22");
    expect(clubDayOf(at, "Africa/Johannesburg")).toBe("2026-09-21");
  });

  it("answers the same day either side of a DST jump, in the club's own zone", () => {
    // Santiago springs forward at 00:00 on 2026-09-06; the local date is the 6th on both sides.
    expect(clubDayOf(Date.parse("2026-09-06T03:30:00.000Z"), "America/Santiago")).toBe("2026-09-05");
    expect(clubDayOf(Date.parse("2026-09-06T05:30:00.000Z"), "America/Santiago")).toBe("2026-09-06");
  });

  it("falls back to the reader's own clock rather than guessing when no zone is known", () => {
    // The suite pins TZ to Africa/Johannesburg, so this is the reader's day, and it is the
    // honest answer until the club has told us its zone — never a hardcoded UTC.
    const at = Date.parse("2026-09-21T22:30:00.000Z");
    expect(clubDayOf(at, undefined)).toBe("2026-09-22");
  });

  it("refuses to be broken by a zone this engine cannot format in", () => {
    // The zone comes from a settings column an admin types into. A RangeError here is a
    // blank page, so a typo answers the reader's day rather than throwing.
    expect(clubDayOf(Date.parse("2026-09-21T10:00:00.000Z"), "Africa/Johanesburg")).toBe("2026-09-21");
  });
});

describe("shiftClubDay", () => {
  it("moves whole calendar days without going through a UTC instant", () => {
    expect(shiftClubDay("2026-09-21", 1)).toBe("2026-09-22");
    expect(shiftClubDay("2026-09-21", -1)).toBe("2026-09-20");
    expect(shiftClubDay("2026-03-01", -1)).toBe("2026-02-28");
    // The day either side of a spring-forward is still one calendar day away.
    expect(shiftClubDay("2026-09-05", 1)).toBe("2026-09-06");
  });
});

describe("gridNow", () => {
  const starts = [
    Date.parse("2026-09-21T06:00:00.000Z"),
    Date.parse("2026-09-21T06:15:00.000Z"),
    Date.parse("2026-09-21T06:30:00.000Z"),
  ];

  it("marks a row past the moment it starts, not a slice later", () => {
    const now = gridNow(starts, Date.parse("2026-09-21T06:15:00.000Z"));
    expect(now.pastThresholdMs).toBe(starts[1]);
  });

  it("holds the threshold still between boundaries, so the grid repaints once a slice", () => {
    const a = gridNow(starts, Date.parse("2026-09-21T06:16:00.000Z"));
    const b = gridNow(starts, Date.parse("2026-09-21T06:29:59.000Z"));
    expect(a.pastThresholdMs).toBe(b.pastThresholdMs);
    expect(gridNow(starts, Date.parse("2026-09-21T06:30:00.000Z")).pastThresholdMs).toBe(starts[2]);
  });

  it("leaves every row sellable before the first one starts", () => {
    expect(gridNow(starts, Date.parse("2026-09-21T05:59:00.000Z")).pastThresholdMs).toBe(-Infinity);
  });

  it("rounds the peak clock UP, so a stale second never makes the rule stricter than the server's", () => {
    const now = gridNow(starts, Date.parse("2026-09-21T06:00:01.000Z"));
    expect(now.peakNowMs).toBe(Date.parse("2026-09-21T06:01:00.000Z"));
    // Already on a minute: no needless jump forward.
    expect(gridNow(starts, Date.parse("2026-09-21T06:00:00.000Z")).peakNowMs)
      .toBe(Date.parse("2026-09-21T06:00:00.000Z"));
  });

  it("survives a day with no rows at all", () => {
    const now = gridNow([], Date.parse("2026-09-21T06:00:00.000Z"));
    expect(now.pastThresholdMs).toBe(-Infinity);
  });
});
