import { describe, expect, it, vi, afterEach } from "vitest";
import {
  CLUB_CONTACT_EMAIL_MAX_LENGTH, CLUB_CONTACT_PHONE_MAX_LENGTH,
  DEVICE_ALERT_COOLDOWN_MAX_MINUTES, DEVICE_ALERT_COOLDOWN_MIN_MINUTES,
  DOOR_BOOKING_HORIZON_MAX_MINUTES, DOOR_REFUSAL_SPIKE_MAX_COUNT, DOOR_REFUSAL_SPIKE_MIN_COUNT,
  GATE_EARLY_ENTRY_MAX_MINUTES, GATE_EARLY_ENTRY_MIN_MINUTES,
  GATE_UNLOCK_MAX_SECONDS, GATE_UNLOCK_MIN_SECONDS, clubContactEmailComplaint,
  clubContactPhoneComplaint, deviceNumbersComplaint,
  describeOfflineAfter, doorBookingHorizonMinutes, doorSettingComplaints, doorSettingsComplaint,
  formatDayHours, gateSettingComplaints, gateSettingsComplaint,
  offlineAfterSeconds, operatingHoursComplaint, parseDayHours, settingAnchorId, timezoneOptions,
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
 * same gap the old conversion-rate `step` fell through, where the field looked fine while the
 * arrows moved the rate by a hundredth.
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

/**
 * <b>The club's contact details, which are printed on a wall.</b> (B10 / C12)
 *
 * <p>
 * Both inputs sit outside a <code>&lt;form&gt;</code>, so the browser's own validation never
 * runs — and the page had none of its own, so anything typed was saved. The value then goes
 * onto the printable door card that is put up beside the door and into the sentence a member
 * reads when a door has just turned them away. Those are the two moments at which a club is
 * least able to afford an address that is not one.
 * </p>
 *
 * <p>
 * <b>Empty is not invalid.</b> A club that has recorded no number is a state the member
 * surfaces have copy for, and refusing it would make "no contact" impossible to express.
 * </p>
 */
describe("clubContactPhoneComplaint", () => {
  it("accepts the shapes a South African club actually writes", () => {
    for (const phone of [
      "076 226 1390", "+27 76 226 1390", "021-555-0134", "(021) 555 0134",
      "0215550134", "+27 (0)21 555 0134, 076 226 1390",
    ]) {
      expect(clubContactPhoneComplaint(phone), phone).toBeNull();
    }
  });

  it("allows empty and whitespace-only, which is a club with no number", () => {
    expect(clubContactPhoneComplaint("")).toBeNull();
    expect(clubContactPhoneComplaint("   ")).toBeNull();
  });

  /**
   * Anything outside digits, space and `+ - ( ) ,`. A letter is the common typo (an admin
   * writing "ask Sue") and an emoji is what a reviewer actually got saved and printed.
   */
  it("refuses characters no telephone has", () => {
    for (const phone of ["076 226 1390 🎾", "ask Sue", "076-CALL", "076<script>", "021.555.0134"]) {
      expect(clubContactPhoneComplaint(phone), phone).not.toBeNull();
    }
  });

  /**
   * The bound, exactly at it and one past it — read off the constant, because a test that
   * restates 32 passes while the two of them disagree.
   */
  it("holds the length bound from the constant, measured after the trim", () => {
    const atBound = "0".repeat(CLUB_CONTACT_PHONE_MAX_LENGTH);
    expect(clubContactPhoneComplaint(atBound)).toBeNull();
    expect(clubContactPhoneComplaint(` ${atBound} `)).toBeNull();
    expect(clubContactPhoneComplaint("0".repeat(CLUB_CONTACT_PHONE_MAX_LENGTH + 1)))
      .toContain(String(CLUB_CONTACT_PHONE_MAX_LENGTH));
  });
});

describe("clubContactEmailComplaint", () => {
  it("accepts addresses a club would give out", () => {
    for (const email of [
      "squash@example.co.za", "info@crusaders.co.za", "club.secretary@northwood-crusaders.com",
      "bookings+doors@example.org", "a@b.co",
    ]) {
      expect(clubContactEmailComplaint(email), email).toBeNull();
    }
  });

  it("allows empty, which is a club that gives out no address", () => {
    expect(clubContactEmailComplaint("")).toBeNull();
    expect(clubContactEmailComplaint("  ")).toBeNull();
  });

  /**
   * The shapes that reach a printed card and are not addresses: a bare word, a missing
   * domain, a missing local part, a space in the middle, two @s, and a hostname with no dot —
   * which is the one a naive `includes("@")` check lets straight through.
   */
  it("refuses what is not an address", () => {
    for (const email of [
      "squash at example", "squash@", "@example.co.za", "squash@example",
      "squash example@co.za", "a@b@c.co.za", "squash@.co.za", "squash@example..co.za",
    ]) {
      expect(clubContactEmailComplaint(email), email).not.toBeNull();
    }
  });

  it("holds the length bound from the constant, measured after the trim", () => {
    const tail = "@example.co.za";
    const local = "a".repeat(CLUB_CONTACT_EMAIL_MAX_LENGTH - tail.length);
    expect(clubContactEmailComplaint(local + tail)).toBeNull();
    expect(clubContactEmailComplaint(`a${local}${tail}`))
      .toContain(String(CLUB_CONTACT_EMAIL_MAX_LENGTH));
  });
});

/**
 * <b>A complaint has to know which field it is about.</b>
 *
 * <p>
 * The string helpers answer "can this be saved", which is all a disabled button needed. A
 * message tied to its own input, and a summary that links back to it, need the KEY — so the
 * keyed form is the real answer and the string form is its first message. Keeping the string
 * form derived rather than parallel is what stops the two of them drifting.
 * </p>
 */
describe("the keyed complaints", () => {
  const gate = { gate_unlock_seconds: 3, gate_access_policy: "active_member", gate_early_entry_minutes: 30 };
  const door = {
    door_log_retention_days: 90, door_refusal_spike_count: 8, door_refusal_spike_minutes: 20,
    club_contact_phone: "076 226 1390", club_contact_email: "squash@example.co.za",
  };

  it("names the key the bad value sits on", () => {
    expect(gateSettingComplaints({ ...gate, gate_unlock_seconds: 45 }))
      .toEqual([{ key: "gate_unlock_seconds", message: gateSettingsComplaint({ ...gate, gate_unlock_seconds: 45 })! }]);
    expect(doorSettingComplaints({ ...door, club_contact_email: "nope" })[0].key)
      .toBe("club_contact_email");
    expect(doorSettingComplaints({ ...door, door_refusal_spike_count: DOOR_REFUSAL_SPIKE_MAX_COUNT + 1 })[0].key)
      .toBe("door_refusal_spike_count");
  });

  /**
   * <b>Every bad field, not only the first.</b> The string form stops at one because a
   * disabled button can only carry one reason; a summary that stopped at one would send an
   * admin back down the page once per mistake.
   */
  it("reports all of them at once", () => {
    const complaints = doorSettingComplaints({
      ...door,
      door_log_retention_days: 1,
      door_refusal_spike_count: DOOR_REFUSAL_SPIKE_MIN_COUNT - 1,
      club_contact_phone: "ask Sue",
    });
    expect(complaints.map((c) => c.key)).toEqual([
      "door_log_retention_days", "door_refusal_spike_count", "club_contact_phone",
    ]);
  });

  it("stays quiet on a document that is entirely fine", () => {
    expect(gateSettingComplaints(gate)).toEqual([]);
    expect(doorSettingComplaints(door)).toEqual([]);
    expect(doorSettingComplaints({})).toEqual([]);
  });

  /** The string form is the keyed form's first message, by construction rather than by copy. */
  it("keeps the two forms in step", () => {
    const broken = { ...door, door_log_retention_days: 1 };
    expect(doorSettingsComplaint(broken)).toBe(doorSettingComplaints(broken)[0].message);
    expect(doorSettingsComplaint(door)).toBeNull();
  });
});

/**
 * The anchor a deep link lands on. (A9)
 *
 * <p>
 * The doors page sends an admin to "change the release under Admin settings" and that page is
 * about 5 400 px tall, so the link landed them at the top with one number to find. The id is
 * derived from the settings key rather than written out per field, so the mechanism covers
 * every setting rather than the one that prompted it.
 * </p>
 */
describe("settingAnchorId", () => {
  it("derives the id from the key, so any setting can be linked to", () => {
    expect(settingAnchorId("gate_unlock_seconds")).toBe("setting-gate-unlock-seconds");
    expect(settingAnchorId("club_contact_email")).toBe("setting-club-contact-email");
    expect(settingAnchorId("door_refusal_spike_minutes")).toBe("setting-door-refusal-spike-minutes");
  });
});
