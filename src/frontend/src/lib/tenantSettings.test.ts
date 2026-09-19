import { describe, expect, it, vi, afterEach } from "vitest";
import {
  DEVICE_ALERT_COOLDOWN_MAX_MINUTES, DEVICE_ALERT_COOLDOWN_MIN_MINUTES,
  DOOR_BOOKING_HORIZON_MAX_MINUTES, GATE_EARLY_ENTRY_MAX_MINUTES, GATE_EARLY_ENTRY_MIN_MINUTES,
  GATE_UNLOCK_MAX_SECONDS, GATE_UNLOCK_MIN_SECONDS, deviceNumbersComplaint,
  describeOfflineAfter, doorBookingHorizonMinutes, formatDayHours, gateSettingsComplaint,
  offlineAfterSeconds, operatingHoursComplaint, parseDayHours, timezoneOptions,
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

/**
 * The three door-gate bounds, mirroring `AdminConfigEndpoints.ValidateDeviceNumbers`.
 *
 * <p>
 * The inputs carry the same min and max, and that is not enough on its own: a number input's
 * bounds stop the SPINNER and nothing else, and Save on that screen is not a native submit,
 * so a typed or pasted value goes to the API with the browser silent about it. That is the
 * same gap the credits-per-rand `step` fell through, where the field looked fine while the
 * arrows moved the money conversion rate by a hundredth.
 * </p>
 */
describe("gateSettingsComplaint", () => {
  const ok = { gate_unlock_seconds: 3, gate_access_policy: "active_member", gate_early_entry_minutes: 30 };

  it("is quiet on the API's defaults", () => {
    expect(gateSettingsComplaint(ok)).toBeNull();
  });

  it("allows both ends of each range", () => {
    expect(gateSettingsComplaint({ ...ok, gate_unlock_seconds: GATE_UNLOCK_MIN_SECONDS })).toBeNull();
    expect(gateSettingsComplaint({ ...ok, gate_unlock_seconds: GATE_UNLOCK_MAX_SECONDS })).toBeNull();
    expect(gateSettingsComplaint({ ...ok, gate_early_entry_minutes: GATE_EARLY_ENTRY_MIN_MINUTES })).toBeNull();
    expect(gateSettingsComplaint({ ...ok, gate_early_entry_minutes: GATE_EARLY_ENTRY_MAX_MINUTES })).toBeNull();
  });

  /**
   * One past each end, both ways. A bound checked only from above passes everything below it,
   * and zero unlock seconds is a door that never releases the lock at all — the failure an
   * admin would read as broken hardware.
   */
  it("names the bound rather than saying the value is wrong", () => {
    expect(gateSettingsComplaint({ ...ok, gate_unlock_seconds: 0 }))
      .toBe("Unlock time has to be a whole number of seconds between 1 and 30.");
    expect(gateSettingsComplaint({ ...ok, gate_unlock_seconds: 31 }))
      .toBe("Unlock time has to be a whole number of seconds between 1 and 30.");
    expect(gateSettingsComplaint({ ...ok, gate_early_entry_minutes: -1 }))
      .toBe("Early entry has to be a whole number of minutes between 0 and 240.");
    expect(gateSettingsComplaint({ ...ok, gate_early_entry_minutes: 241 }))
      .toBe("Early entry has to be a whole number of minutes between 0 and 240.");
  });

  /**
   * Both settings are whole units on the API. A `<input type="number">` with no step happily
   * produces 2.5, and 0 minutes of early entry is a legal value, so `!value` cannot stand in
   * for the check either.
   */
  it("refuses a fraction and a value that is not a number at all", () => {
    expect(gateSettingsComplaint({ ...ok, gate_unlock_seconds: 2.5 })).toContain("whole number");
    expect(gateSettingsComplaint({ ...ok, gate_early_entry_minutes: 30.5 })).toContain("whole number");
    // Number("") is 0, which is IN range for early entry — so an emptied field has to be
    // caught by the unlock bound, and an emptied unlock field by Number.isInteger(NaN).
    expect(gateSettingsComplaint({ ...ok, gate_unlock_seconds: Number("") })).not.toBeNull();
    expect(gateSettingsComplaint({ ...ok, gate_unlock_seconds: Number("abc") })).not.toBeNull();
  });

  /**
   * A policy outside the closed list. The select offers only the two, so this is a settings
   * document written by something else — an older or newer API, or a hand-edited JSON column.
   * Caught here rather than rendered as a blank select and then saved back as one.
   */
  it("refuses a policy this build does not know", () => {
    expect(gateSettingsComplaint({ ...ok, gate_access_policy: "anyone_at_all" }))
      .toBe("Pick who may open a door.");
    expect(gateSettingsComplaint({ ...ok, gate_access_policy: "" })).toBe("Pick who may open a door.");
    expect(gateSettingsComplaint({ ...ok, gate_access_policy: "booking_window" })).toBeNull();
  });
});

/**
 * <b>How early a booking QR actually opens a door</b> — the number the settings screen was
 * silently wrong about.
 *
 * <p>
 * The screen printed <code>gate_early_entry_minutes</code> and called it the early-entry
 * window. Under <code>booking_window</code> that is exactly what it is. Under
 * <code>active_member</code> — the API's default, so the club's actual shipping state — the
 * door accepts a booking's code for as long as the member's own phone would have shown it,
 * which is <code>roster_window_minutes + activation_cue_window_minutes</code> and is 130 at
 * the defaults while the screen said 30. An admin lowering "Early entry" to 5 to narrow the
 * door narrowed nothing.
 * </p>
 *
 * <p>
 * This mirrors <code>BookingCodeWindow.DoorHorizonMinutes</code> including its cap at
 * <code>GateAccess.MaxEarlyEntryMinutes</code>, and like the API it CLAMPS ITS INPUTS rather
 * than trusting them: the settings document is a JSON column a hand edit can widen, and the
 * whole point of the cap is that no combination of values — legal or not — buys a door more
 * than four hours.
 * </p>
 */
describe("doorBookingHorizonMinutes", () => {
  const defaults = {
    gate_access_policy: "active_member",
    gate_early_entry_minutes: 30,
    roster_window_minutes: 120,
    activation_cue_window_minutes: 10,
  };

  /**
   * The club's shipping defaults, and the arithmetic the screen was not doing: the phone
   * shows a booking's code 130 minutes out, so the door accepts it 130 minutes out.
   */
  it("is roster reach plus the lights cue under the open policy, not the early-entry number", () => {
    expect(doorBookingHorizonMinutes(defaults)).toBe(130);
    expect(doorBookingHorizonMinutes(defaults)).not.toBe(defaults.gate_early_entry_minutes);
  });

  /**
   * And it is the early-entry number and nothing else under the strict policy: that policy's
   * whole claim is that a member may be in the building because they are due on a court.
   */
  it("is the early-entry number alone under the strict policy", () => {
    expect(doorBookingHorizonMinutes({ ...defaults, gate_access_policy: "booking_window" })).toBe(30);
    // The two court numbers do not reach the door under this policy, however large.
    expect(doorBookingHorizonMinutes({
      ...defaults, gate_access_policy: "booking_window",
      roster_window_minutes: 1440, activation_cue_window_minutes: 1440,
    })).toBe(30);
  });

  /**
   * <b>Early entry is a FLOOR under the open policy, never a ceiling.</b> The cached roster
   * admits a booking from <code>StartsAt − gate_early_entry_minutes</code>, so a door that
   * accepted a narrower window online would refuse, while it could reach the server, a member
   * it would have let in during an outage.
   */
  it("takes the wider of the two under the open policy, from either side", () => {
    // Early entry wider than the phone's horizon: early entry wins.
    expect(doorBookingHorizonMinutes({
      ...defaults, gate_early_entry_minutes: 200,
      roster_window_minutes: 10, activation_cue_window_minutes: 0,
    })).toBe(200);
    // The phone's horizon wider: it wins.
    expect(doorBookingHorizonMinutes({ ...defaults, gate_early_entry_minutes: 0 })).toBe(130);
    // Equal: either answer is the same answer.
    expect(doorBookingHorizonMinutes({
      ...defaults, gate_early_entry_minutes: 130,
    })).toBe(130);
  });

  /** The cap, exactly at it and one past it. */
  it("caps the phone's horizon at four hours", () => {
    expect(DOOR_BOOKING_HORIZON_MAX_MINUTES).toBe(240);
    expect(doorBookingHorizonMinutes({
      ...defaults, roster_window_minutes: 200, activation_cue_window_minutes: 40,
    })).toBe(240);
    expect(doorBookingHorizonMinutes({
      ...defaults, roster_window_minutes: 200, activation_cue_window_minutes: 41,
    })).toBe(240);
    expect(doorBookingHorizonMinutes({
      ...defaults, roster_window_minutes: 1440, activation_cue_window_minutes: 1440,
    })).toBe(240);
  });

  /**
   * <b>A hand-edited settings row cannot widen a door.</b> The three inputs are clamped to
   * the bounds the API enforces before the arithmetic runs, exactly as the API clamps them on
   * read — otherwise a JSON column edited past the form's reach would print, and buy, a
   * horizon nothing in the product honours.
   */
  it("clamps values the form could never have produced", () => {
    // Early entry past its own maximum is still capped at the maximum.
    expect(doorBookingHorizonMinutes({ ...defaults, gate_early_entry_minutes: 5000 })).toBe(240);
    // Negative early entry is a floor of zero, not a negative horizon.
    expect(doorBookingHorizonMinutes({
      ...defaults, gate_early_entry_minutes: -600,
      roster_window_minutes: 20, activation_cue_window_minutes: 0,
    })).toBe(20);
    // An emptied field reads as NaN through Number(""), which must not poison the whole sum.
    expect(doorBookingHorizonMinutes({
      ...defaults, activation_cue_window_minutes: Number("abc"),
    })).toBe(120);
    expect(doorBookingHorizonMinutes({
      ...defaults, gate_early_entry_minutes: Number("abc"),
    })).toBe(130);
  });

  /**
   * CLAIM PROBE for the sentence the screen prints: "never more than 240 minutes". Swept over
   * every combination the form and a hand edit can reach, under both policies, including the
   * illegal ends — because the claim is a THEORY about the function, not about one row.
   */
  it("never answers more than four hours, and never less than nothing", () => {
    const values = [-1000, -1, 0, 1, 5, 30, 120, 239, 240, 241, 1440, 1441, 100000, Number.NaN];
    for (const policy of ["active_member", "booking_window", "something_else"]) {
      for (const early of values) {
        for (const roster of values) {
          for (const cue of values) {
            const answer = doorBookingHorizonMinutes({
              gate_access_policy: policy,
              gate_early_entry_minutes: early,
              roster_window_minutes: roster,
              activation_cue_window_minutes: cue,
            });
            expect(Number.isInteger(answer)).toBe(true);
            expect(answer).toBeGreaterThanOrEqual(0);
            expect(answer).toBeLessThanOrEqual(DOOR_BOOKING_HORIZON_MAX_MINUTES);
          }
        }
      }
    }
  });

  /**
   * An unknown policy is treated as the OPEN one — the wider answer. A settings document this
   * build cannot render is refused before Save (`gateSettingsComplaint`), so the only thing
   * this number does in that state is describe a door; describing it as narrower than it is
   * would be the one mistake worth avoiding.
   */
  it("reads a policy it does not know as the wider one", () => {
    expect(doorBookingHorizonMinutes({ ...defaults, gate_access_policy: "anyone_at_all" })).toBe(130);
  });
});

/**
 * The alert cooldown, whose bound is the API's (`device_alert_cooldown_minutes`, 5–1440).
 *
 * <p>
 * It sits with the device numbers rather than in the door block because it covers court boxes
 * as well as doors: one "not reporting" email per board per cooldown, whichever kind of board
 * went quiet.
 * </p>
 */
describe("deviceNumbersComplaint", () => {
  const ok = { device_alert_cooldown_minutes: 60 };

  it("is quiet on the API's default and on both ends of the range", () => {
    expect(deviceNumbersComplaint(ok)).toBeNull();
    expect(deviceNumbersComplaint({ device_alert_cooldown_minutes: DEVICE_ALERT_COOLDOWN_MIN_MINUTES })).toBeNull();
    expect(deviceNumbersComplaint({ device_alert_cooldown_minutes: DEVICE_ALERT_COOLDOWN_MAX_MINUTES })).toBeNull();
  });

  /**
   * One past each end. The lower bound is the one that matters: a cooldown of zero or one
   * minute is a club mailed once a heartbeat for as long as a board is unplugged, which is the
   * flapping the setting exists to stop.
   */
  it("names the bound rather than saying the value is wrong", () => {
    expect(deviceNumbersComplaint({ device_alert_cooldown_minutes: 4 }))
      .toBe("Alert cooldown has to be a whole number of minutes between 5 and 1440.");
    expect(deviceNumbersComplaint({ device_alert_cooldown_minutes: 1441 }))
      .toBe("Alert cooldown has to be a whole number of minutes between 5 and 1440.");
    expect(deviceNumbersComplaint({ device_alert_cooldown_minutes: 0 })).not.toBeNull();
  });

  /** Whole minutes on the API, and an emptied field is NaN rather than a small number. */
  it("refuses a fraction and a field that has been emptied", () => {
    expect(deviceNumbersComplaint({ device_alert_cooldown_minutes: 60.5 })).toContain("whole number");
    expect(deviceNumbersComplaint({ device_alert_cooldown_minutes: Number("") })).not.toBeNull();
    expect(deviceNumbersComplaint({ device_alert_cooldown_minutes: Number("abc") })).not.toBeNull();
  });

  /**
   * An older API that does not serve the key at all leaves it undefined, and a screen that
   * held Save on that would be unusable against it. Omitted is unchanged on the way back, so
   * there is nothing to refuse.
   */
  it("is quiet when the API never sent the key", () => {
    expect(deviceNumbersComplaint({ device_alert_cooldown_minutes: undefined })).toBeNull();
  });
});
