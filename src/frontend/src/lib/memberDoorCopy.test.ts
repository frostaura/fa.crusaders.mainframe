import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BANNED_IN_MEMBER_DOOR_COPY,
  CONTACT_LEAD,
  DIAGNOSIS_HEADING,
  DIAGNOSIS_ROW_LABELS,
  DIAGNOSIS_TRIGGER,
  HISTORY_EMPTY,
  HISTORY_FAILED,
  HISTORY_INTRO,
  HISTORY_LOADING,
  HISTORY_MORE_FAILED,
  HISTORY_OFFLINE_LINE,
  HISTORY_P2_NOTICE,
  HISTORY_TITLE,
  MEMBER_DOOR_REASON_LINES,
  OFFLINE_DETAILS_SUMMARY,
  STANDING_HEADING,
  STANDING_LOADING,
  UNNAMED_DOOR,
  buildDiagnosis,
  codeExpiredDeadEnd,
  contactMissingNotice,
  contactUnknownNotice,
  liveContact,
  staleContact,
  CONTACT_UNKNOWN,
  DOOR_SECTION_CHECKING,
  decisionStamp,
  describeDecision,
  describeStanding,
  formatWindowMinutes,
  historyChip,
  historyLine,
  historyRetention,
  offlineDetailsBody,
  offlineIdentDeadEnd,
  offlineNoCode,
  offlineWithCode,
  standingFailed,
} from "./memberDoorCopy";
import { DOOR_REFUSAL_REASONS } from "./deviceActivity";
import { GATE_ROSTER_MAX_ENTRIES } from "./gateCopy";

/**
 * The member's door vocabulary, held against what a door can actually do.
 *
 * <p>
 * This module is the member's voice — second person, present tense, their own words —
 * and it is deliberately NOT part of `gateCopy.ts`, which is the admin's: third person,
 * about somebody else's scan. `deviceActivity.ts` says as much in its own comment
 * ("'Your booking has not started yet' would be the member's sentence and is the wrong
 * voice on this screen"). Two registers in one file is how one gets pasted into the other.
 * </p>
 *
 * <p>
 * Most of what follows is a claim probe rather than a spelling test. A door here is a
 * board that pulls, decides and energises a lock; there is no door sensor, no exit
 * detection and no push. Every banned word below is a sentence a reader would act on and
 * be wrong to.
 * </p>
 */
