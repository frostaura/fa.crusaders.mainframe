import { describe, expect, it } from "vitest";
import {
  DOORS_EMPTY_HINT, DOORS_EMPTY_NOTICE, DOORS_READ_FAILED, LOG_EMPTY_FILTERED,
  LOG_EMPTY_FILTERED_HINT, LOG_EMPTY_NOTHING, LOG_READ_FAILED, LOG_OLDER_FAILED,
  DOOR_EVENTS_NOTE, NO_REASON_RECORDED,
  doorAttentionReason, doorCsvDownloaded, doorCsvNotice, doorExhaustedNotice,
  doorLogEmptyOneDoor, doorLogHowToRead, doorMayNotBeReleasingNotice, doorNeedsAttention,
  doorOutcomeChip, doorQuietNotice, doorRefusalSpikeNotice, doorRetentionNotice,
  doorScanCountHeading, doorScanCountLine, doorSetupChip, doorSignalChip, doorStaleChecksNotice,
  doorStateChip, doorStateNotice, doorsAttentionSummary, describePowerLoss, spellAge,
  doorDisplayName, doorPickerLabel, doorRowIdentity, doorRowName, doorShutAttribution,
  REMOVED_DOOR_UNNAMED,
} from "./doorsCopy";
import { doorShutNotice } from "./gateCopy";
import { type AdminDoorDevice, type DeviceActivityEntry, type DoorSignal } from "./api";

/** A door signal, for the arms that take one. The payload carries no member, by construction. */
function signal(kind: DoorSignal["kind"]): DoorSignal {
  return { kind, since: "2026-09-19T10:00:00Z", until: "2026-09-19T10:20:00Z", scans: 11 };
}

/**
 * Every sentence the doors surface says about a door, pinned.
 *
 * <p>
 * Same argument as `gateCopy.test.ts`, one surface along: the box half of the Devices screen
 * shipped a false out-of-service sentence three rounds running, each green on the day,
 * because each was pinned only by whichever rendered fixture that round happened to build.
 * What is new here is the matrix at the bottom — <b>both halves of every conditional, and
 * the banned vocabulary asserted absent across every generator at once</b> — because the
 * doors programme's principles are mostly rules about what a screen may not claim, and a
 * rule of that shape is broken by the NEXT sentence somebody adds, not by the ones reviewed.
 * </p>
 */

const TZ = "UTC";
const NOW = Date.parse("2026-09-19T10:18:00Z");

function door(overrides: Partial<AdminDoorDevice> = {}): AdminDoorDevice {
  return {
    id: "99999999-9999-9999-9999-999999999999",
    device_code: "gate-77ab91",
    name: "Side door",
    kind: "Gate",
    hardware: "Esp32",
    court_numbers: [],
    gate_key: "side-door",
    mac_address: "a4cf12ff77ab91",
    enabled: true,
    last_seen_at: "2026-09-19T10:17:48Z",
    last_ip_address: null,
    created_at: "2026-09-01T00:00:00Z",
    auto_registered: false,
    location_note: null,
    power_loss_behaviour: "not_established",
    out_of_service_since: null,
    ...overrides,
  };
}

/** Every generator on this surface, called with an arm of each of its conditionals. */
function everySentence(): string[] {
  const said = (value: string | null) => value ?? "";
  const reachable = door();
  const silent = door({ last_seen_at: "2026-09-19T04:12:00Z" });
  return [
    ...[true, false].flatMap((online) => [
      doorStateNotice(reachable, online, TZ) ?? "",
      doorStateNotice(door({ gate_key: null }), online, TZ) ?? "",
      doorStateNotice(silent, online, TZ) ?? "",
      doorStateNotice(door({ last_seen_at: null, gate_key: null }), online, TZ) ?? "",
      doorStateNotice(door({ enabled: false }), online, TZ) ?? "",
      doorStateChip(reachable, online)?.label ?? "",
      doorNeedsAttention(reachable, online) ?? "",
      doorNeedsAttention(door({ gate_key: null }), online) ?? "",
      doorNeedsAttention(door({ enabled: false }), online) ?? "",
      // A3: signals are an attention reason now, so their sentences join the matrix.
      doorAttentionReason(reachable, online, [signal("refusal_spike")])?.reason ?? "",
      doorAttentionReason(reachable, online, [signal("may_not_be_releasing")])?.reason ?? "",
    ]),
    doorSetupChip(door({ gate_key: null }))?.label ?? "",
    doorScanCountHeading("2026-09-19T00:00:00Z", TZ),
    doorScanCountLine({ released: 23, refused: 2 }),
    doorScanCountLine(null),
    doorQuietNotice("2026-09-16T18:40:00Z", "2026-09-19T00:00:00Z", NOW, TZ) ?? "",
    doorRefusalSpikeNotice("Side door", 11, 20),
    doorMayNotBeReleasingNotice("Front door", 3),
    doorMayNotBeReleasingNotice("Front door", null),
    ...doorLogHowToRead(),
    doorRetentionNotice(90),
    doorRetentionNotice(1),
    doorRetentionNotice(null),
    doorCsvNotice(90),
    doorCsvNotice(null),
    doorCsvDownloaded(165),
    doorCsvDownloaded(1),
    doorCsvDownloaded(null),
    doorCsvDownloaded(10_000, true),
    doorExhaustedNotice(90),
    doorExhaustedNotice(null),
    // C7 — all three arms, including the one that says the screen does not know.
    doorLogEmptyOneDoor("Side door", "Mon 14 Sep, 00:00", true),
    doorLogEmptyOneDoor("Side door", "Mon 14 Sep, 00:00", false),
    doorLogEmptyOneDoor("Side door", "Mon 14 Sep, 00:00", null),
    DOOR_EVENTS_NOTE,
    NO_REASON_RECORDED,
    doorsAttentionSummary(["Side door has not been heard from since 04:12."]) ?? "",
    said(doorStaleChecksNotice(2, 47)),
    DOORS_READ_FAILED, DOORS_EMPTY_NOTICE, DOORS_EMPTY_HINT,
    LOG_READ_FAILED, LOG_EMPTY_FILTERED, LOG_EMPTY_FILTERED_HINT, LOG_EMPTY_NOTHING,
    LOG_OLDER_FAILED,
    describePowerLoss("not_established"), describePowerLoss("released"), describePowerLoss("locked"),
  ];
}

