import { describe, expect, it } from "vitest";
import { clubDayRange, clubDayStart, clubToday, nextDate } from "./clubDay";

describe("club days, in the club's zone (R4 A4-7)", () => {
  it("starts a Johannesburg day at 22:00 UTC the evening before", () => {
    expect(clubDayStart("2026-10-01", "Africa/Johannesburg").toISOString()).toBe("2026-09-30T22:00:00.000Z");
  });

  it("follows a zone across its DST change", () => {
    expect(clubDayStart("2026-07-01", "Europe/London").toISOString()).toBe("2026-06-30T23:00:00.000Z");
    expect(clubDayStart("2026-12-01", "Europe/London").toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("is half-open: the whole of the last day, up to the next midnight", () => {
    expect(clubDayRange("2026-09-01", "2026-09-30", "Africa/Johannesburg")).toEqual({
      from: "2026-08-31T22:00:00.000Z", to: "2026-09-30T22:00:00.000Z",
    });
    expect(clubDayRange("", "", "Africa/Johannesburg")).toEqual({ from: undefined, to: undefined });
    expect(nextDate("2026-12-31")).toBe("2027-01-01");
  });

  it("says today's date as the club's, not UTC's", () => {
    // 23:30 UTC on 30 Sep is already 1 Oct in Johannesburg.
    expect(clubToday(0, "Africa/Johannesburg", Date.parse("2026-09-30T23:30:00Z"))).toBe("2026-10-01");
    expect(clubToday(-30, "Africa/Johannesburg", Date.parse("2026-09-30T23:30:00Z"))).toBe("2026-09-01");
  });
});
