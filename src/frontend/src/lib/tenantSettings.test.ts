import { describe, expect, it, vi, afterEach } from "vitest";
import {
  describeOfflineAfter, formatDayHours, offlineAfterSeconds, operatingHoursComplaint,
  parseDayHours, timezoneOptions,
} from "./tenantSettings";

/**
 * The two rules the settings screen mirrors from the API.
 *
 * <p>
 * Both are duplications of a server constant, which is worth having — an admin choosing a
 * number needs to know what it buys before they press Save — and worth pinning, because a
 * duplication nobody checks is a lie with a shelf life.
 * </p>
 */
describe("offlineAfterSeconds", () => {
  it("holds the floor below 60 seconds, which is where the old hint was wrong", () => {
    // Three missed 15s beats is 45s, and the box reports 180. That gap is the whole of
    // D-F13: an admin lowering the interval got no faster outage detection at all.
    expect(offlineAfterSeconds(15)).toBe(180);
    expect(offlineAfterSeconds(30)).toBe(180);
    expect(offlineAfterSeconds(59)).toBe(180);
  });

  it("uses three missed beats once they exceed the floor", () => {
    expect(offlineAfterSeconds(60)).toBe(180);
    expect(offlineAfterSeconds(120)).toBe(360);
    expect(offlineAfterSeconds(300)).toBe(900);
  });

  it("clamps to the range a box honours, because a larger number is not what it would run", () => {
    expect(offlineAfterSeconds(1)).toBe(180);
    expect(offlineAfterSeconds(3600)).toBe(900);
  });

  it("reads in minutes when it divides, and seconds when it does not", () => {
    expect(describeOfflineAfter(15)).toBe("3 minutes");
    expect(describeOfflineAfter(120)).toBe("6 minutes");
    expect(describeOfflineAfter(70)).toBe("210 seconds");
  });
});

describe("timezoneOptions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the club's saved zone even when the runtime's tzdb has never heard of it", () => {
    // A picker that dropped the saved value would show the club a zone it is not on and
    // then save that zone the next time anybody pressed Save.
    const zones = timezoneOptions("Mars/Olympus_Mons");
    expect(zones[0]).toBe("Mars/Olympus_Mons");
  });

  it("falls back to a usable list when the runtime has no supportedValuesOf", () => {
    vi.stubGlobal("Intl", { ...Intl, supportedValuesOf: undefined });
    const zones = timezoneOptions("Africa/Johannesburg");
    expect(zones).toContain("Africa/Johannesburg");
    expect(zones.length).toBeGreaterThan(5);
  });

  it("survives a runtime whose supportedValuesOf throws", () => {
    vi.stubGlobal("Intl", { ...Intl, supportedValuesOf: () => { throw new Error("nope"); } });
    expect(timezoneOptions("Europe/London")).toContain("Europe/London");
  });
});

/**
 * The editor's half of `operating_hours`, which has to agree with
 * `OperatingHours.TryParseWire` on the API: the same `HH:mm-HH:mm` text, and the same
 * refusal of a close at or before the open. A club could not edit these hours at all until
 * there was an editor, and an editor that writes text the engine cannot read would have
 * been the same defect wearing a form.
 */
describe("operating hours", () => {
  it("reads and writes the wire text the API stores", () => {
    expect(parseDayHours("07:00-20:00")).toEqual({ open: "07:00", close: "20:00" });
    // A person's typing, and a document written by hand: one-digit hours round-trip padded,
    // which is what keeps the value the screen saves identical to the value it read.
    expect(parseDayHours("7:00-20:00")).toEqual({ open: "07:00", close: "20:00" });
    expect(formatDayHours({ open: "7:00", close: "20:00" })).toBe("07:00-20:00");
    expect(parseDayHours("not a range")).toBeNull();
    expect(parseDayHours(undefined)).toBeNull();
  });

  it("names the day whose hours cannot be saved, and stays quiet about the rest", () => {
    expect(operatingHoursComplaint({ mon: "06:00-22:00", sat: "07:00-20:00" })).toBeNull();
    // Close before open is a typo, not an overnight club — reading it the other way would
    // sell the small hours, which is the very thing the setting exists to stop.
    expect(operatingHoursComplaint({ sat: "20:00-07:00" })).toEqual({
      day: "sat", message: "Closing time has to be after opening time.",
    });
    expect(operatingHoursComplaint({ sat: "20:00-20:00" })?.day).toBe("sat");
    expect(operatingHoursComplaint({ tue: "rubbish" })?.day).toBe("tue");
  });
});