describe("doorStateChip", () => {
  /**
   * <b>D1 / A2.1.</b> "Working" asserts that the door works. The product knows one thing: the
   * board answered the club N seconds ago. There is no door sensor, the relay may be dead,
   * the lock may be seized, and the release may be too short for a heavy door — which is the
   * very fault the second signal exists to guess at. "Working" is P2's forbidden implication
   * in one word, and it is the word an admin quotes back after somebody has stood outside for
   * ten minutes.
   */
  it("says Reporting, never Working and never Online", () => {
    expect(doorStateChip(door(), true)).toEqual({ label: "Reporting", tone: "success" });
    for (const online of [true, false]) {
      const label = doorStateChip(door(), online)?.label;
      expect(label).not.toBe("Working");
      expect(label).not.toBe("Online");
      expect(label).not.toBe("Open");
    }
  });

  it("says Not reporting for a silent door and Shut for one an admin shut", () => {
    expect(doorStateChip(door(), false)).toEqual({ label: "Not reporting", tone: "danger" });
    expect(doorStateChip(door({ enabled: false }), true)).toEqual({ label: "Shut", tone: "muted" });
  });

  /** Shut wins over liveness: a shut door nobody expects to hear from is not "not reporting". */
  it("calls a shut door shut whether or not it is still calling in", () => {
    for (const online of [true, false]) {
      expect(doorStateChip(door({ enabled: false }), online)?.label).toBe("Shut");
    }
  });
});

/**
 * <b>D2 / A2.2: two chips, two dimensions.</b>
 *
 * <p>
 * A reporting door with no name is the most dangerous state in the club — it works today and
 * opens nothing at all during the next outage — and a single chip slot renders it either as
 * `Reporting`, hiding the job, or as `New`, hiding the liveness. The setup chip is keyed on
 * the NAME being absent, not on `auto_registered`: a door that was named and never edited
 * again is fine, and a door whose name an admin cleared is not.
 * </p>
 */
describe("doorSetupChip", () => {
  it("fires on a missing name, not on the new-board flag", () => {
    expect(doorSetupChip(door({ gate_key: null, auto_registered: false }))?.label).toBe("Needs a door name");
    expect(doorSetupChip(door({ gate_key: "side-door", auto_registered: true }))).toBeNull();
  });

  it("is absent for a named door", () => {
    expect(doorSetupChip(door())).toBeNull();
  });
});

/**
 * The five state paragraphs. Every one states BOTH halves of its conditional — what the
 * door does while the club can reach it, and what it does when the club cannot — because
 * either half alone has already been shipped here as a falsehood.
 */