describe("memberDoorCopy", () => {
  const source = readFileSync(join(__dirname, "memberDoorCopy.ts"), "utf8");
  /**
   * Prose only.
   *
   * <p>
   * Three things are cut before the ban list is swept over the file, and each would
   * otherwise report the module for a word it does not say. A comment explaining why a
   * word is banned must not read as the word. And the ban list itself is a block of
   * string literals spelling every banned word out — the one place in the module where
   * they are meant to appear.
   * </p>
   */
  const prose = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/export const BANNED_IN_MEMBER_DOOR_COPY[\s\S]*?\] as const;/, "");

  const CONTACT = liveContact({ phone: "021 555 0134", email: "info@crusaders.co.za" });
  const NO_CONTACT = liveContact({ phone: null, email: null });
  /** D1's third state: no answer has ever landed, so the page knows NOTHING about a number. */
  const UNKNOWN_CONTACT = CONTACT_UNKNOWN;

  /** The decision context every arm that does not care about the clock can share. */
  const DECIDED = {
    countdown: null, opensAtClock: null, bookingStartsClock: null,
    earlyEntryMinutes: 0, contact: CONTACT,
  };

  /** A booking with both edges of its door window on it, as the endpoint always sends it. */
  const BOOKING = {
    starts_at: "2026-09-19T17:00:00Z",
    ends_at: "2026-09-19T17:45:00Z",
    court_number: 3,
    door_opens_at: "2026-09-19T16:30:00Z",
    door_closes_at: "2026-09-19T18:05:00Z",
  };

  /**
   * A standing-line input with every field the endpoint sends, so a test names only the
   * one field it is about.
   *
   * <p>
   * The default is the case that says the most with the least: an active member at a club
   * that opens for any active member, with nothing booked. Anything a test does not
   * override is a field it is asserting is IRRELEVANT to the rule under test, which is
   * what makes a one-field probe mean something.
   * </p>
   */
  function standingFor(overrides: Record<string, unknown> = {}) {
    return describeStanding({
      policy: "active_member",
      membership: "active",
      membership_detail: "active",
      is_club_admin: false,
      early_entry_minutes: 30,
      next_booking: null,
      ...overrides,
    } as Parameters<typeof describeStanding>[0]);
  }

  /** Every sentence this module can produce, for the probes that must sweep all of them. */
  function everySentence(): string[] {
    const out: string[] = [
      ...Object.values(MEMBER_DOOR_REASON_LINES),
      ...Object.values(DIAGNOSIS_ROW_LABELS),
      STANDING_HEADING, STANDING_LOADING, OFFLINE_DETAILS_SUMMARY, offlineDetailsBody(),
      DIAGNOSIS_TRIGGER, DIAGNOSIS_HEADING, CONTACT_LEAD, contactMissingNotice(),
      contactUnknownNotice(), DOOR_SECTION_CHECKING,
      codeExpiredDeadEnd("network", CONTACT), codeExpiredDeadEnd("server", NO_CONTACT),
      codeExpiredDeadEnd("network", UNKNOWN_CONTACT),
      HISTORY_TITLE, HISTORY_INTRO, HISTORY_P2_NOTICE, HISTORY_LOADING, HISTORY_FAILED,
      HISTORY_EMPTY, HISTORY_MORE_FAILED, HISTORY_OFFLINE_LINE,
      historyRetention(90), historyRetention(null),
      standingFailed(null, "network"), standingFailed(null, "server"),
      standingFailed({ body: "cached sentence", minutesAgo: 4 }, "network"),
      standingFailed({ body: "cached sentence", minutesAgo: 4 }, "server"),
      offlineWithCode({ fetchedAtClock: "06:02", minutesAgo: 7, kind: "booking" }),
      offlineWithCode({ fetchedAtClock: "06:02", minutesAgo: 7, kind: "ident" }),
      offlineNoCode(CONTACT), offlineNoCode(NO_CONTACT),
      offlineIdentDeadEnd(CONTACT), offlineIdentDeadEnd(NO_CONTACT),
    ];
    // The reason axis includes `null`, which the endpoint returns for a non-release row
    // whose details would not parse, and the offline axis forks the open.
    for (const reason of [...Object.keys(DOOR_REFUSAL_REASONS), null, "some_new_token"]) {
      for (const released of [true, false]) {
        for (const offline of [true, false]) {
          for (const contact of [CONTACT, NO_CONTACT]) {
            for (const earlyEntryMinutes of [0, 30, 240]) {
              const copy = describeDecision({ reason, released, offline }, {
                countdown: "27m 12s", opensAtClock: "06:30", bookingStartsClock: "07:00",
                earlyEntryMinutes, contact,
              });
              out.push(copy.headline, copy.body);
            }
          }
        }
      }
      for (const offline of [true, false]) {
        const row = { reason, released: reason === "ok", offline };
        out.push(historyChip(row).label, historyLine(row) ?? "");
      }
    }
    out.push(offlineDetailsBody(12), offlineDetailsBody(null));
    for (const policy of ["active_member", "booking_window"] as const) {
      for (const membership of ["active", "not_active", "none"] as const) {
        for (const detail of ["active", "pending_approval", "rejected", "suspended", "none", "lapsed_with_grace"]) {
          for (const is_club_admin of [true, false]) {
            for (const early_entry_minutes of [0, 1, 30, 90, 240]) {
              for (const next_booking of [null, BOOKING]) {
                out.push(standingFor({
                  policy, membership, membership_detail: detail,
                  is_club_admin, early_entry_minutes, next_booking,
                }).body);
              }
            }
          }
        }
      }
    }
    return out;
  }

  // --- the ban list --------------------------------------------------------------
  //
  // A3.7. The first group mirrors the claim probe already in the code page's own test;
  // the last three are this surface's additions and exist because a pull-only board with
  // no sensor makes every one of them a lie.

  it.each(BANNED_IN_MEMBER_DOOR_COPY)("never says %s, anywhere in the module", (banned) => {
    expect(prose.toLowerCase()).not.toContain(banned.toLowerCase());
  });

  it.each(BANNED_IN_MEMBER_DOOR_COPY)("never produces %s from any sentence it can build", (banned) => {
    for (const sentence of everySentence()) {
      expect(sentence.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  /**
   * The list itself is the test's subject, so it has to be the list the contract names.
   * A ban list that quietly loses an entry is a test that quietly stops testing.
   */
  it("bans exactly the thirteen substrings the contract names", () => {
    expect([...BANNED_IN_MEMBER_DOOR_COPY].sort()).toEqual([
      "always", "attendance", "check in", "checked in", "checking in", "guarantee",
      "immediately", "instant", "lights", "lockdown", "marks you as arrived", "operator",
      "presence", "relay", "secure the building",
    ].sort());
  });

  // --- the two dictionaries ------------------------------------------------------

  /**
   * Same keys, because the member and the admin are looking at the same seven decisions
   * a door can make; no shared sentence, because they are not the same reader.
   */
  it("covers every reason the admin dictionary covers", () => {
    expect(Object.keys(MEMBER_DOOR_REASON_LINES).sort()).toEqual(Object.keys(DOOR_REFUSAL_REASONS).sort());
  });

  it("shares no sentence with the admin dictionary", () => {
    const admin = new Set(Object.values(DOOR_REFUSAL_REASONS).map((s) => s.toLowerCase()));
    for (const line of Object.values(MEMBER_DOOR_REASON_LINES)) {
      expect(admin.has(line.toLowerCase())).toBe(false);
    }
  });

  it("speaks to the member rather than about them", () => {
    // Third person about a member is the admin register. "Your", "you", "this screen".
    const memberVoice = Object.values(MEMBER_DOOR_REASON_LINES).filter((s) => /\byou(r)?\b/i.test(s));
    expect(memberVoice.length).toBeGreaterThanOrEqual(Object.keys(MEMBER_DOOR_REASON_LINES).length - 1);
  });

  // --- the decision card ---------------------------------------------------------

  it("gives every reason a headline, a body and a tone", () => {
    for (const reason of Object.keys(DOOR_REFUSAL_REASONS)) {
      const copy = describeDecision({ reason, released: reason === "ok", offline: false }, DECIDED);
      expect(copy.headline.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
      expect(["success", "info", "warning", "danger"]).toContain(copy.tone);
    }
  });

  /**
   * A reason this build has never heard of must reach a sentence, not a blank card and
   * not a raw token. The same rule `describeActivityReason` follows on the admin side.
   */
  it("answers a reason it has never heard of without printing the token", () => {
    const copy = describeDecision({ reason: "some_new_token", released: false, offline: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, earlyEntryMinutes: 0, contact: CONTACT,
    });
    expect(copy.headline).not.toContain("some_new_token");
    expect(copy.body).not.toContain("some_new_token");
    expect(copy.body.length).toBeGreaterThan(0);
  });

  /** Contract W1.7b: `too_early` is a clock fact, not a fault. Info tone, never danger. */
  it("gives too_early the info tone and a live countdown, never an error tone", () => {
    const copy = describeDecision({ reason: "too_early", released: false, offline: false }, {
      countdown: "27m 12s", opensAtClock: "06:30", bookingStartsClock: "07:00", earlyEntryMinutes: 0, contact: CONTACT,
    });
    expect(copy.tone).toBe("info");
    expect(copy.headline).toContain("27m 12s");
    expect(copy.body).toContain("06:30");
    expect(copy.body).toMatch(/nothing is wrong with your code/i);
  });

  it("says the door opens now once the countdown has run out, and does not change tone", () => {
    const copy = describeDecision({ reason: "too_early", released: false, offline: false }, {
      countdown: "0s", opensAtClock: "06:30", bookingStartsClock: "07:00", earlyEntryMinutes: 0, contact: CONTACT,
    });
    expect(copy.tone).toBe("info");
    expect(copy.headline).toMatch(/opens for you now/i);
    expect(copy.headline).not.toContain("0s");
  });

  /**
   * The other half of the conditional the wave-1 wire shape forces: `too_early` arrives
   * with no window at all when the booking that caused it has since gone. Saying "in
   * 27m 12s" there would be inventing a clock time.
   */
  it("states too_early without a countdown when the server sent no window", () => {
    const copy = describeDecision({ reason: "too_early", released: false, offline: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, earlyEntryMinutes: 0, contact: CONTACT,
    });
    expect(copy.tone).toBe("info");
    expect(copy.headline).not.toMatch(/\d/);
    expect(copy.body).toMatch(/nothing is wrong with your code/i);
  });

  it("offers a court to book when the door wanted one", () => {
    const copy = describeDecision({ reason: "no_booking", released: false, offline: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, earlyEntryMinutes: 0, contact: CONTACT,
    });
    expect(copy.actions).toContainEqual({ kind: "book_a_court", label: "Book a court" });
    expect(copy.tone).toBe("warning");
  });

  it("sends a member the club has as not active to the club, not to their own settings", () => {
    const copy = describeDecision({ reason: "member_not_active", released: false, offline: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, earlyEntryMinutes: 0, contact: CONTACT,
    });
    expect(copy.tone).toBe("danger");
    expect(copy.actions).toContainEqual({ kind: "call_the_club", label: "Call the club", href: "tel:0215550134" });
    expect(copy.body).toMatch(/nothing you can fix on this phone/i);
  });

  /** Both halves: a club with an address and no number gets the other control. */
  it("offers email when the club gave no phone number", () => {
    const copy = describeDecision({ reason: "member_not_active", released: false, offline: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, earlyEntryMinutes: 0,
      contact: liveContact({ phone: null, email: "info@crusaders.co.za" }),
    });
    expect(copy.actions).toContainEqual({
      kind: "email_the_club", label: "Email the club", href: "mailto:info@crusaders.co.za",
    });
  });

  it("offers neither, and says so, when the club gave no way to reach it", () => {
    const copy = describeDecision({ reason: "member_not_active", released: false, offline: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, earlyEntryMinutes: 0, contact: NO_CONTACT,
    });
    expect(copy.actions).toEqual([]);
    expect(contactMissingNotice()).toMatch(/written on the door/i);
  });

  /**
   * P2, on the one arm where it is easiest to break. The board reported releasing a
   * lock. It did not report that a door moved, and it cannot: there is no sensor on it.
   */
  it("says the lock released, and never that the door opened or that anyone went in", () => {
    const copy = describeDecision({ reason: "ok", released: true, offline: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, earlyEntryMinutes: 0, contact: CONTACT,
    });
    expect(copy.tone).toBe("success");
    expect(`${copy.headline} ${copy.body}`).toMatch(/released/i);
    expect(`${copy.headline} ${copy.body}`).not.toMatch(/door opened|went in|walked in|you are in|let you through/i);
    expect(copy.body).toMatch(/no sensor/i);
    expect(copy.actions).toEqual([]);
  });

  // --- the stamp -----------------------------------------------------------------

  it("stamps a decision with the club's own door name and the time of the scan", () => {
    expect(decisionStamp("front-door", "2026-09-19T06:04:00Z")).toMatch(/^front-door · \d{2}:\d{2}$/);
  });

  /** A door the club has not named is said in words, never as a blank or a device id. */
  it("names an unnamed door in words", () => {
    const stamp = decisionStamp(null, "2026-09-19T06:04:00Z");
    expect(stamp).toContain(UNNAMED_DOOR);
    expect(stamp).not.toMatch(/[0-9a-f]{8}-|gate-|null/);
  });

  // --- the standing line ---------------------------------------------------------

  it("states the active-member rule and this member's own standing, with no clock time", () => {
    const line = standingFor({ policy: "active_member" });
    expect(line.body).toMatch(/any active member/i);
    expect(line.body).not.toMatch(/\d{2}:\d{2}/);
    expect(line.hasClockWindow).toBe(false);
  });

  it("states both halves when the club has the membership as not active", () => {
    for (const policy of ["active_member", "booking_window"] as const) {
      const line = standingFor({ policy, membership: "not_active", membership_detail: "suspended" });
      expect(line.body).toMatch(/suspended/i);
      expect(line.body).toMatch(/until they change that/i);
    }
  });

  it("names the booking, its court and the door's window under the booking-window rule", () => {
    const line = standingFor({ policy: "booking_window", next_booking: BOOKING });
    expect(line.body).toMatch(/a court booked/i);
    expect(line.body).toMatch(/\d{2}:\d{2}/);
    expect(line.body).toMatch(/on court 3/);
    expect(line.hasClockWindow).toBe(true);
  });

  /**
   * `court_number` is the one nullable half of the booking — the endpoint reads it with a
   * `FirstOrDefaultAsync` against `Courts`, so a booking whose court has since been
   * removed carries null. The sentence drops the clause rather than saying "court null".
   */
  it("drops the court clause for a booking whose court has gone", () => {
    const line = standingFor({ policy: "booking_window", next_booking: { ...BOOKING, court_number: null } });
    expect(line.body).toMatch(/\d{2}:\d{2}/);
    expect(line.body).not.toMatch(/on court/i);
    expect(line.body).not.toMatch(/null|undefined/i);
    expect(line.hasClockWindow).toBe(true);
  });

  it("offers a court to book when the booking-window rule has nothing to work with", () => {
    const line = standingFor({ policy: "booking_window" });
    expect(line.action).toEqual({ kind: "book_a_court", label: "Book a court" });
    expect(line.hasClockWindow).toBe(false);
  });

  /**
   * The suppression rule has two reasons and only one of them was designed in.
   *
   * <p>
   * Duplication was: a line carrying a clock window makes the code card's clause a
   * second, vaguer copy. CONTRADICTION was not, and it is worse — a member the club has
   * as not active, or one with no qualifying booking, reads here that no code of theirs
   * opens a door while the code card, fed by a request that does not know the policy,
   * promises a window a centimetre above. Found by looking at the rendered page.
   * </p>
   */
  it("suppresses the code card's door clause on every arm that would contradict it", () => {
    for (const policy of ["active_member", "booking_window"] as const) {
      expect(standingFor({ policy, membership: "not_active", membership_detail: "suspended", next_booking: BOOKING })
        .suppressesCodeClause).toBe(true);
    }
    expect(standingFor({ policy: "booking_window" }).suppressesCodeClause).toBe(true);
    expect(standingFor({ policy: "booking_window", next_booking: BOOKING }).suppressesCodeClause).toBe(true);
  });

  /**
   * And the arms where the clause earns its place, because none of these lines carries a
   * clock of its own and none of them contradicts a door that does open.
   *
   * <p>
   * The club-admin arm is the one added here and it is the interesting one: a door DOES
   * open for that member, so suppressing the clause would take away the only clock times
   * on the page for the booking they may well also have.
   * </p>
   */
  it("keeps the code card's door clause on every arm where a door still opens", () => {
    for (const line of [
      standingFor({ policy: "active_member" }),
      standingFor({ policy: "active_member", membership: "none", membership_detail: "none" }),
      standingFor({ policy: "booking_window", is_club_admin: true }),
    ]) {
      expect(line.suppressesCodeClause).toBe(false);
      expect(line.hasClockWindow).toBe(false);
    }
  });

  it("says it cannot check, and what it last heard, when the read failed", () => {
    const withCache = standingFailed({ body: "Your club opens its doors for any active member.", minutesAgo: 4 }, "network");
    expect(withCache).toMatch(/can't reach the club/i);
    expect(withCache).toContain("Your club opens its doors for any active member.");
    expect(withCache).toMatch(/4 minutes ago/);
    expect(withCache).toMatch(/may have changed/i);
  });

  /** Three silences, three sentences: no cache is not the same sentence as a stale one. */
  it("says something different when there is no cached copy at all", () => {
    const withCache = standingFailed({ body: "anything", minutesAgo: 4 }, "network");
    const without = standingFailed(null, "network");
    expect(without).not.toBe(withCache);
    expect(without).toMatch(/can't reach the club/i);
    expect(without).not.toMatch(/ago/);
  });

  // --- the offline half of the conditional (P6) -----------------------------------

  it("states what an offline door can and cannot do, with the roster cap it is given", () => {
    const body = offlineDetailsBody();
    expect(body).toContain(String(GATE_ROSTER_MAX_ENTRIES));
    expect(body).toMatch(/bookings/i);
    // The half that is easiest to leave out — a door the club has not finished setting
    // up gets no list at all. D7: never phrased as a door "the club hasn't named", which
    // is an admin fact and contradicted this member's own history.
    expect(body).toMatch(/still setting up/i);
    expect(body).not.toMatch(/hasn't named/i);
  });

  it("never types the roster cap as a literal", () => {
    // The number must be interpolated from the constant the firmware and the API share.
    expect(prose).not.toMatch(/\b48\b/);
  });

  // --- the offline page -----------------------------------------------------------

  it("says how old a cached code is and does not promise it works", () => {
    const text = offlineWithCode({ fetchedAtClock: "06:02", minutesAgo: 7, kind: "booking" });
    expect(text).toContain("06:02");
    expect(text).toMatch(/7 minutes ago/);
    expect(text).toMatch(/probably/i);
  });

  it("closes the door on a dead cached code rather than showing a hopeful one", () => {
    const text = offlineNoCode(CONTACT);
    expect(text).toMatch(/run out/i);
    expect(text).toContain("021 555 0134");
  });

  /**
   * D5, and the sharpest honest sentence on this surface. An ident code lives about a
   * minute, and a door that has lost the club's network holds bookings and nothing else —
   * so this member cannot get in, and the page owes them that rather than a QR.
   */
  it("tells a member holding only an ident code with no signal that it cannot open a cut-off door", () => {
    const text = offlineIdentDeadEnd(CONTACT);
    expect(text).toMatch(/about a minute/i);
    expect(text).toMatch(/a court booked/i);
    expect(text).toContain("021 555 0134");
  });

  it("tells a member with no club contact where the only remaining answer is", () => {
    expect(offlineIdentDeadEnd(NO_CONTACT)).toMatch(/written on the door/i);
    expect(offlineNoCode(NO_CONTACT)).toMatch(/written on the door/i);
  });

  // --- the self-diagnosis ----------------------------------------------------------

  const HEALTHY = {
    membership: "active" as const,
    membership_detail: "active",
    policy: "booking_window" as const,
    hasBooking: true,
    bookingStartsClock: "19:00",
    doorWindowOpen: true,
    opensAtClock: "18:30",
    opensInWords: "27 minutes",
    codeSecondsLeft: 58,
    connection: "ok" as const,
    contact: CONTACT,
  };

  it("asks six questions, each with its state in words as well as in colour", () => {
    const { rows } = buildDiagnosis(HEALTHY);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(["Passed", "Needs attention", "Failed", "Not what decides it here", "The club's rule, not a check"]).toContain(row.stateWord);
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.value.length).toBeGreaterThan(0);
    }
  });

  /**
   * The all-clear arm, which is the one that matters and the one easiest to omit. It is
   * never "no refusals found", never "nothing to show", and never blank.
   */
  it("concludes that the problem is at the door when nothing on the phone is wrong", () => {
    const { conclusion } = buildDiagnosis(HEALTHY);
    expect(conclusion).toMatch(/at the door/i);
    expect(conclusion).toContain("021 555 0134");
    expect(conclusion).not.toMatch(/no refusal|nothing to show|no recent|nothing found/i);
  });

  it("never concludes with nothing, whatever it is given", () => {
    const shapes = [
      HEALTHY,
      { ...HEALTHY, membership: "not_active" as const, membership_detail: "suspended" },
      { ...HEALTHY, membership: "none" as const, membership_detail: "none" },
      { ...HEALTHY, connection: "network" as const },
      { ...HEALTHY, hasBooking: false, bookingStartsClock: null, doorWindowOpen: null, opensAtClock: null, opensInWords: null },
      { ...HEALTHY, doorWindowOpen: false },
      { ...HEALTHY, codeSecondsLeft: 0 },
      { ...HEALTHY, policy: "active_member" as const, hasBooking: false, bookingStartsClock: null, doorWindowOpen: null, opensAtClock: null, opensInWords: null },
      { ...HEALTHY, contact: NO_CONTACT },
    ];
    for (const shape of shapes) {
      const { conclusion, rows } = buildDiagnosis(shape);
      expect(conclusion.length).toBeGreaterThan(20);
      expect(rows).toHaveLength(6);
    }
  });

  /** First failing row wins, so the member is given ONE thing to do rather than five. */
  it("names the membership and nothing else when the membership is the first failure", () => {
    const { conclusion } = buildDiagnosis({ ...HEALTHY, membership: "not_active" as const, membership_detail: "pending_approval", connection: "network" as const, codeSecondsLeft: 0 });
    expect(conclusion).toMatch(/membership/i);
    expect(conclusion).not.toMatch(/had run out/i);
  });

  it("says the check is guessing when the phone could not reach the club", () => {
    const { conclusion, rows } = buildDiagnosis({ ...HEALTHY, connection: "network" as const });
    expect(conclusion).toMatch(/guessing/i);
    const connection = rows.find((r) => r.key === "connection")!;
    expect(connection.stateWord).toBe("Failed");
  });

  it("sends a member with no booking to book one under the booking-window rule", () => {
    const { conclusion } = buildDiagnosis({
      ...HEALTHY, hasBooking: false, bookingStartsClock: null, doorWindowOpen: null, opensAtClock: null, opensInWords: null,
    });
    expect(conclusion).toMatch(/book/i);
  });

  it("tells a member whose window has not opened to wait, and says when", () => {
    const { conclusion } = buildDiagnosis({ ...HEALTHY, doorWindowOpen: false });
    expect(conclusion).toContain("18:30");
    expect(conclusion).toContain("27 minutes");
    expect(conclusion).toMatch(/everything else/i);
  });

  /** Through the shared formatter: "fresh, 900s left" is not a number anybody reads. */
  it("says how long a code has left in minutes and seconds, not in raw seconds", () => {
    const { rows } = buildDiagnosis({ ...HEALTHY, codeSecondsLeft: 900 });
    const code = rows.find((r) => r.key === "code")!;
    expect(code.value).toBe("fresh, 15m 00s left");
  });

  it("tells a member whose code had run out that there is a fresh one", () => {
    const { conclusion } = buildDiagnosis({ ...HEALTHY, codeSecondsLeft: 0 });
    expect(conclusion).toMatch(/run out/i);
    expect(conclusion).toMatch(/fresh one/i);
  });

  /** The trigger is the member's own sentence, not a support-desk word. */
  it("labels its trigger in the member's words", () => {
    expect(DIAGNOSIS_TRIGGER).toBe("The door didn't open");
    expect(DIAGNOSIS_TRIGGER).not.toMatch(/help|troubleshoot|diagnos/i);
  });

  // --- the history card -------------------------------------------------------------

  it("gives every reason a chip and a tone", () => {
    for (const reason of Object.keys(DOOR_REFUSAL_REASONS)) {
      const chip = historyChip({ reason, released: reason === "ok", offline: false });
      expect(chip.label.length).toBeGreaterThan(0);
      expect(["muted", "success", "info", "warning", "danger"]).toContain(chip.tone);
    }
  });

  /** A1.2: the outcome chip in a feed reads "Lock released", never "Opened". */
  it("labels an open as a lock released, never as a door that opened", () => {
    const chip = historyChip({ reason: "ok", released: true, offline: false });
    expect(chip.label).toBe("Lock released");
    expect(chip.tone).toBe("success");
  });

  it("says an offline row was decided from the door's own downloaded list", () => {
    const line = MEMBER_DOOR_REASON_LINES.ok;
    expect(line.length).toBeGreaterThan(0);
    const chip = historyChip({ reason: "ok", released: true, offline: true });
    expect(chip.label).toBe("Lock released");
  });

  it("states the retention the server gave, and refuses to invent one", () => {
    expect(historyRetention(90)).toContain("90");
    expect(historyRetention(null)).toMatch(/hasn't set/i);
    expect(historyRetention(null)).not.toMatch(/\b90\b/);
  });

  /**
   * Three states for every read, and the failed one must not read as the empty one.
   * A list initialised to [] renders its empty state on a FAILED read; that is the defect
   * this pair of sentences exists to make impossible.
   */
  it("distinguishes an empty record from a failed read, in words", () => {
    expect(HISTORY_EMPTY).not.toBe(HISTORY_FAILED);
    expect(HISTORY_EMPTY).toMatch(/real answer/i);
    expect(HISTORY_FAILED).toMatch(/doesn't mean there's nothing there/i);
    expect(HISTORY_LOADING).not.toBe(HISTORY_EMPTY);
    expect(HISTORY_MORE_FAILED).not.toBe(HISTORY_FAILED);
  });

  /** P2, stated on the card rather than implied by the chips. */
  it("states that there is no sensor and that nothing here says anyone went in", () => {
    expect(HISTORY_P2_NOTICE).toMatch(/no sensor/i);
    expect(HISTORY_P2_NOTICE).toMatch(/released the lock/i);
    expect(HISTORY_P2_NOTICE).not.toMatch(/walked in|went in|entered the building/i);
  });

  /** P3: a member's own history is theirs, and the club's log cannot be filtered to a person. */
  it("says the club's own door log cannot be filtered to a person", () => {
    expect(HISTORY_INTRO).toMatch(/only yours/i);
    expect(HISTORY_INTRO).toMatch(/can't be filtered/i);
  });

  // --- headings that other modules must not drift from -------------------------------

  it("keeps its headings stable", () => {
    expect(STANDING_HEADING).toBe("What opens the door for you right now");
    expect(STANDING_LOADING).toMatch(/checking/i);
    expect(DIAGNOSIS_HEADING).toMatch(/work out why/i);
    expect(HISTORY_TITLE).toBe("My door history");
    expect(OFFLINE_DETAILS_SUMMARY).toBe("What if the door is offline?");
    expect(CONTACT_LEAD).toMatch(/can't get in/i);
  });

  /** No sentence may name another member, a token, a fingerprint, a MAC or a device id. */
  it("names nobody and nothing but the door the club chose to call it", () => {
    for (const sentence of everySentence()) {
      expect(sentence).not.toMatch(/[0-9a-f]{2}(:[0-9a-f]{2}){5}/i);
      expect(sentence).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(sentence).not.toMatch(/fingerprint|token|device id|MAC address/i);
    }
  });

  // --- what the real API carries that the stub never did -----------------------------
  //
  // Everything below this line exists because the wave-1 wire shape this module was
  // written against is NARROWER than the endpoint that now serves it. Each rule names a
  // field the page was previously guessing at, or saying nothing about.

  // --- `ok` + `offline` — the other half of the open (§6.1) --------------------------

  /**
   * A door that could not reach the club decided from the list it had already downloaded.
   * Saying only "the lock released" there drops the half of the conditional P6 exists for:
   * the member's booking was checked against a snapshot, and the club's record of it
   * arrived afterwards.
   */
  it("separates an open the club decided from one the door decided alone", () => {
    const online = describeDecision({ reason: "ok", released: true, offline: false }, DECIDED);
    const offline = describeDecision({ reason: "ok", released: true, offline: true }, DECIDED);

    expect(offline.tone).toBe("success");
    expect(offline.headline).not.toBe(online.headline);
    expect(offline.body).toMatch(/couldn't reach the club/i);
    expect(offline.body).toMatch(/downloaded/i);
    expect(offline.actions).toEqual([]);
  });

  /** A1.2 binds the offline arm exactly as it binds the online one. */
  it("still says the lock released rather than that the door opened, on the offline arm", () => {
    const copy = describeDecision({ reason: "ok", released: true, offline: true }, DECIDED);
    expect(`${copy.headline} ${copy.body}`).toMatch(/released/i);
    expect(`${copy.headline} ${copy.body}`).not.toMatch(/door opened|went in|walked in|let you in|you are in/i);
  });

  /** A refusal a door decided alone is still that refusal. `offline` forks the OPEN only. */
  it("leaves every refusal unchanged when the door decided it alone", () => {
    for (const reason of Object.keys(DOOR_REFUSAL_REASONS).filter((r) => r !== "ok")) {
      const online = describeDecision({ reason, released: false, offline: false }, DECIDED);
      const offline = describeDecision({ reason, released: false, offline: true }, DECIDED);
      expect(offline).toEqual(online);
    }
  });

  // --- a reason the row never carried (nullability) ----------------------------------

  /**
   * `MeDoorEndpoints` returns `reason: null` for a non-release row whose details would not
   * parse — `DoorActivityView.Details` swallows the `JsonException` and `Reason` then has
   * nothing to read. The page met that shape for the first time here.
   */
  it("answers a decision that carries no reason at all", () => {
    const copy = describeDecision({ reason: null, released: false, offline: false }, DECIDED);
    expect(copy.headline.length).toBeGreaterThan(0);
    expect(copy.body.length).toBeGreaterThan(0);
    expect(`${copy.headline} ${copy.body}`).not.toMatch(/null|undefined/i);
  });

  it("chips and lines a history row that carries no reason", () => {
    const chip = historyChip({ reason: null, released: false, offline: false });
    expect(chip.label).toBe("Turned away");
    expect(chip.tone).toBe("muted");
    expect(historyLine({ reason: null, released: false, offline: false })).toBeNull();
  });

  /**
   * P6 on a history row, and the arm the mutation pass found nothing was holding: a row a
   * cut-off door decided alone says so, whatever it decided. `released` is checked FIRST
   * everywhere else on this surface, so an open that was also offline is precisely the
   * fixture that tells the two orderings apart — and it is the row a member is most likely
   * to be puzzled by, because the club's own screens showed nothing at the time.
   */
  it.each([
    ["an open", { reason: "ok", released: true }],
    ["a refusal", { reason: "no_booking", released: false }],
    ["a refusal with no reason on it", { reason: null, released: false }],
  ])("marks %s the door decided from its own list", (_case, row) => {
    expect(historyLine({ ...row, offline: true })).toBe(HISTORY_OFFLINE_LINE);
    expect(historyLine({ ...row, offline: false })).not.toBe(HISTORY_OFFLINE_LINE);
  });

  // --- `early_entry_minutes` — the club's own number (§6.1, §6.2) ---------------------

  /**
   * "None starting soon enough for a door to open" was the sentence the thin wire forced:
   * the page had no number to name. It has one now, the server clamps it, and the page
   * never clamps — so what it is handed is what it says.
   */
  it("names the club's own early-entry window on the no-booking refusal", () => {
    const copy = describeDecision({ reason: "no_booking", released: false, offline: false },
      { ...DECIDED, earlyEntryMinutes: 30 });
    expect(copy.body).toMatch(/in the next 30 minutes/i);
  });

  it("names the same window on the standing line's no-booking arm", () => {
    const line = standingFor({ policy: "booking_window", early_entry_minutes: 30 });
    expect(line.body).toMatch(/in the next 30 minutes/i);
    expect(line.action).toEqual({ kind: "book_a_court", label: "Book a court" });
  });

  /**
   * Both halves. `gate_early_entry_minutes` clamps to 0..240 and a club may genuinely have
   * it at zero, where "nothing booked in the next 0 minutes" is not a sentence. The old
   * wording is the floor, not a fallback nobody reaches.
   */
  it("falls back to the wordless window when the club's number is zero", () => {
    const copy = describeDecision({ reason: "no_booking", released: false, offline: false },
      { ...DECIDED, earlyEntryMinutes: 0 });
    expect(copy.body).toMatch(/soon enough for a door to open/i);
    expect(copy.body).not.toMatch(/\b0 minutes\b/);

    const line = standingFor({ policy: "booking_window", early_entry_minutes: 0 });
    expect(line.body).toMatch(/soon enough for a door to open/i);
    expect(line.body).not.toMatch(/\b0 minutes\b/);
  });

  it.each([
    [1, "1 minute"],
    [30, "30 minutes"],
    [59, "59 minutes"],
    [60, "1 hour"],
    [90, "1 hour 30 minutes"],
    [120, "2 hours"],
    [240, "4 hours"],
  ])("says %i minutes as %s", (minutes, words) => {
    expect(formatWindowMinutes(minutes)).toBe(words);
  });

  // --- `is_club_admin` — §6.2 row 7 --------------------------------------------------

  /**
   * §5's carve-out, which `GateAccess` makes at line 442: a club admin passes the BOOKING
   * check under `booking_window` and is held to the membership check like everybody. The
   * page was telling its own club admins to book a court.
   */
  it("tells a club admin under the booking rule that a door opens without a booking", () => {
    const line = standingFor({ policy: "booking_window", is_club_admin: true });
    expect(line.body).toMatch(/a court booked/i);
    expect(line.body).toMatch(/club admin/i);
    expect(line.body).toMatch(/without one/i);
    expect(line.action).toBeNull();
  });

  /**
   * P6 on the sentence that costs the most to leave out: the roster a cut-off door decides
   * from holds BOOKINGS, and an admin is not in it.
   */
  it("states the offline half of the club-admin carve-out", () => {
    const line = standingFor({ policy: "booking_window", is_club_admin: true });
    expect(line.body).toMatch(/lost the network/i);
    expect(line.body).toMatch(/bookings, not admins/i);
  });

  /** The carve-out is the booking check only — a suspended admin is still refused. */
  it("does not let the club-admin arm outrank the membership one", () => {
    const line = standingFor({
      policy: "booking_window", is_club_admin: true,
      membership: "not_active", membership_detail: "suspended",
    });
    expect(line.body).toMatch(/suspended/i);
    expect(line.body).not.toMatch(/club admin/i);
  });

  /** Under `active_member` an admin is an active member and the carve-out says nothing. */
  it("says nothing about being an admin when the club opens for any active member", () => {
    const line = standingFor({ policy: "active_member", is_club_admin: true });
    expect(line.body).not.toMatch(/club admin/i);
    expect(line.body).toMatch(/any active member/i);
  });

  // --- `membership_detail` — which not-active this is (§6.2 row 3) --------------------

  it.each([
    ["pending_approval", /not yet approved/i],
    ["suspended", /suspended/i],
    ["rejected", /turned down/i],
  ])("says which not-active %s is", (detail, expected) => {
    for (const policy of ["active_member", "booking_window"] as const) {
      const line = standingFor({ policy, membership: "not_active", membership_detail: detail });
      expect(line.body).toMatch(expected);
      expect(line.body).toMatch(/until they change that/i);
      expect(line.suppressesCodeClause).toBe(true);
    }
  });

  /**
   * A detail this build has never heard of — `lapsed`, when the deferred grace-days work
   * lands — must reach the sentence the wire shape used to force, not a blank.
   */
  it("falls back to not active for a detail it has never heard of", () => {
    const line = standingFor({
      policy: "active_member", membership: "not_active", membership_detail: "lapsed_with_grace",
    });
    expect(line.body).toMatch(/not active/i);
    expect(line.body).not.toMatch(/lapsed_with_grace/);
  });

  /**
   * `membership: "none"` is a user with no membership row, and `MembershipAccess` does NOT
   * treat that as barred — `StatusIfBarredAsync` returns null for it and `GateAccess` walks
   * straight past the check. Telling that member the club has them as not active is the
   * page contradicting the door they are standing at.
   */
  it("does not tell a member with no membership row that theirs is not active", () => {
    const line = standingFor({ policy: "active_member", membership: "none", membership_detail: "none" });
    expect(line.body).not.toMatch(/not active|until they change that/i);
    expect(line.body).toMatch(/opens the club door/i);
  });

  it("still applies the booking rule to a member with no membership row", () => {
    const line = standingFor({ policy: "booking_window", membership: "none", membership_detail: "none" });
    expect(line.body).not.toMatch(/not active/i);
    expect(line.body).toMatch(/a court booked/i);
  });

  // --- `roster_max_entries` — the club's own cap -------------------------------------

  /**
   * The firmware and the API share this number and the response now carries it. The
   * constant stays as the fallback for a response that predates the field, which is what
   * `readLastKnown` can still hand back after a version bump nobody has written yet.
   */
  it("takes the roster cap from the wire when it is given one", () => {
    expect(offlineDetailsBody(12)).toContain("next 12 bookings");
    expect(offlineDetailsBody(12)).not.toContain(`${GATE_ROSTER_MAX_ENTRIES}`);
  });

  it("falls back to the shared constant when the wire carried no cap", () => {
    for (const absent of [null, undefined, 0, -3]) {
      expect(offlineDetailsBody(absent)).toContain(`next ${GATE_ROSTER_MAX_ENTRIES} bookings`);
    }
  });

  // --- D1: the club's contact is THREE states, and a failed read is not "none" ---------

  /**
   * The finding this closes, in one sentence: a `/me/door` that failed on first load
   * rendered "This club hasn't given the app a number to call" — a confident negative
   * fact derived from a read that never landed. Three states, three sentences, and the
   * unknown one may never be mistaken for the empty one.
   */
  it("says it could not load the club's number rather than that the club has none", () => {
    const unknown = contactUnknownNotice();
    expect(unknown).not.toBe(contactMissingNotice());
    expect(unknown).toMatch(/couldn't load|could not load/i);
    expect(unknown).not.toMatch(/hasn't given|has not given|no number/i);
  });

  /** No member screen tells a member to go and change a club setting they cannot see. */
  it("never sends a member to Admin settings", () => {
    for (const sentence of everySentence()) {
      expect(sentence).not.toMatch(/admin settings/i);
    }
    expect(contactMissingNotice()).not.toMatch(/admin/i);
  });

  /**
   * The conclusion of a self-check, and the closing line of the offline arms, must not
   * assert "whatever is written on the door is the ONLY way from here" off a read that
   * never landed. That sentence is the none-set arm and nothing else.
   */
  it("never claims the door notice is the only way in when it could not read the club's number", () => {
    const shapes = [
      offlineNoCode(UNKNOWN_CONTACT),
      offlineIdentDeadEnd(UNKNOWN_CONTACT),
      buildDiagnosis({ ...HEALTHY, contact: UNKNOWN_CONTACT }).conclusion,
      codeExpiredDeadEnd("network", UNKNOWN_CONTACT),
    ];
    for (const text of shapes) {
      expect(text).not.toMatch(/only way from here/i);
      expect(text).not.toMatch(/hasn't given the app a number/i);
    }
  });

  it("offers no call button off a contact it never managed to read", () => {
    const copy = describeDecision({ reason: "member_not_active", released: false, offline: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, earlyEntryMinutes: 0,
      contact: UNKNOWN_CONTACT,
    });
    expect(copy.actions).toEqual([]);
  });

  /** A last-known number is still a number, and its age travels with it. */
  it("keeps a last-known number usable, and says how old it is", () => {
    const stale = staleContact({ phone: "021 555 0134", email: null }, 6);
    const copy = describeDecision({ reason: "member_not_active", released: false, offline: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, earlyEntryMinutes: 0, contact: stale,
    });
    expect(copy.actions).toContainEqual({ kind: "call_the_club", label: "Call the club", href: "tel:0215550134" });
    expect(stale.minutesAgo).toBe(6);
  });

  // --- D2: the phone failing and the club's system failing are different sentences ------

  it("blames the club's system, not the phone, when the club's system answered with an error", () => {
    const server = standingFailed(null, "server");
    const network = standingFailed(null, "network");
    expect(server).not.toBe(network);
    expect(server).toMatch(/answered with an error/i);
    expect(server).toMatch(/not your phone/i);
    expect(server).not.toMatch(/your phone can't reach/i);
    expect(network).toMatch(/your phone can't reach/i);
  });

  it("keeps the two apart when there is a cached copy too", () => {
    const cached = { body: "Your club opens its doors for any active member.", minutesAgo: 4 };
    expect(standingFailed(cached, "server")).not.toBe(standingFailed(cached, "network"));
    expect(standingFailed(cached, "server")).toMatch(/answered with an error/i);
    expect(standingFailed(cached, "server")).toContain(cached.body);
  });

  /**
   * The diagnostic row is where the wrong blame did the real damage: a 500 from the club
   * scored "This phone's line to the club ✗ Failed" in front of somebody whose phone was
   * fine.
   */
  it("does not fail the phone's own row when it was the club's system that failed", () => {
    const { rows, conclusion } = buildDiagnosis({ ...HEALTHY, connection: "server" as const });
    const connection = rows.find((r) => r.key === "connection")!;
    expect(connection.state).toBe("neutral");
    expect(connection.stateWord).not.toBe("Failed");
    expect(connection.value).not.toMatch(/not reaching the club/i);
    expect(conclusion).toMatch(/answered with an error/i);
    expect(conclusion).toMatch(/not your phone/i);
  });

  // --- D3: a check that does not apply, or is anomalous, is NEUTRAL ---------------------

  /**
   * Kayla, who has no membership row at all, scored six green ticks — including "an
   * active membership ✓ Passed" for a rule she is not held to and "nothing on file ✓
   * Passed" for a state the club would want to know about.
   */
  it("never ticks a membership the club has nothing on file for", () => {
    const { rows } = buildDiagnosis({ ...HEALTHY, membership: "none" as const, membership_detail: "none" });
    const membership = rows.find((r) => r.key === "membership")!;
    expect(membership.state).toBe("neutral");
    expect(membership.stateWord).toMatch(/unusual/i);
  });

  /** The policy row states the club's rule. It is not a check and may never read as one. */
  it("never ticks the rule row, which is a statement rather than a check", () => {
    for (const policy of ["active_member", "booking_window"] as const) {
      const { rows } = buildDiagnosis({ ...HEALTHY, policy });
      expect(rows.find((r) => r.key === "policy")!.state).toBe("neutral");
    }
  });

  it("never ticks a check that does not apply at this club", () => {
    const { rows } = buildDiagnosis({
      ...HEALTHY, policy: "active_member" as const, hasBooking: false, bookingStartsClock: null,
      doorWindowOpen: null, opensAtClock: null, opensInWords: null,
    });
    expect(rows.find((r) => r.key === "booking")!.state).toBe("neutral");
    expect(rows.find((r) => r.key === "window")!.state).toBe("neutral");
  });

  /**
   * The whole of Kayla's screen, in one probe: not one green tick may be claimed off a
   * rule she is not held to, and the conclusion has to mention what the club is missing.
   */
  it("gives a member with no membership on file no green tick for one", () => {
    const { rows, conclusion } = buildDiagnosis({
      ...HEALTHY, membership: "none" as const, membership_detail: "none",
      policy: "active_member" as const, hasBooking: false, bookingStartsClock: null,
      doorWindowOpen: null, opensAtClock: null, opensInWords: null,
    });
    const passed = rows.filter((r) => r.state === "passed");
    // Her code and her signal are the only two things on this screen she can be said to
    // have passed. Everything else is either the club's rule or a check this club does not apply.
    expect(passed.map((r) => r.key)).toEqual(["code", "connection"]);
    // The exact pairing the reviewer photographed: the words "an active membership" beside
    // a green tick, in front of somebody who has none. The words may stay — they state the
    // club's rule — but never as something this member is said to have passed.
    for (const row of rows) {
      if (row.value === "an active membership") expect(row.state).not.toBe("passed");
      if (row.value.startsWith("nothing on file")) expect(row.state).not.toBe("passed");
    }
    expect(conclusion).toMatch(/no membership on file/i);
  });

  it("carries a word for every state it can produce", () => {
    const shapes = [
      HEALTHY,
      { ...HEALTHY, membership: "none" as const, membership_detail: "none" },
      { ...HEALTHY, membership: "not_active" as const, membership_detail: "suspended" },
      { ...HEALTHY, connection: "server" as const },
      { ...HEALTHY, connection: "network" as const },
      { ...HEALTHY, doorWindowOpen: false },
      { ...HEALTHY, doorWindowOpen: null, opensAtClock: null, opensInWords: null },
      { ...HEALTHY, policy: "active_member" as const },
      { ...HEALTHY, codeSecondsLeft: 0 },
    ];
    for (const shape of shapes) {
      for (const row of buildDiagnosis(shape).rows) {
        expect(row.stateWord.length).toBeGreaterThan(3);
        expect(["passed", "neutral", "attention", "failed"]).toContain(row.state);
      }
    }
  });

  // --- D5: an expired code that cannot be renewed ---------------------------------------

  it("says a code that has run out cannot be renewed, and why", () => {
    const noSignal = codeExpiredDeadEnd("network", CONTACT);
    const serverDown = codeExpiredDeadEnd("server", CONTACT);
    expect(noSignal).toMatch(/run out/i);
    expect(noSignal).toMatch(/signal/i);
    expect(noSignal).not.toMatch(/refreshing/i);
    expect(serverDown).not.toBe(noSignal);
    expect(serverDown).toMatch(/answered with an error/i);
    expect(noSignal).toContain("021 555 0134");
  });

  // --- D9: the door section says it is still looking ------------------------------------

  it("has a sentence for a door read that has not landed yet", () => {
    expect(DOOR_SECTION_CHECKING).toMatch(/checking/i);
    // It must be true at a club with no door as well: this fires before the answer that
    // says whether there is a door at all.
    expect(DOOR_SECTION_CHECKING).toMatch(/whether/i);
  });

  // --- D7 / D12: the offline disclosure, in the member's voice ---------------------------

  /**
   * It read like an admin's note — "whichever rule is set above", "the first 48 by start
   * time" — to somebody standing outside a building. And its unnamed-door clause
   * contradicted the same member's own history, which showed releases at a door it called
   * unnamed.
   */
  it("states the offline half in the member's own terms", () => {
    const body = offlineDetailsBody(12);
    expect(body).toMatch(/\byou\b/i);
    expect(body).not.toMatch(/whichever rule is set above/i);
  });

  it("never calls a door one the club has not named, on any surface a member reads", () => {
    expect(UNNAMED_DOOR).toBe("a club door");
    for (const sentence of [...everySentence(), decisionStamp(null, "2026-09-19T06:04:00Z"), UNNAMED_DOOR]) {
      expect(sentence).not.toMatch(/hasn't named|has not named|unnamed/i);
    }
  });
});
