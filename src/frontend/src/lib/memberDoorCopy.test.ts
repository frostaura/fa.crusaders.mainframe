import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BANNED_IN_MEMBER_DOOR_COPY,
  CONTACT_LEAD,
  DIAGNOSIS_HEADING,
  DIAGNOSIS_ROW_LABELS,
  DIAGNOSIS_TRIGGER,
  HISTORY_DELIVERY_ORDER,
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
  TIME_UNCERTAIN_NOTE,
  UNNAMED_DOOR,
  CLUB_TIME_NOTE,
  DOOR_SECTION_UNKNOWN,
  asOfMayHaveChanged,
  buildDiagnosis,
  decisionAge,
  sentenceText,
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
  historyGroupLabel,
  historyLine,
  timeIsUncertain,
  historyOfflineLine,
  historyRetention,
  offlineDetailsBody,
  standingFailed,
} from "./memberDoorCopy";
import { memberCodeOpensDoorNow, normaliseDoorsShut } from "./memberDoorCopy";
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
   * The code on screen. D1: there is one shape now — the member's single rotating code —
   * so the axis is that code or nothing drawn at all.
   */
  const MEMBER_CODE = { kind: "member" as const };

  /** A {@link Sentence} as the one string a reader sees — what every copy probe reads. */
  const flat = sentenceText;

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
  function standingFor(
    overrides: Record<string, unknown> = {},
    code: Parameters<typeof describeStanding>[1] = null,
  ) {
    return describeStanding({
      policy: "active_member",
      membership: "active",
      membership_detail: "active",
      is_club_admin: false,
      early_entry_minutes: 30,
      next_booking: null,
      // WIRE-R2 §4. `none` by default: a club that has shut a door has DONE something, and
      // the default fixture should not quietly describe a club in that state.
      doors_shut: "none",
      timezone: "Africa/Johannesburg",
      ...overrides,
    } as Parameters<typeof describeStanding>[0], code);
  }

  /**
   * Every sentence this module can produce, for the probes that must sweep all of them.
   *
   * <p>
   * Memoised, and that is not premature optimisation. The sweep is a product of eight axes
   * — policy, membership, detail, admin, early entry, booking, `doors_shut`, code on screen
   * — and the ban list alone asks for the whole of it fifteen times, once per banned
   * substring. Recomputed each time, it pushed single `it.each` cases past vitest's
   * five-second budget whenever the machine was busy with another file, which reads as a
   * flake rather than as an expensive fixture and gets somebody to add a retry.
   * </p>
   */
  let sentences: string[] | null = null;
  function everySentence(): string[] {
    return (sentences ??= buildEverySentence());
  }

  /**
   * The same list, lowercased once.
   *
   * <p>
   * The ban sweep is fifteen cases over fifty thousand sentences, and lowercasing each
   * sentence inside each case is three quarters of a million string allocations that
   * produce the same fifty thousand results every time. Measured: 2.5 s for the first case
   * and half a second for each of the fourteen after it, which on a busy machine is enough
   * to push a NEIGHBOURING file's test past vitest's five-second budget — a failure that
   * points at innocent code and reads as a flake.
   * </p>
   */
  let lowered: string[] | null = null;
  function everySentenceLowercased(): string[] {
    return (lowered ??= everySentence().map((sentence) => sentence.toLowerCase()));
  }

  function buildEverySentence(): string[] {
    const out: string[] = [
      ...Object.values(MEMBER_DOOR_REASON_LINES),
      ...Object.values(DIAGNOSIS_ROW_LABELS),
      STANDING_HEADING, STANDING_LOADING, OFFLINE_DETAILS_SUMMARY, offlineDetailsBody(),
      DIAGNOSIS_TRIGGER, DIAGNOSIS_HEADING, CONTACT_LEAD, contactMissingNotice(),
      contactUnknownNotice(), DOOR_SECTION_CHECKING,
      DOOR_SECTION_UNKNOWN, CLUB_TIME_NOTE,
      // R3-17, R3-30, R3-31: every sentence this round added, swept like every other.
      TIME_UNCERTAIN_NOTE,
      historyGroupLabel(6, 1), historyGroupLabel(2, 47),
      historyOfflineLine("2026-09-19T06:09:00Z", undefined, "2026-09-19T06:30:00Z"),
      asOfMayHaveChanged("09:46"), decisionAge(0), decisionAge(1), decisionAge(12),
      HISTORY_TITLE, HISTORY_INTRO, HISTORY_P2_NOTICE, HISTORY_LOADING, HISTORY_FAILED,
      HISTORY_EMPTY, HISTORY_MORE_FAILED, HISTORY_OFFLINE_LINE, HISTORY_DELIVERY_ORDER,
      historyOfflineLine("2026-09-19T06:09:00Z"), historyOfflineLine(null),
      decisionStamp("front-door", "2026-09-19T06:04:00Z", "2026-09-19T06:09:00Z"),
      historyRetention(90), historyRetention(null),
      standingFailed(null, "network"), standingFailed(null, "server"),
      standingFailed({ body: "cached sentence", minutesAgo: 4 }, "network"),
      standingFailed({ body: "cached sentence", minutesAgo: 4 }, "server"),
    ];
    // The reason axis includes `null`, which the endpoint returns for a non-release row
    // whose details would not parse, and the offline axis forks the open.
    for (const reason of [...Object.keys(DOOR_REFUSAL_REASONS), null, "some_new_token"]) {
      for (const released of [true, false]) {
        for (const offline of [true, false]) {
          for (const contact of [CONTACT, NO_CONTACT]) {
            for (const earlyEntryMinutes of [0, 30, 240, null]) {
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
        // Three details rather than six, and three early-entry numbers rather than six.
        // Both axes change exactly one word of one arm — `MEMBERSHIP_DETAIL_WORDS` and
        // `formatWindowMinutes` — and each has its own one-field probe further down; what
        // the cross-product buys here is the fallback arm firing beside every other axis,
        // which a representative three do. The full product was 15,552 standing lines per
        // call and it is what made this file expensive enough to starve its neighbours.
        for (const detail of ["active", "suspended", "lapsed_with_grace"]) {
          for (const is_club_admin of [true, false]) {
            // `null` is E-H3's shape: no early-entry window in force under this policy.
            for (const early_entry_minutes of [0, 90, null]) {
              for (const next_booking of [null, BOOKING]) {
                // B4 / E-H1 and E-H2 (1): both new axes, swept like every other, because a
                // sentence that only exists for a shut door is still a sentence this module
                // can build and the ban list has to reach it.
                for (const doors_shut of ["none", "some", "all"] as const) {
                  for (const code of [null, MEMBER_CODE]) {
                    const line = standingFor({
                      policy, membership, membership_detail: detail,
                      is_club_admin, early_entry_minutes, next_booking, doors_shut,
                    }, code);
                    out.push(line.body, line.codeLine ?? "", line.shutLine ?? "");
                  }
                }
              }
            }
          }
        }
      }
    }
    // Every conclusion the self-check can reach, including the new refusal-led arm.
    for (const shape of everyDiagnosis()) {
      const built = buildDiagnosis(shape);
      out.push(flat(built.conclusion), ...built.rows.map((r) => `${r.label} ${r.value} ${r.stateWord}`));
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
    const needle = banned.toLowerCase();
    // `find` then one assertion, rather than an assertion per sentence: fifty thousand
    // passing `expect` calls cost more than the sweep itself, and the one that matters —
    // the sentence that broke the rule — is named either way.
    const offender = everySentenceLowercased().find((sentence) => sentence.includes(needle));
    expect(offender, `a sentence this module can build says "${banned}"`).toBeUndefined();
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
   * Same keys, because the member and the admin are looking at the same eight decisions
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
      // Ruling 15 removed the no-membership arm from this list: a door does NOT still open
      // for somebody the club has no record of, so the clause has nothing to describe.
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

  // --- the self-diagnosis ----------------------------------------------------------

  const HEALTHY = {
    standingKnown: true,
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
    // E-H2, at their silent defaults: the member code not (yet) on screen, and nothing in
    // the club's record.
    holdingCode: false,
    lastRefusal: null,
  };

  /** Every shape the self-check can be handed, for the sweeps that must reach all of them. */
  function everyDiagnosis(): Parameters<typeof buildDiagnosis>[0][] {
    const base = [
      HEALTHY,
      { ...HEALTHY, membership: "not_active" as const, membership_detail: "suspended" },
      { ...HEALTHY, membership: "none" as const, membership_detail: "none" },
      { ...HEALTHY, connection: "network" as const },
      { ...HEALTHY, connection: "server" as const },
      { ...HEALTHY, standingKnown: false },
      { ...HEALTHY, hasBooking: false, bookingStartsClock: null, doorWindowOpen: null, opensAtClock: null, opensInWords: null },
      { ...HEALTHY, doorWindowOpen: false },
      { ...HEALTHY, codeSecondsLeft: 0 },
      { ...HEALTHY, policy: "active_member" as const, holdingCode: true },
      { ...HEALTHY, contact: NO_CONTACT },
      { ...HEALTHY, contact: UNKNOWN_CONTACT },
    ];
    const out: Parameters<typeof buildDiagnosis>[0][] = [];
    for (const shape of base) {
      for (const lastRefusal of [null, ...REFUSALS]) {
        for (const holdingCode of [true, false]) {
          out.push({ ...shape, lastRefusal, holdingCode });
        }
      }
    }
    /*
      R3-5 and R3-6 added two inputs, and the ban sweep has to reach the sentences they
      unlock — the shut-door conclusion and the already-holding-it arm. APPENDED rather than
      multiplied into the product above, for the reason this file already learned once: the
      product is asked for fifteen times by the ban sweep alone, and multiplying it by eight
      pushed a single `it.each` case past vitest's five-second budget whenever the machine
      was busy with another file. Neither axis interacts with `lastRefusal`
      in any arm, so the cross-product buys nothing the base shapes do not.
    */
    for (const shape of base) {
      for (const doorsShut of ["none", "some", "all", "unknown"] as const) {
        for (const memberCodeOpensDoor of [true, false]) {
          out.push({
            ...shape, doorsShut, memberCodeOpensDoor,
            doorsShutNames: doorsShut === "some" ? ["Front door"] : undefined,
            // One refusal beside them, so the arm that tells a member already holding the
            // member code that the refused one was a booking code is reached rather than
            // merely constructed.
            lastRefusal: { atClock: "09:46", reason: "too_early" },
            holdingCode: true,
          });
        }
      }
    }
    return out;
  }

  /** Including a token this build has never heard of, and a row with no reason at all. */
  const REFUSALS = [...Object.keys(DOOR_REFUSAL_REASONS), null, "some_new_token"]
    .map((reason) => ({ atClock: "09:46", reason }));

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
    expect(flat(conclusion)).toMatch(/at the door/i);
    expect(flat(conclusion)).toContain("021 555 0134");
    expect(flat(conclusion)).not.toMatch(/no refusal|nothing to show|no recent|nothing found/i);
    // D13 — and the number in it is a link, not text somebody has to re-type in the dark.
    expect(conclusion.link).toEqual({ href: "tel:0215550134", text: "021 555 0134" });
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
    for (const shape of [...shapes, ...everyDiagnosis()]) {
      const { conclusion, rows } = buildDiagnosis(shape);
      expect(flat(conclusion).length).toBeGreaterThan(20);
      expect(rows).toHaveLength(6);
    }
  });

  /** First failing row wins, so the member is given ONE thing to do rather than five. */
  it("names the membership and nothing else when the membership is the first failure", () => {
    const { conclusion } = buildDiagnosis({ ...HEALTHY, membership: "not_active" as const, membership_detail: "pending_approval", connection: "network" as const, codeSecondsLeft: 0 });
    expect(flat(conclusion)).toMatch(/membership/i);
    expect(flat(conclusion)).not.toMatch(/had run out/i);
  });

  it("says the check is guessing when the phone could not reach the club", () => {
    const { conclusion, rows } = buildDiagnosis({ ...HEALTHY, connection: "network" as const });
    expect(flat(conclusion)).toMatch(/guessing/i);
    const connection = rows.find((r) => r.key === "connection")!;
    expect(connection.stateWord).toBe("Failed");
  });

  it("sends a member with no booking to book one under the booking-window rule", () => {
    const { conclusion } = buildDiagnosis({
      ...HEALTHY, hasBooking: false, bookingStartsClock: null, doorWindowOpen: null, opensAtClock: null, opensInWords: null,
    });
    expect(flat(conclusion)).toMatch(/book/i);
  });

  it("tells a member whose window has not opened to wait, and says when", () => {
    const { conclusion } = buildDiagnosis({ ...HEALTHY, doorWindowOpen: false });
    expect(flat(conclusion)).toContain("18:30");
    expect(flat(conclusion)).toContain("27 minutes");
    expect(flat(conclusion)).toMatch(/everything else/i);
  });

  /**
   * R10: in words — the row is read as a sentence, eye and ear alike. "fresh, 900s left" and the
   * ticking "fresh, 15m 00s left" were both a figure where a sentence stands.
   */
  it("R10 says how long a code has left in spoken minutes, not raw seconds or a ticking figure", () => {
    const code = (s: number) => buildDiagnosis({ ...HEALTHY, codeSecondsLeft: s }).rows.find((r) => r.key === "code")!.value;
    expect(code(900)).toBe("fresh, 15 minutes left");
    expect(code(14 * 60 + 32)).toBe("fresh, 14 minutes left");
    expect(code(45)).toBe("fresh, less than a minute left");
    expect(code(900)).not.toMatch(/\d+\s*(m|s|min)\b/);
  });

  it("tells a member whose code had run out that there is a fresh one", () => {
    const { conclusion } = buildDiagnosis({ ...HEALTHY, codeSecondsLeft: 0 });
    expect(flat(conclusion)).toMatch(/run out/i);
    expect(flat(conclusion)).toMatch(/fresh one/i);
  });

  /** The trigger is the member's own sentence, not a support-desk word. */
  it("labels its trigger in the member's words", () => {
    expect(DIAGNOSIS_TRIGGER).toBe("The door didn't open");
    expect(DIAGNOSIS_TRIGGER).not.toMatch(/help|troubleshoot|diagnos/i);
  });

  // --- the history card -------------------------------------------------------------

  /**
   * R10 E10-4: the gate's `code_used` reads in the club's "code already used" family — a chip
   * and a line on the member's own history, never a muted "Turned away" with nothing under it.
   */
  it("R10 words a code_used refusal as a code already used, with a line and a way on", () => {
    const row = { reason: "code_used", released: false, offline: false };
    expect(historyChip(row)).toEqual({ label: "Code already used", tone: "warning" });
    expect(historyLine(row)).toMatch(/already been used/);
    const card = describeDecision(row, DECIDED);
    expect(card.headline).toMatch(/already been used/);
    expect(JSON.stringify(card)).not.toContain("code_used");
  });

  /** R11 D11-2: the member's own history words an offline refusal of their genuine code. */
  it("R11 words a refused_offline row as refused offline, with a line and a way on", () => {
    const row = { reason: "refused_offline", released: false, offline: true };
    expect(historyChip(row)).toEqual({ label: "Refused offline", tone: "warning" });
    // The server sends these with offline: true, so the line is the offline row's own.
    expect(historyLine(row)).toMatch(/couldn't reach the club/);
    const card = describeDecision(row, DECIDED);
    expect(card.headline).toMatch(/offline/);
    expect(JSON.stringify(card)).not.toContain("refused_offline");
  });

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
  /**
   * <b>R3-5 changed the second half of this.</b> It used to assert the promise —
   * "A live member code of yours opens the club door" — directly after telling her the club
   * has no record of her and that it is worth putting right, and the two read as the screen
   * arguing with itself. The mechanism is unchanged and is still stated; what the sentence
   * no longer does is finish on a promise as though the records were in order.
   */
  /**
   * Ruling 15. R3-5's finding — that this member must not be told her membership is "not
   * active" — still holds, because there is nothing to reactivate. What changed is the
   * consequence: `GateAccess` used to walk past the membership check for a user with no row,
   * and the backend now refuses her with her own reason. So the sentence names the difference
   * from a membership the club has switched OFF, and states the refusal rather than denying
   * one.
   */
  it("tells a member with no membership row that there is no record, not that theirs is off", () => {
    const line = standingFor({ policy: "active_member", membership: "none", membership_detail: "none" });
    expect(line.body).not.toMatch(/not active|until they change that/i);
    expect(line.body).toMatch(/not the same as one it has turned off/i);
    expect(line.body).toMatch(/no code of yours opens a door/i);
    // R3-5's other half: never the bare promise, and now never any promise at all.
    expect(line.body).not.toMatch(/live member code of yours opens/i);
    expect(line.suppressesCodeClause).toBe(true);
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
      buildDiagnosis({ ...HEALTHY, contact: UNKNOWN_CONTACT }).conclusion,
    ];
    for (const sentence of shapes) {
      expect(flat(sentence)).not.toMatch(/only way from here/i);
      expect(flat(sentence)).not.toMatch(/hasn't given the app a number/i);
      // And nothing to press, because there is nothing behind it. A dead `tel:` in the
      // dark is worse than no link at all — the same rule `contactAction` follows.
      expect(sentence.link).toBeNull();
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
    expect(flat(conclusion)).toMatch(/answered with an error/i);
    expect(flat(conclusion)).toMatch(/not your phone/i);
  });

  // --- D3: a check that does not apply, or is anomalous, is NEUTRAL ---------------------

  /**
   * Kayla, who has no membership row at all, scored six green ticks — including "an
   * active membership ✓ Passed" for a rule she is not held to and "nothing on file ✓
   * Passed" for a state the club would want to know about.
   */
  /**
   * <b>R3-5: neutral was still the wrong shade.</b> Neutral draws the same grey dash as
   * "not needed at this club", and the only thing separating the two was a state word that
   * is `sr-only` — so a sighted member scanning the column saw a row that looked like the
   * rows meaning "fine, does not apply here". It is `attention` now: its own glyph, its own
   * colour, and the same word.
   */
  /**
   * Ruling 15 turns this row from `attention` into a failure. It read "nothing on file, and
   * nothing barring you", which was true only while the door walked past the check; with the
   * hole closed, the absence of the record IS what is barring her, and a checklist that ticks
   * past the actual answer is worse than no checklist.
   */
  it("fails a membership the club has nothing on file for, and says who fixes it", () => {
    const { rows } = buildDiagnosis({ ...HEALTHY, membership: "none" as const, membership_detail: "none" });
    const membership = rows.find((r) => r.key === "membership")!;
    expect(membership.state).toBe("failed");
    expect(membership.value).toMatch(/the club has to add you/i);
    // Not the grey n/a dash the two "does not apply here" rows draw.
    const notApplicable = rows.filter((r) => r.state === "neutral").map((r) => r.key);
    expect(notApplicable).not.toContain("membership");
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
    expect(flat(conclusion)).toMatch(/no membership on file/i);
  });

  /**
   * The same member, on the screen the reviewer actually photographed: Kayla was holding a
   * BOOKING code outside its window, so E-H2's code-window arm won the conclusion — and the
   * club's missing row, which hung off the all-clear arm alone, vanished with it. The
   * anomaly is a tail on whichever arm wins, so no future reordering can drop it again.
   */
  it("still names a missing membership when another arm wins the conclusion", () => {
    const shapes = [
      // D1 removed the code-window arm that was Kayla's (no booking code is ever on screen
      // now); the rule survives on the arms that can still win.
      // The club's own rule.
      { policy: "booking_window" as const, hasBooking: false, bookingStartsClock: null },
      // And a read that failed on a page holding the club's answer from a moment ago.
      { connection: "network" as const },
    ];
    for (const shape of shapes) {
      const { conclusion } = buildDiagnosis({
        ...HEALTHY, membership: "none" as const, membership_detail: "none", ...shape,
      });
      expect(flat(conclusion)).toMatch(/no membership on file/i);
    }
  });

  /**
   * And never on a guess. "None" arrives through the same field whether the club said so or
   * nobody asked, and telling a member the club has nothing on file for them on the strength
   * of a read that never landed is an invention with the club's name on it.
   */
  it("never claims the club has nothing on file when the club never answered", () => {
    const { conclusion } = buildDiagnosis({
      ...HEALTHY, membership: "none" as const, membership_detail: "none",
      standingKnown: false, connection: "network" as const,
    });
    expect(flat(conclusion)).not.toMatch(/no membership on file/i);
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

  // --- the LOW finding: a checklist that contradicts itself under a failed read ---------

  /**
   * With no `/me/door` at all — failed on a cold start, nothing cached — the page
   * defaulted the membership to `active` and the policy to `active_member` so the
   * connection row would win the conclusion. That is right about the conclusion and wrong
   * about the rows: it printed "Your membership — active ✓ Passed" directly above "This
   * phone's line to the club — ✗ Failed", in front of somebody trying to work out what
   * went wrong.
   */
  it("answers nothing it could not ask about, and says which rows those are", () => {
    const { rows, conclusion } = buildDiagnosis({
      ...HEALTHY, standingKnown: false, connection: "network" as const,
    });
    for (const key of ["membership", "policy", "booking", "window"] as const) {
      const unknown = rows.find((r) => r.key === key)!;
      expect(unknown.state).toBe("neutral");
      expect(unknown.stateWord).toBe("Couldn't check");
    }
    // The two the page can answer for itself, whatever the club said, still answer.
    expect(rows.find((r) => r.key === "code")!.state).toBe("passed");
    expect(rows.find((r) => r.key === "connection")!.state).toBe("failed");
    expect(flat(conclusion)).toMatch(/unanswered rather than fine/i);
  });

  it("still asks all six, so a row is never silently dropped", () => {
    const { rows } = buildDiagnosis({ ...HEALTHY, standingKnown: false, connection: "server" as const });
    expect(rows.map((r) => r.key)).toEqual(["membership", "policy", "booking", "window", "code", "connection"]);
  });

  // --- WIRE-R1 §2 / §8: the second instant, and only where it exists ----------------------

  it("names the instant the club heard, on a row a cut-off door decided alone", () => {
    const stamp = decisionStamp("front-door", "2026-09-19T06:04:00Z", "2026-09-19T06:09:00Z");
    expect(stamp).toMatch(/^front-door · \d{2}:\d{2} · the club heard at \d{2}:\d{2}$/);
    // The two instants are different times, and the sentence has to carry both.
    const [scan, heard] = stamp.match(/\d{2}:\d{2}/g)!;
    expect(scan).not.toBe(heard);
  });

  /** A delivery time on a row that never took that journey is a delay that did not happen. */
  it("prints no delivery clause when there was nothing to deliver", () => {
    expect(decisionStamp("front-door", "2026-09-19T06:04:00Z", null))
      .toMatch(/^front-door · \d{2}:\d{2}$/);
    expect(decisionStamp("front-door", "2026-09-19T06:04:00Z")).not.toMatch(/heard/);
  });

  it("does the same on a history row's own line", () => {
    expect(historyOfflineLine("2026-09-19T06:09:00Z")).toMatch(/The club heard at \d{2}:\d{2}\./);
    expect(historyOfflineLine(null)).toBe(HISTORY_OFFLINE_LINE);
    expect(historyOfflineLine(null)).not.toMatch(/heard/);
  });

  it("reads the delivery instant off the row rather than off the offline flag alone", () => {
    const withTime = historyLine({ reason: "ok", released: true, offline: true, delivered_at: "2026-09-19T06:09:00Z" });
    const without = historyLine({ reason: "ok", released: true, offline: true, delivered_at: null });
    expect(withTime).not.toBe(without);
    expect(without).toBe(HISTORY_OFFLINE_LINE);
  });

  /**
   * The list is ordered and paged on the DELIVERY axis, so an offline row's own time can
   * run backwards against its neighbours. A member who is not told that reads their own
   * record as wrong.
   */
  it("explains why a row can sit below one that happened after it", () => {
    expect(HISTORY_DELIVERY_ORDER).toMatch(/when the club heard/i);
    expect(HISTORY_DELIVERY_ORDER).toMatch(/below/i);
    // Member voice, like every other sentence here: about the rows, never about a cursor,
    // an axis or a page.
    expect(HISTORY_DELIVERY_ORDER).not.toMatch(/cursor|axis|paged|sorted by/i);
  });

  /**
   * The standing line is about the club's RULE and this member's standing. Pointing at
   * "the code on this screen" makes it a claim about whatever is rendered ten pixels above
   * — and when that code has run out and been replaced by a dead state, the two contradict
   * each other outright. Photographed on the expired screen during the visual pass.
   */
  it("never points at whatever code happens to be on screen", () => {
    for (const membership of ["active", "none"] as const) {
      const line = standingFor({ policy: "active_member", membership, membership_detail: membership });
      expect(line.body).not.toMatch(/code on this screen/i);
    }
    // The promise is still made where it is true: an active member at a club that opens for
    // one, with nothing shut and a live code in hand. R3-5 removed it from the `none` arm
    // alone — see the test above — and the two arms are asserted apart rather than together,
    // because "both arms say the same thing" was the defect.
    expect(standingFor({ policy: "active_member", membership: "active" }).body)
      .toMatch(/live member code of yours/i);
  });

  it("says nothing about a window when the member code is the one on screen", () => {
    const line = standingFor({}, MEMBER_CODE);
    expect(line.codeLine).toBeNull();
  });

  /**
   * The LOW note. `next_booking` reaches past the door's horizon now (WIRE-R2 §4), so a
   * member with a court tomorrow can be told when its code starts working — which is the
   * question they were left with and had no way to answer.
   */
  it("tells a member at an any-active-member club when their next booking opens a door", () => {
    const line = standingFor({ next_booking: BOOKING });
    expect(line.codeLine).toMatch(/court/i);
    expect(line.codeLine).toMatch(/door window opens at/i);
  });

  // --- B4 / E-H1: the club has shut its doors ---------------------------------------

  /**
   * <b>The sentence B4 found: "a live code of yours opens the club door", shown while the
   * club's only usable door was shut.</b> `doors` means "this club has scanners" now, so
   * the page no longer goes silent — which makes it this module's job to say the true
   * thing instead of the reassuring one.
   */
  it.each(["some", "all"] as const)("never promises a door opens when %s of them are shut", (doors_shut) => {
    for (const policy of ["active_member", "booking_window"] as const) {
      for (const next_booking of [null, BOOKING]) {
        for (const is_club_admin of [true, false]) {
          const line = standingFor({ doors_shut, policy, next_booking, is_club_admin });
          const whole = `${line.body} ${line.codeLine ?? ""} ${line.shutLine ?? ""}`;
          expect(whole).not.toMatch(/opens the club door|the door opens for you now/i);
          expect(line.shutLine).toMatch(/shut/i);
        }
      }
    }
  });

  /** Both halves, and nothing predicted about the half this screen cannot see. */
  it("states what a shut door does and declines to predict what a cut-off one will do", () => {
    const line = standingFor({ doors_shut: "all" });
    expect(line.shutLine).toMatch(/turns every code away/i);
    expect(line.shutLine).toMatch(/lost the network/i);
    expect(line.shutLine).toMatch(/can't see/i);
    // No count: the wire carries none, so the page invents none.
    expect(line.shutLine).not.toMatch(/[0-9]/);
  });

  it("tells them apart: some of the club's doors, or all of them", () => {
    expect(standingFor({ doors_shut: "some" }).shutLine).toMatch(/some of its doors/i);
    expect(standingFor({ doors_shut: "all" }).shutLine).not.toMatch(/some of its doors/i);
    expect(standingFor({ doors_shut: "none" }).shutLine).toBeNull();
  });

  /** And a shut door silences the code card's own promise, which is the other half of B4. */
  it("suppresses the code card's door clause while any door is shut", () => {
    expect(standingFor({ doors_shut: "some" }).suppressesCodeClause).toBe(true);
    expect(standingFor({ doors_shut: "all" }).suppressesCodeClause).toBe(true);
    expect(standingFor({ doors_shut: "none" }).suppressesCodeClause).toBe(false);
  });

  // --- E-H3: the early-entry number that belongs to one policy only -------------------

  /**
   * Under `active_member` a booking code's door window comes from the roster horizon, not
   * from early entry — so `early_entry_minutes` arrives null and no sentence may name a
   * number. The wordless arm was already there for a club that had set zero; this is the
   * same arm, reached by a different route.
   */
  it("names no early-entry window when the club's policy does not have one", () => {
    const line = standingFor({ policy: "booking_window", early_entry_minutes: null, next_booking: null });
    expect(line.body).toMatch(/soon enough for a door to open/i);
    expect(line.body).not.toMatch(/[0-9]+ minutes|[0-9]+ hour/);
  });

  it("still names it when the club's policy does have one", () => {
    const line = standingFor({ policy: "booking_window", early_entry_minutes: 90, next_booking: null });
    expect(line.body).toMatch(/in the next 1 hour 30 minutes/i);
  });

  // --- O1: one clock face, and it is the CLUB's day ----------------------------------

  /**
   * The runner is pinned to Africa/Johannesburg (`vite.config.ts`), which is also the club
   * under test's zone — so a clock assertion against the default fixture proves nothing
   * about threading. Two hours behind is what makes the difference visible.
   */
  it("writes a booking's window in the club's own day, not the reader's", () => {
    // A booking whose door window has NOT opened, so the sentence names `door_opens_at`
    // rather than the closing time — and far enough ahead that it cannot drift into the
    // past while the suite runs.
    const soon = {
      ...BOOKING,
      starts_at: "2099-01-01T17:00:00Z",
      ends_at: "2099-01-01T17:45:00Z",
      door_opens_at: "2099-01-01T16:30:00Z",
      door_closes_at: "2099-01-01T18:05:00Z",
    };
    const here = standingFor({ policy: "booking_window", next_booking: soon });
    const abroad = standingFor({ policy: "booking_window", next_booking: soon, timezone: "Europe/London" });
    // 16:30Z is 18:30 in Johannesburg and 16:30 in London on that January date.
    expect(here.body).toContain("18:30");
    expect(abroad.body).toContain("16:30");
    expect(abroad.body).not.toContain("18:30");
  });

  // --- E-H2 (2): the club's own record leads ------------------------------------------

  /**
   * <b>The Lerato conclusion: "Everything on this phone looks right, so whatever went wrong
   * is at the door", shown beside seventeen refusals the club had written down.</b> The
   * check never read the club's record, so the one line available to it that is not an
   * inference was the one line it did not have.
   */
  it("leads with the club's own record of a refusal rather than blaming the door", () => {
    const { conclusion } = buildDiagnosis({
      ...HEALTHY, lastRefusal: { atClock: "09:46", reason: "too_early" },
    });
    expect(flat(conclusion)).toMatch(/club's own record/i);
    expect(flat(conclusion)).toContain("09:46");
    expect(flat(conclusion)).toMatch(/the booking that code belonged to/i);
    expect(flat(conclusion)).not.toMatch(/whatever went wrong is at the door/i);
  });

  it("never concludes the fault is at the door while a refusal is on the club's record", () => {
    for (const refusal of REFUSALS) {
      const { conclusion } = buildDiagnosis({ ...HEALTHY, lastRefusal: refusal });
      expect(flat(conclusion)).not.toMatch(/whatever went wrong is at the door/i);
    }
  });

  /** A reason this build has never heard of still reaches a sentence, and never the token. */
  it("answers a recorded refusal whose reason it does not recognise", () => {
    const { conclusion } = buildDiagnosis({
      ...HEALTHY, lastRefusal: { atClock: "09:46", reason: "some_new_token" },
    });
    expect(flat(conclusion)).not.toContain("some_new_token");
    expect(flat(conclusion)).toMatch(/doesn't say why/i);
  });

  /** Membership still outranks it: a barred member's refusal has one cause and it is that. */
  it("puts a barred membership above the club's record of the refusal it caused", () => {
    const { conclusion } = buildDiagnosis({
      ...HEALTHY,
      membership: "not_active" as const,
      membership_detail: "suspended",
      lastRefusal: { atClock: "09:46", reason: "member_not_active" },
    });
    expect(flat(conclusion)).toMatch(/suspended/i);
  });

});

/**
 * The whole surface, in one table, held against itself. Round 3's central requirement.
 *
 * <p>
 * <b>Every finding this round was the same shape.</b> Not a sentence that was wrong on its
 * own, but two sentences that were each defensible and could not both be true of the member
 * reading them: "the club has shut some of its doors" over "a live member code of yours
 * opens the club door" (R3-4); "worth asking the club to put that right" over the same
 * promise (R3-5); "too early, the door opens for you in 9h 30m" over "your member code opens
 * the club door" (R3-6); a court window and a door window two hours apart, both introduced
 * as what this code does (R3-7); "this code has run out, there's nothing on this screen for
 * a door to read" over the promise again (R3-8). Five findings, one defect: nothing was
 * asking whether the page agreed with itself.
 * </p>
 *
 * <p>
 * So this sweeps the product of the five axes the member surfaces actually fork on — the
 * club's rule, what the club has on file, what the door last decided, which code is on the
 * glass, and whether there is signal, a live code and an open door — and holds the sentences
 * that state against every rule that can be written mechanically. It is a CONTRADICTION
 * probe rather than a spelling test: it does not care what any arm says, only that no two
 * arms say opposite things at once.
 * </p>
 *
 * <p>
 * The second half is the self-check, and the rule there is the one the reviewers kept
 * catching: <b>the conclusion has to follow from the rows above it.</b> A checklist that
 * fails a row and then concludes something else — or ticks six rows and then blames the
 * scanner — is worse than no checklist, because the member acts on the conclusion and the
 * rows are what they will be shown at the desk.
 * </p>
 */
describe("memberDoorCopy — no state contradicts itself", () => {
  const CONTACT = liveContact({ phone: "021 555 0134", email: "info@crusaders.co.za" });
  const flat = sentenceText;

  const BOOKING = {
    starts_at: "2026-09-19T17:00:00Z",
    ends_at: "2026-09-19T17:45:00Z",
    court_number: 3,
    door_opens_at: "2026-09-19T16:30:00Z",
    door_closes_at: "2026-09-19T18:05:00Z",
  };
  /** D1: the member's one rotating code on the glass, or nothing drawn yet. */
  const CODES = {
    member: { kind: "member" as const },
    none: null,
  };

  /** Every `doors_shut` the wire can carry — INCLUDING the one it can fail to. R3-4. */
  const SHUT_STATES = ["none", "some", "all", undefined] as const;
  /** Every decision the endpoint can put on the card, plus the two it cannot name. */
  const REASONS = [...Object.keys(DOOR_REFUSAL_REASONS), null, "some_new_token"];

  type State = {
    policy: "active_member" | "booking_window";
    membership: "active" | "not_active" | "none";
    reason: string | null;
    released: boolean;
    offline: boolean;
    codeKind: "member" | "none";
    shut: "none" | "some" | "all" | undefined;
    connection: "ok" | "network" | "server";
    liveCode: boolean;
    hasBooking: boolean;
  };

  function* everyState(): Generator<State> {
    for (const policy of ["active_member", "booking_window"] as const) {
      for (const membership of ["active", "not_active", "none"] as const) {
        for (const reason of REASONS) {
          for (const codeKind of ["member", "none"] as const) {
            // D1: a booking used to travel with the booking code on screen. That code is
            // gone, so the booking is its own axis — otherwise `booking_window` with a
            // booking, the state that rule turns on, would never be swept at all.
            for (const hasBooking of [true, false]) {
              for (const shut of SHUT_STATES) {
                for (const connection of ["ok", "network", "server"] as const) {
                  for (const liveCode of [true, false]) {
                    yield {
                      policy, membership, reason,
                      released: reason === "ok",
                      // The offline axis forks the OPEN only, so it is swept where it bites.
                      offline: reason === "ok" && !liveCode,
                      codeKind, shut, connection, liveCode, hasBooking,
                    };
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  /** Everything this state puts in front of the member, as plain strings. */
  function screenFor(state: State) {
    const door = {
      policy: state.policy,
      membership: state.membership,
      membership_detail: state.membership === "not_active" ? "suspended" : state.membership,
      is_club_admin: false,
      early_entry_minutes: state.policy === "booking_window" ? 30 : null,
      next_booking: state.hasBooking ? BOOKING : null,
      doors_shut: state.shut,
      doors_shut_names: state.shut === "some" ? ["Front door"] : undefined,
      timezone: "Africa/Johannesburg",
    } as Parameters<typeof describeStanding>[0];
    const code = CODES[state.codeKind];
    const standing = describeStanding(door, code, { hasLiveCode: state.liveCode });
    const memberCodeOpensDoor = memberCodeOpensDoorNow(door);
    const decision = describeDecision(
      { reason: state.reason, released: state.released, offline: state.offline },
      {
        countdown: "9h 30m", opensAtClock: "06:30", bookingStartsClock: "07:00",
        earlyEntryMinutes: door.early_entry_minutes, contact: CONTACT,
        memberCodeOpensDoor, holdingCode: code !== null,
      },
    );
    const diagnosis = buildDiagnosis({
      standingKnown: true,
      membership: state.membership,
      membership_detail: door.membership_detail,
      policy: state.policy,
      hasBooking: state.hasBooking,
      bookingStartsClock: state.hasBooking ? "19:00" : null,
      doorWindowOpen: state.hasBooking ? true : null,
      opensAtClock: state.hasBooking ? "18:30" : null,
      opensInWords: null,
      codeSecondsLeft: state.liveCode ? 58 : 0,
      connection: state.connection,
      contact: CONTACT,
      holdingCode: code !== null,
      lastRefusal: null,
      doorsShut: normaliseDoorsShut(state.shut),
      doorsShutNames: door.doors_shut_names,
      memberCodeOpensDoor,
    });
    return {
      standing,
      decision,
      diagnosis,
      /** Everything the door section and the decision card say, in one blob. */
      all: [
        standing.body, standing.codeLine ?? "", standing.shutLine ?? "",
        decision.headline, decision.body,
      ].join(" "),
    };
  }

  /**
   * Every state, with the screen it produces, built ONCE.
   *
   * <p>
   * <b>The lesson this file already carries, in a second place.</b> Eight rules sweep the
   * same {@link EVERY_STATE} states, and rebuilding the standing line, the decision card and the six-row
   * self-check inside each of them is eight times the work for one set of answers — enough,
   * measured, to push a rule past vitest's five-second budget whenever the machine is busy
   * with another file, which reads as a flake and gets somebody to add a retry. The screens
   * are pure functions of the state; there is nothing to rebuild.
   * </p>
   */
  /**
   * Headroom for the rules that sweep every state, measured rather than guessed.
   *
   * <p>
   * The whole product is built once (see below) and the rule that happens to run first pays
   * for it: measured at 1.8 s on an idle machine, and this repo's unit suite runs four
   * lanes' worth of files in parallel on one laptop. Vitest's default five seconds is under
   * three times the measured cost, which is not headroom — it is a test that passes alone
   * and fails in the suite, reads as a flake, and gets a retry added to it. Twenty is about
   * eleven times, and a rule that genuinely hangs still fails rather than running forever.
   * </p>
   */
  const SWEEP_MS = 20_000;

  /**
   * How many states this sweeps, asserted rather than written in prose.
   *
   * <p>
   * The prose said "4,752" and the product had been 3,888 for some time — a number in a
   * comment that nobody can run is a number that drifts the first time an axis moves, and
   * this one moved again when ruling 15 added an eighth door decision. Derived from the axes,
   * checked below, and quoted from here by the doc comments that used to hold a literal.
   * </p>
   */
  // D1 turned the three-way code axis (booking / ident / none) into two (member / none)
  // and split `hasBooking` out as its own two-way axis, so the code-and-booking factor went
  // from 3 to 2 × 2: 4,320 states became 5,760.
  const EVERY_STATE = 2 * 3 * REASONS.length * 2 * 2 * SHUT_STATES.length * 3 * 2;

  it("sweeps every combination of the axes, and says how many that is", () => {
    expect([...everyState()]).toHaveLength(EVERY_STATE);
  });

  let screens: { state: State; screen: ReturnType<typeof screenFor> }[] | null = null;
  function everyScreen() {
    return (screens ??= [...everyState()].map((state) => ({ state, screen: screenFor(state) })));
  }

  /** The one promise on this surface, and the only conditions under which it is true. */
  const PROMISE = /A live member code of yours opens the club door/;
  /**
  * Every way this surface says the member is not getting in, or may not be.
  *
  * <p>
  * <b>"Run out" is deliberately not here, and the first draft of this rule got it wrong.</b>
  * `armNotRecognised` says "A code that has run out and a code that was never real look the
  * same to a door… There's a fresh one below" — which is about the twelve characters that
  * were REFUSED, not about the ones on the glass, and it points at a replacement. The
  * contradiction R3-8 found is between the promise and the code card's own dead state, and
  * that is caught by the `liveCode` assertion above rather than by hunting for a phrase.
  * </p>
  */
  const WITHHOLDS = [
    /has shut (its|some of its) doors/,
    /no code of yours opens a door/,
    /a door won't open for you/,
    /nothing on this screen for a door/,
  ];

  /*
    One test over every state rather than one test PER state. `it.each` over a five-axis
    product is four and a half thousand named cases in the reporter for one rule, and the
    per-case overhead is most of the file's runtime — which is what starves a neighbouring
    file of vitest's five-second budget. The state is in the assertion message, so a failure
    still names the exact combination that broke the rule.
  */
  it("never promises and withdraws in the same breath", () => {
    for (const { state, screen } of everyScreen()) {
      const { all } = screen;
      if (!PROMISE.test(all)) continue;
      const where = JSON.stringify(state);
      // The promise is made. Every one of these is a reason it cannot be.
      expect(state.shut, `promised an open door while the club had shut some — ${where}`).toBe("none");
      expect(state.membership, `promised an open door to a member with no record — ${where}`).toBe("active");
      expect(state.policy, `promised an any-member open under the booking rule — ${where}`).toBe("active_member");
      expect(state.liveCode, `promised a live code on a screen that has none — ${where}`).toBe(true);
      for (const withhold of WITHHOLDS) {
        expect(all, `promised a door and withheld it (${withhold}) — ${where}`).not.toMatch(withhold);
      }
    }
  }, SWEEP_MS);

  /**
   * R3-4, as a rule rather than as a sentence: a field that never arrived is not a club that
   * has shut something. It is the defect that was on EVERY account's screen in the evidence,
   * and the one that produced the R3-5 and R3-8 contradictions as a side effect.
   */
  it("says nothing whatever about shut doors when the wire did not say", () => {
    for (const { state, screen } of everyScreen()) {
      if (state.shut !== undefined && state.shut !== "none") continue;
      const { all } = screen;
      expect(all, `invented a shut door from doors_shut=${state.shut}`).not.toMatch(/has shut/);
    }
  }, SWEEP_MS);

  /** And the other direction: a club that HAS shut doors is never silent about it. */
  it("always states a shut door the wire did report", () => {
    for (const { state, screen } of everyScreen()) {
      if (state.shut !== "some" && state.shut !== "all") continue;
      // The membership arms outrank everything and deliberately say nothing else — the club
      // has to move first, and a shut door is not what is standing in the way. Both of them:
      // a membership switched off, and (ruling 15) one that was never recorded.
      if (state.membership !== "active") continue;
      const { standing } = screen;
      expect(standing.shutLine, `silent about doors_shut=${state.shut}`).toMatch(/has shut/);
    }
  }, SWEEP_MS);

  /** WIRE-R3 §5: when the club says which, the page says which. */
  it("names the shut doors the wire named", () => {
    const { standing } = screenFor({
      policy: "active_member", membership: "active", reason: null, released: false, offline: false,
      codeKind: "member", shut: "some", connection: "ok", liveCode: true, hasBooking: false,
    });
    expect(standing.shutLine).toContain("Front door");
  });

  /**
   * R3-6. `too_early` is only ever a BOOKING code's refusal — `OutsideItsOwnWindowAsync` is
   * reached from the booking branch and nothing else — so at a club whose doors open for any
   * active member it says nothing about whether the member may come in. "Wait nine and a half
   * hours" over "your member code opens the door now" is two answers to one question.
   */
  it("never tells a member to wait out a window a code in their hand does not have", () => {
    for (const { state, screen } of everyScreen()) {
      if (state.reason !== "too_early") continue;
      const { all, decision } = screen;
      if (!/Too early — the door opens for you in/.test(decision.headline)) continue;
      expect(all, "told them to wait while promising the other code works")
        .not.toMatch(/member code .*opens the door now|do open — hold that one up/);
    }
  }, SWEEP_MS);

  it("names the booking code, and the way out of it, where the member code works", () => {
    const { decision } = screenFor({
      policy: "active_member", membership: "active", reason: "too_early", released: false,
      offline: false, codeKind: "member", shut: "none", connection: "ok", liveCode: true, hasBooking: false,
    });
    expect(decision.headline).toMatch(/That was your booking code/);
    // Already holding it: nothing to switch to, and saying so is the whole point.
    expect(decision.body).toMatch(/code on this screen now is your member code/);
    expect(decision.body).not.toMatch(/hold it up to the scanner again then/);
  });

  it("points at the member code when it is not on the glass yet", () => {
    const { decision } = screenFor({
      policy: "active_member", membership: "active", reason: "too_early", released: false,
      offline: false, codeKind: "none", shut: "none", connection: "ok", liveCode: true, hasBooking: true,
    });
    expect(decision.body).toMatch(/member code isn't tied to a booking and opens the door now/);
    expect(decision.body).toMatch(/it appears at the top of this screen/);
    expect(decision.body).not.toMatch(/code on this screen now is your member code/);
  });

  /** And it stays the old sentence where there genuinely is nothing better to hold. */
  it("keeps the plain wait where no code of theirs opens the door yet", () => {
    const { decision } = screenFor({
      policy: "booking_window", membership: "active", reason: "too_early", released: false,
      offline: false, codeKind: "member", shut: "none", connection: "ok", liveCode: true, hasBooking: true,
    });
    expect(decision.headline).toMatch(/Too early/);
    expect(decision.body).toMatch(/hold it up to the scanner again then/);
  });

  // --- the conclusion follows from the rows -------------------------------------------

  /** What each row's own failure has to look like in the sentence underneath the list. */
  const ROW_SUBJECT: Record<string, RegExp> = {
    membership: /membership/i,
    booking: /book/i,
    window: /window|opens for you/i,
    code: /code/i,
    connection: /reach the club|answered with an error/i,
  };

  it("never concludes the all-clear while a row has failed", () => {
    for (const { screen } of everyScreen()) {
      const { diagnosis } = screen;
      const failed = diagnosis.rows.filter((r) => r.state === "failed");
      if (failed.length === 0) continue;
      const text = flat(diagnosis.conclusion);
      expect(text, `all-clear over ${failed.map((r) => r.key)}`)
        .not.toMatch(/Everything on this phone looks right/);
      // A conclusion that DECLINES to answer is the third legitimate outcome and is not a
      // failure to follow from the rows: with the club unreachable, four of the six are
      // unasked rather than fine, and the check says exactly that instead of picking the
      // one row it could still see. What is banned is a confident answer about something
      // else while a row is red.
      if (/guessing about half of it|unanswered rather than fine/.test(text)) continue;
      expect(
        failed.some((r) => ROW_SUBJECT[r.key].test(text)),
        `conclusion "${text}" names none of the failing rows ${failed.map((r) => r.key)}`,
      ).toBe(true);
    }
  }, SWEEP_MS);

  /**
   * The other direction, and the one R3-5 was about: a conclusion may not assert a failure
   * the rows did not find. "The club has your membership as suspended" over a membership row
   * reading "active ✓ Passed" is the same defect pointing the other way.
   */
  it("never blames a row that passed", () => {
    for (const { screen } of everyScreen()) {
      const { diagnosis } = screen;
      const text = flat(diagnosis.conclusion);
      const by = Object.fromEntries(diagnosis.rows.map((r) => [r.key, r.state]));
      if (by.membership === "passed") {
        expect(text, "blamed a membership the check passed").not.toMatch(/has your membership as/i);
        expect(text, "blamed a membership the check passed").not.toMatch(/no membership on file/i);
      }
      if (by.code === "passed") {
        expect(text, "blamed a code the check passed").not.toMatch(/code you held up had run out/i);
      }
      if (by.connection === "passed") {
        expect(text, "blamed a phone whose line the check passed").not.toMatch(/phone can't reach the club/i);
      }
    }
  }, SWEEP_MS);

  /**
   * R3-5's own arm. A door the club has switched off is the likeliest reason a door did not
   * open, and the check used to reach past it for a scanner that might need a wipe — on a
   * page whose standing line was saying so ten pixels above.
   */
  it("names a shut door before it guesses at the scanner", () => {
    for (const { state, screen } of everyScreen()) {
      if (state.shut !== "some" && state.shut !== "all") continue;
      // With the club unreachable the shut-door fact came from a read that has since failed,
      // and the check says so rather than asserting it — the connection arm outranks this
      // one on purpose. See `concludeFrom`.
      if (state.connection !== "ok") continue;
      const { diagnosis } = screen;
      const text = flat(diagnosis.conclusion);
      if (diagnosis.rows.some((r) => r.state === "failed")) continue;
      expect(text, "guessed at the scanner with a door shut").not.toMatch(/scanner may need a wipe/);
      expect(text).toMatch(/has shut/);
    }
  }, SWEEP_MS);

  /** And never the reverse: a shut-door conclusion where nothing is shut. */
  it("never invents a shut door in the conclusion either", () => {
    for (const { state, screen } of everyScreen()) {
      if (state.shut === "some" || state.shut === "all") continue;
      expect(flat(screen.diagnosis.conclusion), `doors_shut=${state.shut}`)
        .not.toMatch(/has shut (its|some of its) doors/);
    }
  }, SWEEP_MS);

  /**
   * <b>R3-3's member half, held as a rule rather than at one call site.</b> The finding is a
   * CHR one — the shared formatter, and the admin screens that were labelling the browser's
   * zone "club time" — but the member surfaces are where a reader is furthest from the club,
   * and the rule this lane owes is that EVERY face here is written with the zone the response
   * carried. The unit runner is pinned to the club's own zone, so a formatter reading the
   * browser instead is invisible unless the fixture's zone differs from it; two are swept,
   * one ahead of the club and one far behind, and every clock face has to move with them.
   * </p>
   */
  it.each(["Europe/London", "America/Los_Angeles", "Pacific/Auckland"])(
    "writes every member-door clock face in the club's zone, not the reader's — %s",
    (timezone) => {
      const booking = {
        starts_at: "2099-01-01T17:00:00Z", ends_at: "2099-01-01T17:45:00Z", court_number: 3,
        door_opens_at: "2099-01-01T16:30:00Z", door_closes_at: "2099-01-01T18:05:00Z",
      };
      const faces = (zone: string | undefined) => {
        const line = describeStanding({
          policy: "booking_window", membership: "active", membership_detail: "active",
          is_club_admin: false, early_entry_minutes: 30, next_booking: booking,
          doors_shut: "none", timezone: zone,
        } as Parameters<typeof describeStanding>[0]);
        return [
          line.body,
          decisionStamp("front-door", booking.door_opens_at, booking.door_closes_at, zone),
          historyOfflineLine(booking.door_closes_at, zone, booking.starts_at),
        ].join(" ");
      };
      // Africa/Johannesburg is the runner's pinned zone AND the club's default, so a
      // formatter reading the browser produces exactly this string for every zone.
      expect(faces(timezone)).not.toBe(faces("Africa/Johannesburg"));
      // And the zone is honoured rather than merely different: 16:30Z is 18:30 in the club's
      // own day and something else in each of these.
      expect(faces(timezone)).not.toContain("18:30");
    },
  );

  /** Six rows, always, whatever it was handed. A silently dropped row is an unasked question. */
  it("asks the same six questions in every state", () => {
    for (const { screen } of everyScreen()) {
      const { diagnosis } = screen;
      expect(diagnosis.rows.map((r) => r.key)).toEqual([
        "membership", "policy", "booking", "window", "code", "connection",
      ]);
      expect(flat(diagnosis.conclusion).length).toBeGreaterThan(20);
    }
  }, SWEEP_MS);

  /**
   * <b>R3-5: the anomaly leads when nothing else won, rather than trailing a clean bill.</b>
   * It was a clause on the end of "Everything on this phone looks right… its scanner may need
   * a wipe" — a guess about hardware handed to somebody whose record the club does not have,
   * with the only irregular thing the check found reduced to a footnote.
   */
  it("leads with the club's missing record rather than appending it to an all-clear", () => {
    const healthy = {
      standingKnown: true, membership: "none" as const, membership_detail: "none",
      policy: "active_member" as const, hasBooking: false, bookingStartsClock: null,
      doorWindowOpen: null, opensAtClock: null, opensInWords: null, codeSecondsLeft: 58,
      connection: "ok" as const, contact: CONTACT, holdingCode: false,
      lastRefusal: null, doorsShut: "none" as const,
      memberCodeOpensDoor: true,
    };
    const text = flat(buildDiagnosis(healthy).conclusion);
    expect(text).toMatch(/^Nothing on this phone is wrong\./);
    expect(text).toMatch(/no membership on file for you/);
    // Never the scanner guess, and never the anomaly as an afterthought on one.
    expect(text).not.toMatch(/scanner may need a wipe/);
    expect(text).not.toMatch(/The club also has no membership/);
    // And it still refuses to claim that is WHY: `StatusIfBarredAsync` answers null for a
    // user with no membership row and `GateAccess` walks past the check, so a screen saying
    // the door refused her for it would send her to the desk over the one thing that is not
    // stopping her.
    expect(text).toMatch(/probably not why you're outside/);
  });

  /**
   * <b>R3-17.</b> `delivered_at` before `at` is the board's clock being wrong, not a journey
   * that finished before it started: "the door told us at 19:22" about a 19:48 scan. The
   * clause is withheld rather than printed, because a member reconciling their own record has
   * been handed two numbers that cannot both be right.
   */
  it("withholds a delivery instant that predates the scan it reports", () => {
    const impossible = decisionStamp("front-door", "2026-09-19T17:48:00Z", "2026-09-19T17:22:00Z");
    expect(impossible).toContain("front-door");
    expect(impossible).not.toMatch(/the club heard at/);
    // The ordinary case is untouched: a real delivery delay is the answer to a real question.
    expect(decisionStamp("front-door", "2026-09-19T17:22:00Z", "2026-09-19T17:48:00Z"))
      .toMatch(/the club heard at 19:48/);
  });

  it("calls a clamped or impossible time approximate, and an ordinary one nothing", () => {
    expect(timeIsUncertain({ at: "2026-09-19T17:48:00Z", delivered_at: "2026-09-19T17:22:00Z" })).toBe(true);
    expect(timeIsUncertain({ at: "2026-09-19T17:48:00Z", time_uncertain: true })).toBe(true);
    expect(timeIsUncertain({ at: "2026-09-19T17:22:00Z", delivered_at: "2026-09-19T17:48:00Z" })).toBe(false);
    expect(timeIsUncertain({ at: "2026-09-19T17:22:00Z", delivered_at: null })).toBe(false);
    // An unparseable instant is "this screen cannot tell", which is not "this is impossible".
    expect(timeIsUncertain({ at: "not-a-date", delivered_at: "also-not" })).toBe(false);
    expect(TIME_UNCERTAIN_NOTE).toMatch(/approximate/);
  });

  /**
   * R3-5's visible half. A tick is a claim and a grey dash is "this does not apply here";
   * a club with no record of the member is neither, and the only thing telling it from the
   * dash was a state word that is `sr-only`.
   */
  it("draws a missing membership as a problem rather than as not-applicable", () => {
    for (const { state, screen } of everyScreen()) {
      if (state.membership !== "none") continue;
      const row = screen.diagnosis.rows.find((r) => r.key === "membership")!;
      // Ruling 15: a failure, not a curiosity. Never the grey "does not apply here".
      expect(row.state).toBe("failed");
      expect(row.state).not.toBe("neutral");
    }
  }, SWEEP_MS);
});

describe("decisionAge — words, never 'min' (R7 J7-3)", () => {
  it("ends the card's sentence in a unit a screen reader says", () => {
    expect(decisionAge(1)).toBe("1 minute ago");
    expect(decisionAge(12)).toBe("12 minutes ago");
  });
});