describe("doorStateNotice", () => {
  it("reporting and named: says what reaching the club buys, and what an outage costs", () => {
    expect(doorStateNotice(door(), true, TZ)).toBe(
      "The club decides every scan at this door as it happens. If it loses the network it opens for"
      + " members with a booking, from the list it last downloaded, until that list goes stale six"
      + " hours after its last call.",
    );
  });

  it("reporting and unnamed: names the consequence of the missing name", () => {
    expect(doorStateNotice(door({ gate_key: null }), true, TZ)).toBe(
      "The club decides every scan at this door as it happens. It has no door name, so it is sent an"
      + " empty list and opens nothing at all while it is offline.",
    );
  });

  /**
   * The stale time is `last_seen_at` + six hours, which is the firmware's own
   * `ROSTER_MAX_AGE_MS` and derivable from the payload the screen already holds. An admin
   * standing in a club at 09:00 needs a clock face, not "six hours after its last call".
   *
   * <b>A7: with its DAY.</b> Six hours after a last call at 21:00 is 03:00 tomorrow, and an
   * admin reading "goes stale at 03:00" at nine in the morning cannot tell whether it
   * already has.
   */
  it("not reporting and named: says a change waits, and when — and which day — the cached list dies", () => {
    expect(doorStateNotice(door({ last_seen_at: "2026-09-19T04:12:00Z" }), false, TZ)).toBe(
      "Nothing can reach it. A change you make now arrives only when it calls in again. Until then"
      + " it opens for members with a booking, from the list it last downloaded, and that list goes"
      + " stale on Sat 19 Sept, 10:12.",
    );
  });

  /** The case A7 was actually found in: a last call at 21:00, stale after midnight. */
  it("names the next day when the list outlives the one it was downloaded on", () => {
    // This fixture's TZ is UTC, so 19:00 + 6 h is 01:00 the NEXT day — and the day is the
    // whole point: "goes stale at 01:00", read at nine in the morning, cannot be told from
    // one that expired eight hours ago.
    const notice = doorStateNotice(door({ last_seen_at: "2026-09-19T19:00:00Z" }), false, TZ);
    expect(notice).toContain("goes stale on Sun 20 Sept, 01:00");
  });

  /** A row that has never called in holds no list, so there is no time to print. */
  it("not reporting and never heard from: says it holds no list rather than printing a time", () => {
    const notice = doorStateNotice(door({ last_seen_at: null }), false, TZ);
    expect(notice).toContain("it has never called in, so it holds no list at all");
    expect(notice).not.toContain("NaN");
    expect(notice).not.toContain("Invalid Date");
    expect(notice).not.toContain("goes stale at");
  });

  it("not reporting and unnamed: opens for nobody at all until it is back", () => {
    expect(doorStateNotice(door({ gate_key: null, last_seen_at: null }), false, TZ)).toBe(
      "Nothing can reach it, and it has no door name, so it was sent an empty list. It opens for"
      + " nobody until it is back.",
    );
  });

  /**
   * <b>The shut branch delegates.</b> `doorShutNotice()` is the one reader of what the 403
   * path does, and it is already pinned word for word in `gateCopy.test.ts`. A second copy
   * here is the fork this whole module family exists to prevent.
   */
  it("shut: prefixes the one shut notice rather than restating it", () => {
    const notice = doorStateNotice(door({ enabled: false }), true, TZ);
    expect(notice).toBe(`This door is shut. ${doorShutNotice()}`);
    expect(notice).toContain("opens for nobody");
    expect(notice).toContain("keeps admitting members with a booking");
  });

  /**
   * <b>A5 — "You shut this door." was shown to every admin in the club.</b>
   *
   * It is true of at most one of them, there is nothing on the screen that says which, and
   * the audit row has carried the actor since the gate shipped. WIRE-R2 §2 puts the name on
   * the door row so the state paragraph can say who and when.
   */
  it("shut: names who shut it and when, and never says 'you'", () => {
    const shut = door({
      enabled: false, shut_by_name: "Priya Naidoo",
      out_of_service_since: "2026-09-20T19:40:00Z",
    });
    expect(doorStateNotice(shut, true, TZ)).toContain("Shut by Priya Naidoo at Sun 20 Sept, 19:40.");
    for (const variant of [shut, door({ enabled: false }), door({ enabled: false, shut_by_name: "Priya Naidoo" })]) {
      expect((doorStateNotice(variant, true, TZ) ?? "").toLowerCase()).not.toContain("you shut");
    }
  });

  /** All four arms, and not one of them invents an actor or a time it does not have. */
  it("shut: says only what the payload actually carries", () => {
    expect(doorShutAttribution(door({ enabled: false }), TZ)).toBe("This door is shut.");
    expect(doorShutAttribution(door({ enabled: false, shut_by_name: "Priya Naidoo" }), TZ))
      .toBe("Shut by Priya Naidoo.");
    expect(doorShutAttribution(door({ enabled: false, out_of_service_since: "2026-09-20T19:40:00Z" }), TZ))
      .toBe("This door was shut on Sun 20 Sept, 19:40.");
    for (const notice of [
      doorShutAttribution(door({ enabled: false }), TZ),
      doorShutAttribution(door({ enabled: false, shut_by_name: "Priya Naidoo" }), TZ),
    ]) {
      expect(notice).not.toContain("null");
      expect(notice).not.toContain("undefined");
    }
  });

  it("every branch states both halves of its conditional", () => {
    const notices = [
      doorStateNotice(door(), true, TZ) ?? "",
      doorStateNotice(door({ gate_key: null }), true, TZ) ?? "",
      doorStateNotice(door({ last_seen_at: "2026-09-19T04:12:00Z" }), false, TZ) ?? "",
      doorStateNotice(door({ gate_key: null }), false, TZ) ?? "",
      doorStateNotice(door({ enabled: false }), true, TZ) ?? "",
    ];
    for (const notice of notices) {
      // Each says something about being reachable AND something about being cut off.
      expect(notice).toMatch(/as it happens|arrives only when it calls in again|Nothing can reach it|refuses every scan/);
      expect(notice).toMatch(/offline|lost the network|goes stale|never called in|until it is back/);
    }
  });
});

describe("the two scan numbers", () => {
  /** The day boundary is NAMED, because "today" in a browser is not the club's today. */
  it("names the club-time boundary the counts are measured from", () => {
    expect(doorScanCountHeading("2026-09-19T00:00:00Z", TZ)).toBe("Since 00:00 club time");
  });

  /**
   * Two numbers, never one. A single headline number per door, on a list of doors, is a
   * footfall ranking by accident — which is what P3 exists to prevent.
   */
  it("is two numbers", () => {
    expect(doorScanCountLine({ released: 23, refused: 2 })).toBe("23 released · 2 refused");
    expect(doorScanCountLine({ released: 0, refused: 0 })).toBe("0 released · 0 refused");
  });

  /**
   * <b>A failed count is not a zero.</b> This is the `admin-failed-read` rule with a
   * different noun: an admin who reads "0 released" on a door that has been busy all evening
   * concludes a working door is dead and goes looking for a board that is fine.
   */
  it("says the count could not be read rather than rendering a zero", () => {
    expect(doorScanCountLine(null)).toBe("Today's scans could not be read.");
    expect(doorScanCountLine(null)).not.toContain("0");
  });
});

