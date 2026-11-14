import { describe, expect, it } from "vitest";
import type { ControlBoardCourt } from "./adminApi";
import { lightsMismatch, lightsSecondsLeft, partialBoardNotice } from "./monitoringCopy";

/**
 * The control board's v3 sentences (device-api §10; FA-8, BA-04, BA-09): the lights' own time
 * left, the two disagreements between bookings and the box's word, and the offline banner's
 * last-heard time.
 */

const NOW = Date.parse("2026-11-13T18:30:00Z");
const iso = (minutesFromNow: number) => new Date(NOW + minutesFromNow * 60_000).toISOString();

describe("the lights' own time left (FA-8)", () => {
  it("counts to the relay's deadline, not the booking's end", () => {
    expect(lightsSecondsLeft({ state: "on", until: iso(45) }, NOW, null)).toBe(45 * 60);
  });

  it("re-bases seconds_remaining on when the server computed it, not on as_of", () => {
    const lights = { state: "on" as const, seconds_remaining: 600, as_of: iso(-50) };
    // Read 2 minutes ago: 8 minutes are left now. as_of (50 minutes ago) is NOT the base.
    expect(lightsSecondsLeft(lights, NOW, iso(-2))).toBe(480);
  });

  it("follows the box's own word over the club's record", () => {
    expect(lightsSecondsLeft({ state: "on", until: iso(30), confirmed_state: "off", confirmed_at: iso(-1) }, NOW, null)).toBeNull();
    expect(lightsSecondsLeft({ state: "off", until: iso(30), confirmed_state: "on", confirmed_at: iso(-1) }, NOW, null)).toBe(1800);
  });

  it("is nothing for dark lights, a past deadline, or no figure at all", () => {
    expect(lightsSecondsLeft({ state: "off" }, NOW, null)).toBeNull();
    expect(lightsSecondsLeft({ state: "on", until: iso(-1) }, NOW, null)).toBeNull();
    expect(lightsSecondsLeft({ state: "on" }, NOW, null)).toBeNull();
    expect(lightsSecondsLeft(null, NOW, null)).toBeNull();
  });
});

const court = (extra: Partial<ControlBoardCourt>): ControlBoardCourt => ({
  court_id: "c1", court_number: 1, name: "Court 1", device: { link: "online" } as ControlBoardCourt["device"], ...extra,
});

describe("bookings against the box's word (BA-04)", () => {
  it("flags lights on with nothing booked, only once past the grace window", () => {
    const lit = (since: number) => court({ current: null, lights: { state: "on", confirmed_state: "on", confirmed_at: iso(-1), since: iso(since) } });
    expect(lightsMismatch(lit(-90), NOW, 5)).toBe("lit_nothing_booked");
    expect(lightsMismatch(lit(-3), NOW, 5)).toBeNull();
  });

  it("flags a checked-in court the box says is dark, once past the grace window", () => {
    const dark = (checkedIn: number) => court({
      current: { checked_in_at: iso(checkedIn), ends_at: iso(30) },
      lights: { state: "on", confirmed_state: "off", confirmed_at: iso(-1) },
    });
    expect(lightsMismatch(dark(-20), NOW, 5)).toBe("checked_in_dark");
    expect(lightsMismatch(dark(-2), NOW, 5)).toBeNull();
  });

  it("never flags on the club's own record alone, nor on a court whose box is silent", () => {
    expect(lightsMismatch(court({ current: null, lights: { state: "on", since: iso(-90) } }), NOW, 5)).toBeNull();
    expect(lightsMismatch(court({
      current: null, device: { link: "offline" } as ControlBoardCourt["device"],
      lights: { state: "on", confirmed_state: "on", confirmed_at: iso(-60), since: iso(-90) },
    }), NOW, 5)).toBeNull();
  });

  it("does not flag a box that confirmed off BEFORE the check-in (it has not spoken since)", () => {
    expect(lightsMismatch(court({
      current: { checked_in_at: iso(-20) }, lights: { state: "on", confirmed_state: "off", confirmed_at: iso(-30) },
    }), NOW, 5)).toBeNull();
  });
});

describe("the offline banner's time (BA-09)", () => {
  const tile = (n: number, box: string, heard: string | null) => ({
    court_id: `c${n}`, name: `Court ${n}`, device: { device_id: box, device_code: box, last_seen_at: heard },
  });

  it("says when the silent boxes were last heard, not when the page last read", () => {
    const notice = partialBoardNotice([tile(1, "b1", "2026-11-13T18:11:00Z")], "18:48", "UTC");
    expect(notice).toContain("what we last heard from it at 18:11");
    expect(notice).not.toContain("18:48");
  });

  it("takes the oldest across several boxes", () => {
    const notice = partialBoardNotice([tile(1, "b1", "2026-11-13T18:11:00Z"), tile(2, "b2", "2026-11-13T17:40:00Z")], "18:48", "UTC");
    expect(notice).toContain("last heard from them at 17:40");
  });

  it("gives no time at all rather than the page's own when one is unknown", () => {
    const notice = partialBoardNotice([tile(1, "b1", null)], "18:48", "UTC");
    expect(notice).toContain("may be out of date");
    expect(notice).not.toContain("18:48");
  });
});
