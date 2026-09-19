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
  contactMissingNotice,
  decisionStamp,
  describeDecision,
  describeStanding,
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

  const CONTACT = { phone: "021 555 0134", email: "info@crusaders.co.za" };
  const NO_CONTACT = { phone: null, email: null };

  /** Every sentence this module can produce, for the probes that must sweep all of them. */
  function everySentence(): string[] {
    const out: string[] = [
      ...Object.values(MEMBER_DOOR_REASON_LINES),
      ...Object.values(DIAGNOSIS_ROW_LABELS),
      STANDING_HEADING, STANDING_LOADING, OFFLINE_DETAILS_SUMMARY, offlineDetailsBody(),
      DIAGNOSIS_TRIGGER, DIAGNOSIS_HEADING, CONTACT_LEAD, contactMissingNotice(),
      HISTORY_TITLE, HISTORY_INTRO, HISTORY_P2_NOTICE, HISTORY_LOADING, HISTORY_FAILED,
      HISTORY_EMPTY, HISTORY_MORE_FAILED, HISTORY_OFFLINE_LINE,
      historyRetention(90), historyRetention(null),
      standingFailed(null), standingFailed({ body: "cached sentence", minutesAgo: 4 }),
      offlineWithCode({ fetchedAtClock: "06:02", minutesAgo: 7, kind: "booking" }),
      offlineWithCode({ fetchedAtClock: "06:02", minutesAgo: 7, kind: "ident" }),
      offlineNoCode(CONTACT), offlineNoCode(NO_CONTACT),
      offlineIdentDeadEnd(CONTACT), offlineIdentDeadEnd(NO_CONTACT),
    ];
    for (const reason of Object.keys(DOOR_REFUSAL_REASONS)) {
      for (const released of [true, false]) {
        for (const contact of [CONTACT, NO_CONTACT]) {
          const copy = describeDecision({ reason, released }, {
            countdown: "27m 12s", opensAtClock: "06:30", bookingStartsClock: "07:00", contact,
          });
          out.push(copy.headline, copy.body);
        }
      }
      for (const offline of [true, false]) {
        const row = { reason, released: reason === "ok", offline };
        out.push(historyChip(row).label, historyLine(row) ?? "");
      }
    }
    for (const policy of ["active_member", "booking_window"] as const) {
      for (const membership of ["active", "not_active", "none"] as const) {
        for (const booking of [null, { starts_at: "2026-09-19T17:00:00Z", door_opens_at: "2026-09-19T16:30:00Z", door_closes_at: "2026-09-19T18:05:00Z" }]) {
          out.push(describeStanding({ policy, membership, next_booking: booking }).body);
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
      const copy = describeDecision({ reason, released: reason === "ok" }, {
        countdown: null, opensAtClock: null, bookingStartsClock: null, contact: CONTACT,
      });
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
    const copy = describeDecision({ reason: "some_new_token", released: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, contact: CONTACT,
    });
    expect(copy.headline).not.toContain("some_new_token");
    expect(copy.body).not.toContain("some_new_token");
    expect(copy.body.length).toBeGreaterThan(0);
  });

  /** Contract W1.7b: `too_early` is a clock fact, not a fault. Info tone, never danger. */
  it("gives too_early the info tone and a live countdown, never an error tone", () => {
    const copy = describeDecision({ reason: "too_early", released: false }, {
      countdown: "27m 12s", opensAtClock: "06:30", bookingStartsClock: "07:00", contact: CONTACT,
    });
    expect(copy.tone).toBe("info");
    expect(copy.headline).toContain("27m 12s");
    expect(copy.body).toContain("06:30");
    expect(copy.body).toMatch(/nothing is wrong with your code/i);
  });

  it("says the door opens now once the countdown has run out, and does not change tone", () => {
    const copy = describeDecision({ reason: "too_early", released: false }, {
      countdown: "0s", opensAtClock: "06:30", bookingStartsClock: "07:00", contact: CONTACT,
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
    const copy = describeDecision({ reason: "too_early", released: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, contact: CONTACT,
    });
    expect(copy.tone).toBe("info");
    expect(copy.headline).not.toMatch(/\d/);
    expect(copy.body).toMatch(/nothing is wrong with your code/i);
  });

  it("offers a court to book when the door wanted one", () => {
    const copy = describeDecision({ reason: "no_booking", released: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, contact: CONTACT,
    });
    expect(copy.actions).toContainEqual({ kind: "book_a_court", label: "Book a court" });
    expect(copy.tone).toBe("warning");
  });

  it("sends a member the club has as not active to the club, not to their own settings", () => {
    const copy = describeDecision({ reason: "member_not_active", released: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, contact: CONTACT,
    });
    expect(copy.tone).toBe("danger");
    expect(copy.actions).toContainEqual({ kind: "call_the_club", label: "Call the club", href: "tel:0215550134" });
    expect(copy.body).toMatch(/nothing you can fix on this phone/i);
  });

  /** Both halves: a club with an address and no number gets the other control. */
  it("offers email when the club gave no phone number", () => {
    const copy = describeDecision({ reason: "member_not_active", released: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null,
      contact: { phone: null, email: "info@crusaders.co.za" },
    });
    expect(copy.actions).toContainEqual({
      kind: "email_the_club", label: "Email the club", href: "mailto:info@crusaders.co.za",
    });
  });

  it("offers neither, and says so, when the club gave no way to reach it", () => {
    const copy = describeDecision({ reason: "member_not_active", released: false }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, contact: NO_CONTACT,
    });
    expect(copy.actions).toEqual([]);
    expect(contactMissingNotice()).toMatch(/written on the door/i);
  });

  /**
   * P2, on the one arm where it is easiest to break. The board reported releasing a
   * lock. It did not report that a door moved, and it cannot: there is no sensor on it.
   */
  it("says the lock released, and never that the door opened or that anyone went in", () => {
    const copy = describeDecision({ reason: "ok", released: true }, {
      countdown: null, opensAtClock: null, bookingStartsClock: null, contact: CONTACT,
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
    const line = describeStanding({ policy: "active_member", membership: "active", next_booking: null });
    expect(line.body).toMatch(/any active member/i);
    expect(line.body).not.toMatch(/\d{2}:\d{2}/);
    expect(line.hasClockWindow).toBe(false);
  });

  it("states both halves when the club has the membership as not active", () => {
    for (const policy of ["active_member", "booking_window"] as const) {
      const line = describeStanding({ policy, membership: "not_active", next_booking: null });
      expect(line.body).toMatch(/not active/i);
      expect(line.body).toMatch(/until they change that/i);
    }
  });

  it("names the booking and the door's window under the booking-window rule", () => {
    const line = describeStanding({
      policy: "booking_window", membership: "active",
      next_booking: { starts_at: "2026-09-19T17:00:00Z", door_opens_at: "2026-09-19T16:30:00Z", door_closes_at: "2026-09-19T18:05:00Z" },
    });
    expect(line.body).toMatch(/a court booked/i);
    expect(line.body).toMatch(/\d{2}:\d{2}/);
    expect(line.hasClockWindow).toBe(true);
  });

  it("offers a court to book when the booking-window rule has nothing to work with", () => {
    const line = describeStanding({ policy: "booking_window", membership: "active", next_booking: null });
    expect(line.action).toEqual({ kind: "book_a_court", label: "Book a court" });
    expect(line.hasClockWindow).toBe(false);
  });

  /**
   * The wave-1 wire shape may send a booking with no door window on it. The sentence has
   * to survive that without inventing the missing half — and without claiming a window.
   */
  it("does not claim a clock window the server did not send", () => {
    const line = describeStanding({
      policy: "booking_window", membership: "active",
      next_booking: { starts_at: "2026-09-19T17:00:00Z", door_opens_at: null, door_closes_at: null },
    });
    expect(line.hasClockWindow).toBe(false);
    expect(line.body).toMatch(/hasn't told this screen/i);
  });

  it("says it cannot check, and what it last heard, when the read failed", () => {
    const withCache = standingFailed({ body: "Your club opens its doors for any active member.", minutesAgo: 4 });
    expect(withCache).toMatch(/can't reach the club/i);
    expect(withCache).toContain("Your club opens its doors for any active member.");
    expect(withCache).toMatch(/4 minutes ago/);
    expect(withCache).toMatch(/may have changed/i);
  });

  /** Three silences, three sentences: no cache is not the same sentence as a stale one. */
  it("says something different when there is no cached copy at all", () => {
    const withCache = standingFailed({ body: "anything", minutesAgo: 4 });
    const without = standingFailed(null);
    expect(without).not.toBe(withCache);
    expect(without).toMatch(/can't reach the club/i);
    expect(without).not.toMatch(/ago/);
  });

  // --- the offline half of the conditional (P6) -----------------------------------

  it("states what an offline door can and cannot do, with the roster cap it is given", () => {
    const body = offlineDetailsBody();
    expect(body).toContain(String(GATE_ROSTER_MAX_ENTRIES));
    expect(body).toMatch(/bookings/i);
    // The unnamed-door half, which is the one that is easiest to leave out.
    expect(body).toMatch(/hasn't named/i);
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
    policy: "booking_window" as const,
    hasBooking: true,
    bookingStartsClock: "19:00",
    doorWindowOpen: true,
    opensAtClock: "18:30",
    opensInWords: "27 minutes",
    codeSecondsLeft: 58,
    connectionOk: true,
    contact: CONTACT,
  };

  it("asks six questions, each with its state in words as well as in colour", () => {
    const { rows } = buildDiagnosis(HEALTHY);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(["Passed", "Needs attention", "Failed"]).toContain(row.stateWord);
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
      { ...HEALTHY, membership: "not_active" as const },
      { ...HEALTHY, membership: "none" as const },
      { ...HEALTHY, connectionOk: false },
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
    const { conclusion } = buildDiagnosis({ ...HEALTHY, membership: "not_active", connectionOk: false, codeSecondsLeft: 0 });
    expect(conclusion).toMatch(/membership/i);
    expect(conclusion).not.toMatch(/had run out/i);
  });

  it("says the check is guessing when the phone could not reach the club", () => {
    const { conclusion, rows } = buildDiagnosis({ ...HEALTHY, connectionOk: false });
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
});