describe("doorQuietNotice", () => {
  /**
   * "Has anyone been through today?" is the question an admin actually has, so the boundary
   * is the club's calendar day rather than a magic threshold. It states the fact and does not
   * editorialise: a door with no scans is normal at 09:00 and a question at 20:00.
   */
  /**
   * B20: the weekday carries its DATE. "Wed 18:40" is unambiguous over a 24-hour window and
   * ambiguous over the 7- and 30-day ranges this surface offers, where four Wednesdays are
   * in range and the reader cannot tell which one is meant.
   */
  it("names the day, the date and the gap when the newest scan is on an earlier club day", () => {
    const notice = doorQuietNotice("2026-09-16T18:40:00Z", "2026-09-19T00:00:00Z", NOW, TZ);
    expect(notice).toContain("No scans at this door since");
    expect(notice).toContain("Wed 16 Sept, 18:40");
    expect(notice).toContain("3 days");
    // A13: day before month and a 24-hour clock, never "9/16/26, 6:40 PM".
    expect(notice).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{2}/);
    expect(notice).not.toMatch(/\b[AP]M\b/i);
  });

  it("says nothing when there has been a scan today", () => {
    expect(doorQuietNotice("2026-09-19T09:30:00Z", "2026-09-19T00:00:00Z", NOW, TZ)).toBeNull();
  });

  /** A door nobody has ever scanned at has an EMPTY feed, which is a different sentence. */
  it("says nothing when there is no scan at all", () => {
    expect(doorQuietNotice(null, "2026-09-19T00:00:00Z", NOW, TZ)).toBeNull();
  });

  it("says one day in the singular", () => {
    const notice = doorQuietNotice("2026-09-18T18:40:00Z", "2026-09-19T00:00:00Z", NOW, TZ) ?? "";
    expect(notice).toContain("1 day");
    expect(notice).not.toContain("1 days");
  });
});

/**
 * <b>D4: the derivation names a credential; the FLAG must not.</b>
 *
 * <p>
 * "The same credential granted three times in sixty seconds" is a correct derivation rule and
 * is not display copy. At a club of two hundred people a credential is a member, and a flag
 * rendering the fingerprint — or the resolved name `describeActivityWho` would happily give
 * it — has become a per-member observation on an admin screen, which P3 and P4 forbid as
 * plainly as a filter control would.
 * </p>
 */
describe("the two signals", () => {
  it("the spike notice counts scans, says so, and interpolates the club's own window", () => {
    const notice = doorRefusalSpikeNotice("Side door", 11, 20);
    expect(notice).toBe(
      "Side door turned away 11 scans in the last 20 minutes. That is usually a dirty scanner, a"
      + " member holding a code that has expired, or the club's door policy being stricter than"
      + " people expect. This counts scans, not people — one person trying four times is four. Look"
      + " at the reasons below to see which one is repeating.",
    );
    expect(notice).toContain("This counts scans, not people");
  });

  it("the releasing notice states its own limits and links the release setting both ways", () => {
    const withSeconds = doorMayNotBeReleasingNotice("Front door", 3);
    expect(withSeconds).toContain("Front door may not be releasing");
    expect(withSeconds).toContain("people do not scan again when a door opens");
    expect(withSeconds).toContain("cannot tell a stuck door from");
    expect(withSeconds).toContain("The release is set to 3 seconds.");

    // Settings failed: no guessed number, and the reader is still pointed at the field.
    const without = doorMayNotBeReleasingNotice("Front door", null);
    expect(without).toContain("How long the lock is released is under Admin settings.");
    expect(without).not.toMatch(/\d/);
  });

  it("says one second in the singular", () => {
    expect(doorMayNotBeReleasingNotice("Front door", 1)).toContain("set to 1 second.");
  });

  /**
   * <b>The three prohibitions, each its own assertion.</b>
   *
   * <p>
   * Note what is NOT banned: the spike notice's "a member holding a code that has expired" is
   * a hypothesis about a class of person, offered as one of three possible causes. What P3
   * and P4 forbid is an IDENTIFIED member — a name, a fingerprint, an id — because that is
   * what turns a reading of a door into an observation of a person. The signal payload
   * carries none of the three, which is what makes this structural rather than a convention.
   * </p>
   */
  it("identifies nobody: no name, no fingerprint, no id, on either signal", () => {
    const sentences = [
      doorRefusalSpikeNotice("Side door", 11, 20),
      doorMayNotBeReleasingNotice("Front door", 3),
      doorMayNotBeReleasingNotice("Front door", null),
      doorSignalChip("refusal_spike").label,
      doorSignalChip("may_not_be_releasing").label,
    ];
    for (const sentence of sentences) {
      // Eight hex characters is what a code fingerprint looks like; a uuid is what an id
      // looks like. Neither may reach this copy under any arm.
      expect(sentence, sentence).not.toMatch(/\b[0-9a-f]{8}\b/);
      expect(sentence, sentence).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
      // And none of the phrasings that would introduce one.
      for (const banned of ["unknown code", "that member", "this member", "the member who", "whose code"]) {
        expect(sentence.toLowerCase(), sentence).not.toContain(banned);
      }
    }
  });

  /**
   * The subject of every sentence is the DOOR — phrased as a fault of the door, not of a
   * person — which is the half that survives a rewrite when the prohibitions above are
   * satisfied by a sentence that still reads as an accusation.
   */
  it("makes the door the subject of both notices", () => {
    expect(doorRefusalSpikeNotice("Side door", 11, 20).startsWith("Side door turned away")).toBe(true);
    expect(doorMayNotBeReleasingNotice("Front door", 3).startsWith("Front door may not be")).toBe(true);
  });

  /**
   * <b>And the releasing notice has no member substitution point at all.</b> Its arguments
   * are a door's name and a number of seconds; there is nowhere for a member to enter it,
   * which is the cheapest way to make the rule hold against the next sentence somebody adds.
   */
  it("takes no member-shaped argument, so none can be interpolated", () => {
    expect(doorMayNotBeReleasingNotice.length).toBe(2);
    expect(doorRefusalSpikeNotice.length).toBe(3);
  });

  it("the chips are words, short enough to be chips", () => {
    expect(doorSignalChip("refusal_spike")).toEqual({ label: "Refusing a lot", tone: "warning" });
    expect(doorSignalChip("may_not_be_releasing")).toEqual({ label: "May not be releasing", tone: "warning" });
  });
});

