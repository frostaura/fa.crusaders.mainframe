import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { explainFault, faultDetail } from "./deviceFaultCopy";

/**
 * R17 D17-3 — a `clock_clamped` fault says what the board claimed in words a person can check.
 *
 * <p>
 * The server clamps an event whose time cannot be right (later than now, or more than 30 days ago)
 * to the moment it arrived, and files the claim as `claimed <instant>`. A claim past what the
 * calendar holds saturated at `9999-12-31T23:59:59.9999999+00:00`, and the page showed it as
 * "claimed Sat 1 Jan, 01:59" (the club's zone pushed it into year 10000) under a sentence saying the
 * record was "a few minutes out". Since BE17a the server words a saturated claim
 * (`DeviceTime.BeyondStorableDetail` / `BeforeStorableDetail`, copied below verbatim); a row filed
 * before then still carries the instant and is worded the same way here. A date in another year
 * shows its year.
 * </p>
 */

/** `DeviceTime.BeyondStorableDetail`. */
const BEYOND = "claimed a time beyond what can be stored";
/** `DeviceTime.BeforeStorableDetail`. */
const BEFORE = "claimed a time too long ago to be stored";

const ZONE = "Africa/Johannesburg";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("R17 D17-3 — a clamped clock's claim, in words", () => {
  it.each([
    ["the server's words", BEYOND],
    ["a row filed before them", "claimed 9999-12-31T23:59:59.9999999+00:00"],
  ])("a claim beyond the calendar says so plainly (%s), never a date", (_label, detail) => {
    const said = faultDetail(detail, ZONE);
    expect(said).toMatch(/a time beyond what can be stored/);
    expect(said).not.toMatch(/9999|10000|1 Jan|01:59|claimed/);
  });

  it.each([
    ["the server's words", BEFORE],
    ["a row filed before them", "claimed 0001-01-01T00:00:00.0000000+00:00"],
  ])("a claim before the calendar says so plainly (%s)", (_label, detail) => {
    const said = faultDetail(detail, ZONE);
    expect(said).toMatch(/a time too long ago to be stored/);
    expect(said).not.toMatch(/0001|1 Jan|claimed/);
  });

  it("a claim in another year shows the year", () => {
    const said = faultDetail("claimed 2028-03-05T10:00:00.0000000+00:00", ZONE);
    expect(said).toMatch(/Sun 5 Mar 2028, 12:00/);
    expect(said).toMatch(/recorded at the time it arrived/);
  });

  it("varied: a claim this year keeps the short date, without the year", () => {
    const said = faultDetail("claimed 2026-10-06T10:10:00.0000000+00:00", ZONE);
    expect(said).toMatch(/Tue 6 Oct, 12:10/);
    expect(said).not.toMatch(/2026/);
  });

  it("any other detail's instant in another year shows the year too", () => {
    expect(faultDetail("clock was 2024-06-01T16:05:00Z", ZONE)).toBe("clock was Sat 1 Jun 2024, 18:05");
    expect(faultDetail("clock was 2026-09-21T16:05:00Z", ZONE)).toBe("clock was Mon 21 Sep, 18:05");
  });

  it("the explanation no longer promises the record is only a few minutes out", () => {
    const said = explainFault({ code: "clock_clamped", headline: null, detail: BEYOND });
    expect(said.unrecognised).toBe(false);
    expect(said.means).not.toMatch(/a few minutes out/);
    expect(said.means).toMatch(/when it arrived/);
  });
});