/**
 * The two P2 banners, on the log, permanently. They are not dismissible: dismissing one is
 * how it stops being true for the next reader.
 */
describe("doorLogHowToRead", () => {
  it("says a code is not a person, and that there is no door sensor", () => {
    const [whose, opened] = doorLogHowToRead();
    expect(whose).toContain("not who walked through");
    expect(whose).toContain("shares their QR shares entry");
    expect(opened).toContain("no door sensor");
    expect(opened).toContain("released the lock");
  });
});

describe("doorRetentionNotice / doorCsvNotice", () => {
  it("states the club's own number, plural and singular", () => {
    expect(doorRetentionNotice(90)).toContain("kept for 90 days");
    expect(doorRetentionNotice(1)).toContain("kept for 1 day");
    expect(doorRetentionNotice(1)).not.toContain("1 days");
  });

  it("says money records follow a longer rule, on every arm", () => {
    for (const days of [90, 1, null]) {
      expect(doorRetentionNotice(days)).toContain("Money records follow a separate, longer rule.");
    }
  });

  /** <b>A failed settings read must not guess 90.</b> A stated number nobody read is a lie. */
  it("names the setting rather than guessing a number when settings failed", () => {
    const notice = doorRetentionNotice(null);
    expect(notice).toContain("the number of days set under Admin settings");
    expect(notice).not.toMatch(/\d/);
  });

  /**
   * The CSV note is permanent and sits at the click, rather than being a dialog. A CSV is the
   * one action on this surface that moves data past every guard the product has.
   */
  it("says the export carries names and leaves the club's rule behind it", () => {
    expect(doorCsvNotice(90)).toContain("Members' names are in it");
    expect(doorCsvNotice(90)).toContain("outside the club's 90-day rule");
    // And the same honesty about the retention number with none to state. (The 10,000-row
    // cap is still named — it is this file's own constant, not the club's setting.)
    expect(doorCsvNotice(null)).toContain("outside the club's retention rule");
    expect(doorCsvNotice(null)).not.toMatch(/\b\d+-day\b/);
  });

  /**
   * B3 / A15. The note promised "the same rows as this page", which was simply untrue: the
   * page shows one cursor page of 50 and the reviewer's file held 165 rows. It is the same
   * FILTERS over everything matching them — a better promise, and the true one.
   */
  it("promises the filters rather than the page, and names the cap", () => {
    const notice = doorCsvNotice(90);
    expect(notice).not.toContain("same rows as this page");
    expect(notice).toContain("every scan matching the filters above");
    expect(notice).toContain("not just the rows on this page");
    expect(notice).toContain("10,000");
  });

  /**
   * B3's other half. The toast announced the length of the list on screen — "50 scans
   * downloaded" over a 165-row file — and that is the number an admin repeats to a
   * committee.
   */
  describe("doorCsvDownloaded", () => {
    it("announces the server's own count", () => {
      expect(doorCsvDownloaded(165)).toBe("165 scans downloaded.");
      expect(doorCsvDownloaded(1)).toBe("1 scan downloaded.");
    });

    it("carries NO number rather than a wrong one when the server did not send it", () => {
      const notice = doorCsvDownloaded(null);
      expect(notice).not.toMatch(/\d/);
      expect(notice).toContain("may be more than this page shows");
    });

    /**
     * Truncation comes from the server's own `X-Crusaders-Truncated` (WIRE-R1 §7), never
     * from comparing the count to a cap this side holds — a client that decides "this looks
     * like the limit" is wrong the day the server's limit moves.
     */
    it("says so when the SERVER says the file was truncated", () => {
      const notice = doorCsvDownloaded(10_000, true);
      expect(notice).toContain("as many as one file holds");
      expect(notice).toContain("older scans in this range were left out");
      expect(notice).toContain("Narrow the range");
    });

    it("says nothing about a limit when the server did not flag one", () => {
      expect(doorCsvDownloaded(10_000, false)).toBe("10000 scans downloaded.");
    });
  });
});

describe("the log's states", () => {
  it("distinguishes a failed read from an empty one, and claims nothing about the doors", () => {
    expect(LOG_READ_FAILED).toContain("Nothing at the doors has changed");
    expect(LOG_READ_FAILED).not.toContain("No scans");
  });

  /**
   * The spec's own question — "nobody could get in through the side door all Tuesday" — has
   * an answer that is a SUGGESTION, because an empty result for one door has two causes and
   * the screen cannot tell them apart.
   */
  /**
   * C7. The suggestion used to be ASSERTED whatever the door was doing, so an admin who
   * filtered a perfectly healthy door to a quiet range was told its board might not be
   * reaching the club and sent to look for a fault that did not exist. It is derived from
   * the door's own liveness now — and the third arm says the screen does not know rather
   * than guessing either way.
   */
  it("derives the one-door empty case from that door's real liveness", () => {
    const reporting = doorLogEmptyOneDoor("Side door", "Mon 14 Sept, 00:00", true);
    expect(reporting).toContain("No scans at Side door between Mon 14 Sept, 00:00 and now");
    expect(reporting).toContain("It is reporting, so the club is hearing from it");
    expect(reporting).not.toContain("may not be reaching the club");
    expect(reporting).not.toContain("would not know");

    const silent = doorLogEmptyOneDoor("Side door", "Mon 14 Sept, 00:00", false);
    expect(silent).toContain("Nothing can reach it");
    expect(silent).toContain("the club would not know");

    const unknown = doorLogEmptyOneDoor("Side door", "Mon 14 Sept, 00:00", null);
    expect(unknown).toContain("cannot say whether that board is reaching the club");
  });

  it("tells a narrowed filter how to widen, and an unfiltered emptiness plainly", () => {
    expect(LOG_EMPTY_FILTERED).toBe("No scans match those filters.");
    expect(LOG_EMPTY_FILTERED_HINT).toContain("Try a longer time range");
    expect(LOG_EMPTY_NOTHING).toBe("No scans at any door in the last 24 hours.");
  });

  /** A failed "load older" keeps the rows it already has, and says the ones it has are right. */
  it("keeps the loaded rows true when the next page fails", () => {
    expect(LOG_OLDER_FAILED).toContain("Older scans could not be read");
  });

  it("says what exhausted means, with and without a retention number", () => {
    expect(doorExhaustedNotice(null)).toBe("That is everything in this range.");
    expect(doorExhaustedNotice(90)).toContain("Scans older than 90 days are deleted.");
  });
});

describe("the overview's own states", () => {
  /** The false claim here is worse than the members page's: it sends an admin to a fine board. */
  it("separates a failed read from an empty club, and neither implies the other", () => {
    expect(DOORS_READ_FAILED).toContain("Nothing has changed at the doors themselves");
    expect(DOORS_READ_FAILED).not.toContain("No doors have called in yet");
    expect(DOORS_EMPTY_NOTICE).toBe("No doors have called in yet.");
    expect(DOORS_EMPTY_HINT).toContain("registers itself the first time it is powered on");
  });

  /**
   * A stale page must not tell an admin to distrust the one number that is still right:
   * `relative(last_seen_at)` goes on being true while the poll is failing.
   */
  it("says how stale the page is AND that the ages are still counted from each door", () => {
    const notice = doorStaleChecksNotice(2, 47);
    expect(notice).toContain("The last 2 checks failed");
    expect(notice).toContain("read 47 seconds ago");
    expect(notice).toContain("still counted from when each door last called in");
  });

  it("says nothing while the checks are landing", () => {
    expect(doorStaleChecksNotice(0, 3)).toBeNull();
    expect(doorStaleChecksNotice(1, 20)).toBeNull();
  });
});

/**
 * What puts a door in front of an admin who did not come looking — the gear dot, the Home
 * row, the page's own status line.
 *
 * <p>
 * <b>Counted: silent, shut, unnamed. Not counted: signals and scan counts (A2.6).</b> A badge
 * that fires on a dirty scanner is a badge an admin learns to ignore before the badge that
 * fires on a dead board ever appears.
 * </p>
 */
/**
 * <b>C2's family, one screen along — found by looking at a rendered overview.</b>
 *
 * The banner correctly read "3 of 3 doors shut — 2 confirmed, 1 not yet", and the attention
 * line directly under it said "Side door is shut. Nobody gets in through it." about a door
 * the club had not heard from in an hour. A shut door that cannot be reached has not heard
 * the refusal: it goes on admitting members with a booking from the list it last
 * downloaded, for up to six hours. Two sentences on one screen, contradicting each other
 * about the same door.
 */
describe("doorAttentionReason, on a shut door nothing can reach", () => {
  it("does not claim nobody gets in through a door that has not been told", () => {
    const silent = doorAttentionReason(door({ enabled: false, name: "Side door" }), false, [])!;
    expect(silent.kind).toBe("shut");
    expect(silent.reason).not.toContain("Nobody gets in");
    expect(silent.reason).toContain("nothing can reach it");
    expect(silent.reason).toContain("may not have been told");
  });

  it("still says it plainly for a shut door the club CAN reach", () => {
    const reachable = doorAttentionReason(door({ enabled: false, name: "Side door" }), true, [])!;
    expect(reachable.reason).toBe("Side door is shut. Nobody gets in through it.");
  });
});

describe("doorNeedsAttention", () => {
  it("names the three states that need somebody, in the words Home uses", () => {
    expect(doorNeedsAttention(door({ last_seen_at: "2026-09-19T04:12:00Z" }), false))
      .toBe("Side door has not been heard from.");
    expect(doorNeedsAttention(door({ enabled: false }), true))
      .toBe("Side door is shut. Nobody gets in through it.");
    // A10: it said "A door still has no name" — which door? The summary above the tiles is
    // the reader's route to the card now that the cards no longer reorder, so every arm
    // names the door it is about.
    expect(doorNeedsAttention(door({ gate_key: null }), true))
      .toBe("Side door still has no name, so it opens nothing while it is offline.");
  });

  /**
   * <b>A8.</b> `null` is "this page cannot currently say". A reason derived from a frozen age
   * is a claim about a DOOR made out of a fact about the browser — so the unknown arm keeps
   * only what was actually read (shut, unnamed) and drops silence and the signals.
   */
  it("claims nothing about liveness when the page cannot say", () => {
    expect(doorNeedsAttention(door({ last_seen_at: "2026-09-19T04:12:00Z" }), null)).toBeNull();
    expect(doorAttentionReason(door(), null, [signal("refusal_spike")])).toBeNull();
    expect(doorNeedsAttention(door({ enabled: false }), null)).toBe("Side door is shut.");
    expect(doorNeedsAttention(door({ gate_key: null }), null))
      .toContain("still has no name");
  });

  it("says nothing about a door that is reporting, named and open", () => {
    expect(doorNeedsAttention(door(), true)).toBeNull();
  });

  /** Shut outranks silent: an admin who shut a door is not being told it has gone quiet. */
  it("reports a shut door as shut rather than as silent", () => {
    expect(doorNeedsAttention(door({ enabled: false, last_seen_at: null }), false))
      .toContain("is shut");
  });
});

describe("doorsAttentionSummary", () => {
  it("names one door as one", () => {
    expect(doorsAttentionSummary(["Side door has not been heard from."]))
      .toBe("Side door has not been heard from.");
  });

  it("names one and counts the rest", () => {
    expect(doorsAttentionSummary(["Side door has not been heard from.", "a", "b"]))
      .toBe("Side door has not been heard from. 2 other doors need attention.");
  });

  it("says one other door in the singular", () => {
    expect(doorsAttentionSummary(["Side door has not been heard from.", "a"]))
      .toContain("1 other door needs attention");
  });

  /** A failed read produces no reasons at all, and therefore no row and no dot. */
  it("says nothing when nothing needs attention", () => {
    expect(doorsAttentionSummary([])).toBeNull();
  });
});

describe("doorOutcomeChip", () => {
  const entry = (overrides: Partial<DeviceActivityEntry> = {}): DeviceActivityEntry => ({
    at: "2026-09-19T19:40:00Z", action: "gate.opened", reason: "ok", offline: false,
    member: null, fingerprint: null, ...overrides,
  });

  /** <b>A1.2.</b> The chip is the first thing on the row and it may not say the door moved. */
  it("says Lock released for a grant, online or offline, and never Opened", () => {
    expect(doorOutcomeChip(entry())).toBe("Lock released");
    expect(doorOutcomeChip(entry({ action: "device.gate_open", reason: null, offline: true }))).toBe("Lock released");
  });

  it("names the refusal reason where there is one", () => {
    expect(doorOutcomeChip(entry({ action: "gate.denied_no_booking", reason: "no_booking" }))).toBe("No booking");
    expect(doorOutcomeChip(entry({ action: "gate.denied_too_early", reason: "too_early" }))).toBe("Too early");
  });

  /** An offline refusal has no reason token at all — the board could not resolve the code. */
  it("says Refused for an offline refusal, which names nobody by construction", () => {
    expect(doorOutcomeChip(entry({ action: "device.unknown_scan", reason: null, offline: true }))).toBe("Refused");
  });

  /** A refusal reason this build does not know still gets a label rather than an empty chip. */
  it("labels an unrecognised refusal rather than rendering a blank chip", () => {
    const chip = doorOutcomeChip(entry({ action: "gate.denied_something_new", reason: "something_new" }));
    expect(chip.trim()).not.toBe("");
    expect(chip).toBe("Refused");
  });
});

describe("describePowerLoss", () => {
  it("has a sentence for each recorded value and for the default", () => {
    expect(describePowerLoss("not_established")).toBe("Not established");
    expect(describePowerLoss("released")).toBe("Released");
    expect(describePowerLoss("locked")).toBe("Locked");
  });

  /** An unrecognised value reads as the honest default, never as a blank. */
  it("falls back to the honest default rather than to an empty string", () => {
    expect(describePowerLoss("something_else")).toBe("Not established");
  });
});

/**
 * <b>The matrix.</b> Every generator on the surface, every arm of every conditional, held
 * against the vocabulary this programme refuses — and against the court box's, which is not
 * a door's and has rendered on a gate row once already.
 */
describe("the whole surface's vocabulary", () => {
  it("never uses a word that claims something this product cannot know", () => {
    const banned = [
      "lockdown", "attendance", "check-in", "check in", "checked in", "secure the building",
      "hold open", "hold-open", "unlock now", "who was in the building", "operator",
      "presence", "guarantee", "instantly", "immediately",
    ];
    for (const sentence of everySentence()) {
      for (const word of banned) {
        expect(sentence.toLowerCase(), `"${word}" in: ${sentence}`).not.toContain(word);
      }
    }
  });

  it("borrows nothing from the court box", () => {
    for (const sentence of everySentence()) {
      for (const boxOnly of ["court", "relay", "lights", "refunded in full"]) {
        expect(sentence.toLowerCase(), `"${boxOnly}" in: ${sentence}`).not.toContain(boxOnly);
      }
    }
  });

  it("renders no undefined, no null and no NaN on any arm", () => {
    for (const sentence of everySentence()) {
      for (const leak of ["undefined", "null", "NaN", "Invalid Date", "[object"]) {
        expect(sentence, sentence).not.toContain(leak);
      }
    }
  });
});

/**
 * <b>A1 / A2 — what a row calls a door that is gone.</b>
 *
 * The page read `entry.door.name` and a deleted door turned the whole club log white for
 * every admin. The ruling is that the history survives the board: the row carries what it
 * stored at write time, so the screen names it and says it has since been removed.
 */
describe("doorRowIdentity / doorRowName", () => {
  it("uses the name the row stored, and says the board is gone", () => {
    expect(doorRowName({ id: null, name: "Side door", gate_key: "side-door", removed: true }))
      .toBe("Side door — a door that has since been removed");
  });

  it("falls back to the stored key when the row has no name", () => {
    expect(doorRowName({ id: null, name: null, gate_key: "side-door", removed: true }))
      .toBe("side-door — a door that has since been removed");
  });

  it("says only that it is gone when the row stored neither", () => {
    expect(doorRowName({ id: null, name: null, gate_key: null, removed: true }))
      .toBe(REMOVED_DOOR_UNNAMED);
  });

  /** The shape WIRE-R2 §1 says can never happen, which is the shape that shipped. */
  it("treats a missing door as removed rather than throwing", () => {
    for (const door of [null, undefined]) {
      expect(doorRowName(door)).toBe(REMOVED_DOOR_UNNAMED);
      expect(doorRowIdentity(door).removed).toBe(true);
      expect(doorRowIdentity(door).id).toBeNull();
    }
  });

  /** No arm renders the word "null", an empty string, or a link to a page that is gone. */
  it("never renders a null, an empty label or a dead link", () => {
    const shapes = [
      null, undefined, {}, { id: null }, { removed: true },
      { id: null, name: null, gate_key: null, removed: true },
      { id: "x", name: "", gate_key: "", removed: false },
    ];
    for (const door of shapes) {
      const identity = doorRowIdentity(door);
      expect(identity.label.trim()).not.toBe("");
      expect(identity.label).not.toContain("null");
      expect(identity.label).not.toContain("undefined");
      if (identity.removed) expect(doorRowName(door)).toContain("removed");
    }
    expect(doorRowIdentity({ id: null, name: "Side door", removed: true }).id).toBeNull();
  });

  it("names a live door plainly, with no removal clause", () => {
    expect(doorRowName({ id: "abc", name: "Front door", gate_key: "front-door", removed: false }))
      .toBe("Front door");
  });
});

/**
 * <b>A11 — "Door gate" is what `DeviceRegistryService` calls every gate that registers
 * itself.</b> It is a placeholder, and presenting it as the club's own word for one board
 * names none of the five in the same state.
 */
describe("doorDisplayName / doorPickerLabel", () => {
  it("replaces the placeholder with something that identifies one board", () => {
    expect(doorDisplayName({ name: "Door gate", device_code: "gate-44c103" }))
      .toBe("Unnamed scanner (gate-44c103)");
  });

  it("leaves a name the club actually chose alone", () => {
    expect(doorDisplayName({ name: "Front door", device_code: "gate-44c103" })).toBe("Front door");
  });

  it("does not render an empty parenthesis for a board with no code", () => {
    expect(doorDisplayName({ name: "Door gate", device_code: null })).toBe("Unnamed scanner");
    expect(doorDisplayName({ name: null, device_code: null })).toBe("Unnamed scanner");
  });

  it("does not contradict itself in the picker", () => {
    expect(doorPickerLabel({ name: "Unnamed scanner (gate-44c103)", gate_key: null }))
      .toBe("Unnamed scanner (gate-44c103)");
    expect(doorPickerLabel({ name: "Front door", gate_key: "front-door" })).toBe("Front door (front-door)");
    expect(doorPickerLabel({ name: "Front door", gate_key: null })).toBe("Front door — no door name yet");
  });
});

describe("spellAge", () => {
  /** A screen reader reads "6m ago" as "six em ago". An accessible name is not a label. */
  it("spells the unit out, singular and plural", () => {
    expect(spellAge("12s ago")).toBe("12 seconds ago");
    expect(spellAge("1s ago")).toBe("1 second ago");
    expect(spellAge("6m ago")).toBe("6 minutes ago");
    expect(spellAge("3h ago")).toBe("3 hours ago");
    expect(spellAge("1d ago")).toBe("1 day ago");
  });

  /** "never" is already a word, and anything unrecognised is passed through rather than mangled. */
  it("leaves anything that is not an abbreviation alone", () => {
    expect(spellAge("never")).toBe("never");
  });
});
