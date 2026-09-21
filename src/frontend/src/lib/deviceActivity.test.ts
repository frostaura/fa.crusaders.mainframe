import { describe, expect, it } from "vitest";
import type { DeviceActivityEntry, DoorEventEntry } from "./api";
import {
  DOOR_OUTCOME_CHIPS,
  DOOR_REFUSAL_REASONS,
  MAX_UNACKNOWLEDGED_DEVICES,
  UNACKNOWLEDGED_NOTICE_FROM,
  activityEmptyNotice,
  activityPanelTitle,
  describeActivityAction,
  describeActivityReason,
  describeActivityWho,
  DOOR_EVENT_CHANGE_WORDS,
  describeDoorEventChange,
  unacknowledgedBoardsNotice,
} from "./deviceActivity";

/**
 * What the Devices page says about a board's own trail.
 *
 * <p>
 * The door's audit rows existed from the day the gate shipped and no screen read them, so
 * the only way to find out why a member had been turned away at a door was to open the
 * database. The refusal reasons in particular had been carried through the firmware, the
 * wire corpus and the spec for three rounds without ever reaching a sentence an admin could
 * read — <code>too_early</code> is a token, not an answer to "why would it not let me in".
 * </p>
 */

function entry(overrides: Partial<DeviceActivityEntry> = {}): DeviceActivityEntry {
  return {
    at: "2026-09-19T18:04:00Z",
    action: "gate.opened",
    reason: "ok",
    offline: false,
    member: { id: "44444444-4444-4444-4444-444444444444", name: "Ada Lovelace" },
    fingerprint: "1f2e3d4c",
    ...overrides,
  };
}

describe("describeActivityAction", () => {
  it.each([
    ["gate.opened", "Door opened"],
    ["gate.denied_no_booking", "Refused"],
    ["gate.denied_too_early", "Refused"],
    ["device.gate_open", "Door opened"],
    ["device.unknown_scan", "Refused"],
    ["device.activation", "Court activated"],
    ["device.release", "Court released"],
    ["device.boot", "Board started up"],
  ])("says what %s was, in words", (action, words) => {
    expect(describeActivityAction(entry({ action }))).toBe(words);
  });

  /**
   * An action nobody has written copy for is READ OUT, not hidden. A panel that silently
   * dropped what it did not recognise would be a trail that looks complete and is not —
   * and the actions this list carries are added by firmware rounds, not by this screen.
   */
  it.each([
    ["device.something_new", "Something new"],
    ["gate.rebooted", "Rebooted"],
    ["court.lights_on", "Court lights on"],
    ["bare", "Bare"],
  ])("renders the unknown action %s readably rather than hiding it", (action, words) => {
    expect(describeActivityAction(entry({ action }))).toBe(words);
  });

  /** Nothing renders as a blank row: an empty action is still a row that happened. */
  it("does not render an empty string for an action it cannot read", () => {
    expect(describeActivityAction(entry({ action: "" }))).not.toBe("");
    expect(describeActivityAction(entry({ action: "   " }))).not.toBe("");
  });
});

/**
 * The door refusal dictionary — the whole reason this panel exists.
 *
 * <p>
 * Every one of these tokens has been in the firmware, the corpus and the spec since the
 * gate shipped, and none had ever been turned into a sentence: an admin asked "why did the
 * door not let me in" had a database query as the only answer.
 * </p>
 */
describe("describeActivityReason", () => {
  it.each([
    ["not_recognised", /not recognised/i],
    ["member_not_active", /membership/i],
    ["no_booking", /booking/i],
    ["too_early", /early/i],
    // A firmware or configuration fault rather than a member's mistake, so the sentence
    // has to put the BOARD in it — an admin who reads it as the member's doing sends the
    // member to the desk instead of looking at the door.
    ["method_not_supported", /the board asked/i],
    ["not_a_gate", /court box/i],
  ])("turns %s into a sentence rather than a token", (reason, matcher) => {
    const words = describeActivityReason(entry({ action: `gate.denied_${reason}`, reason }));
    expect(words).toMatch(matcher);
    // Never the token itself. A screen that prints `member_not_active` has decoded nothing.
    expect(words).not.toContain(reason);
  });

  it("has a sentence for every reason the door can give", () => {
    // The set the API answers with, per the gate spec's Reasons table. `no_membership` is
    // ruling 15's: a user the club has NO membership row for used to walk past the check
    // entirely, and the door now refuses with a reason of its own rather than borrowing
    // `member_not_active` — a different fact, and a different fix.
    expect(Object.keys(DOOR_REFUSAL_REASONS).sort()).toEqual([
      "member_not_active", "method_not_supported", "no_booking", "no_membership",
      "not_a_gate", "not_recognised", "ok", "too_early",
    ]);
  });

  /**
   * `ok` on an opened door says nothing an admin does not already read in the action
   * beside it, and a second column repeating the first is noise on a fifty-row list.
   * It is still in the dictionary, because the token can arrive on other actions.
   */
  it("says nothing extra when a door simply opened", () => {
    expect(describeActivityReason(entry({ action: "gate.opened", reason: "ok" }))).toBeNull();
    expect(DOOR_REFUSAL_REASONS.ok).toBeTruthy();
  });

  /**
   * The two uploaded kinds. A board that was offline decided by itself and uploaded the
   * row afterwards, so the timestamp is real and the DECISION was never the server's —
   * which is worth saying, because an admin reading a refusal assumes the API refused it.
   */
  it("says an offline open was the board's own decision", () => {
    const words = describeActivityReason(entry({ action: "device.gate_open", reason: null, offline: true }));
    expect(words).toBe("Lock released while offline");
  });

  /**
   * <b>E-L2 / WIRE-R2 §3.</b> It rendered as "Refused / No reason recorded", which reads as a
   * gap in the trail. There is no gap: the board looked the code up in the list it last
   * downloaded and did not find it, and that IS the reason.
   *
   * <p>
   * It also names nobody, because the door genuinely cannot — an unmatched code resolves to
   * nothing at all, which is a different thing from a member the club failed to identify.
   * That half is now one line beside the rows ({@link OFFLINE_WHO_NOTE}) rather than repeated
   * on every one of them.
   * </p>
   */
  it("says an offline refusal was a code the door's list did not hold", () => {
    const words = describeActivityReason(entry({ action: "device.unknown_scan", reason: null, offline: true }));
    expect(words).toBe("Code not on the door's saved list");
    expect(words).not.toContain("No reason recorded");
  });

  /** A reason nobody has copy for is still shown, readably — same rule as an action. */
  it("renders an unknown reason readably rather than dropping it", () => {
    expect(describeActivityReason(entry({ action: "gate.denied_wat", reason: "some_new_reason" })))
      .toBe("Some new reason");
  });

  it("has nothing to say when there is no reason at all", () => {
    expect(describeActivityReason(entry({ action: "device.boot", reason: null, offline: false }))).toBeNull();
  });
});

describe("describeActivityWho", () => {
  it("names the member when the server resolved one", () => {
    expect(describeActivityWho(entry())).toBe("Ada Lovelace");
  });

  /**
   * A code the server could not resolve. The fingerprint is a non-reversible short hash of
   * the code (B4), and it is the only thing that correlates two scans of one unknown code —
   * which is exactly the question an admin has ("is somebody trying codes at my door?").
   */
  it("shows an unresolved code as its fingerprint, not as a blank", () => {
    expect(describeActivityWho(entry({ member: null }))).toBe("Unknown code · 1f2e3d4c");
  });

  /** A row with no subject at all — a boot, a release — names nobody rather than "unknown". */
  it("names nobody on a row that has no subject", () => {
    expect(describeActivityWho(entry({ member: null, fingerprint: null }))).toBeNull();
  });

  /**
   * CLAIM PROBE. The member is preferred over the fingerprint, always: a row that resolved
   * to Ada and ALSO carries her code's fingerprint must read as Ada. Showing the hash
   * beside a name it belongs to would leak a correlator into a row that did not need one.
   */
  it("prefers the resolved member over the fingerprint, never both", () => {
    const who = describeActivityWho(entry());
    expect(who).toBe("Ada Lovelace");
    expect(who).not.toContain("1f2e3d4c");
  });
});

describe("activityPanelTitle", () => {
  it("calls a door's trail door activity and a box's box activity", () => {
    expect(activityPanelTitle(true)).toBe("Door activity");
    expect(activityPanelTitle(false)).toBe("Box activity");
  });
});

describe("activityEmptyNotice", () => {
  it("says nothing is recorded yet, for the kind of board it is", () => {
    expect(activityEmptyNotice(true)).toBe("Nothing recorded for this door yet.");
    expect(activityEmptyNotice(false)).toBe("Nothing recorded for this box yet.");
  });

  /** Not an error, and not a fault. A door nobody has walked through has an empty trail. */
  it("does not read as a failure", () => {
    const notice = activityEmptyNotice(true).toLowerCase();
    expect(notice).not.toContain("could not");
    expect(notice).not.toContain("error");
  });
});

/**
 * The cap an admin cannot see coming.
 *
 * <p>
 * Auto-registration refuses a new MAC once a tenant holds
 * {@link MAX_UNACKNOWLEDGED_DEVICES} rows nobody has acknowledged — the API answers 409
 * `too_many_unacknowledged_devices` to the BOARD, so that refusal is never reachable from
 * this console at all. The only way an admin learns about it from a screen is a warning
 * before the club gets there, which is what this is.
 * </p>
 */
describe("unacknowledgedBoardsNotice", () => {
  it("says nothing while the club is nowhere near the cap", () => {
    expect(unacknowledgedBoardsNotice(0)).toBeNull();
    expect(unacknowledgedBoardsNotice(UNACKNOWLEDGED_NOTICE_FROM - 1)).toBeNull();
  });

  it("warns from the threshold up, and names both numbers", () => {
    const notice = unacknowledgedBoardsNotice(UNACKNOWLEDGED_NOTICE_FROM);
    expect(notice).toContain(String(UNACKNOWLEDGED_NOTICE_FROM));
    expect(notice).toContain(String(MAX_UNACKNOWLEDGED_DEVICES));
  });

  /**
   * And it says what the club LOSES at the cap, not just that there is one. "You have 12
   * unnamed boards" is a count; "at 16 a new board cannot register" is the consequence,
   * and the consequence is what makes somebody act before a board they just flashed is
   * turned away with an error only the board sees.
   */
  it("names the consequence, not only the count", () => {
    const notice = unacknowledgedBoardsNotice(15) ?? "";
    expect(notice).toMatch(/stops? registering|cannot register|will not register/i);
    expect(notice).toMatch(/name|delete/i);
  });

  /** The threshold sits below the cap, or the warning arrives with the door already shut. */
  it("warns before the cap rather than at it", () => {
    expect(UNACKNOWLEDGED_NOTICE_FROM).toBeLessThan(MAX_UNACKNOWLEDGED_DEVICES);
  });

  /** The contract constant, not a number this screen picked. */
  it("uses the contract's own cap", () => {
    expect(MAX_UNACKNOWLEDGED_DEVICES).toBe(16);
    expect(UNACKNOWLEDGED_NOTICE_FROM).toBe(12);
  });

  /** At the cap itself the sentence must not still say the club has room. */
  it("does not promise room the club no longer has", () => {
    const notice = unacknowledgedBoardsNotice(MAX_UNACKNOWLEDGED_DEVICES) ?? "";
    expect(notice).not.toMatch(/you can still add/i);
  });
});

/**
 * The chip dictionary and the sentence dictionary, held against each other.
 *
 * <p>
 * This is the test that makes it right to put both maps in one module. A reason with a
 * sentence and no chip renders an unlabelled row in the feed; a chip with no sentence is an
 * outcome the log offers as a filter value and which matches nothing. Neither failure is
 * visible from either map alone, and both are one keystroke away whenever the door gains a
 * refusal reason.
 * </p>
 */
describe("DOOR_OUTCOME_CHIPS", () => {
  it("covers exactly the reasons that have sentences, in both directions", () => {
    expect(Object.keys(DOOR_OUTCOME_CHIPS).sort()).toEqual(Object.keys(DOOR_REFUSAL_REASONS).sort());
  });

  it("has a non-empty label for every reason", () => {
    for (const [reason, chip] of Object.entries(DOOR_OUTCOME_CHIPS)) {
      expect(chip.trim(), reason).not.toBe("");
    }
  });

  /**
   * <b>A1.2.</b> P2 says no screen may imply the door moved. "Opened" on a chip is exactly
   * that implication wearing a badge, and the sentence beside it cannot retract a word the
   * chip has already said. "Lock released" is the strongest true statement: the board
   * reported it energised the lock, and there is no sensor on any door.
   */
  it("says Lock released for a granted scan, never Opened", () => {
    expect(DOOR_OUTCOME_CHIPS.ok).toBe("Lock released");
    for (const chip of Object.values(DOOR_OUTCOME_CHIPS)) {
      expect(chip).not.toBe("Opened");
      expect(chip).not.toBe("Working");
      expect(chip).not.toBe("Open");
    }
  });

  /** The court box's vocabulary is not a door's, here as everywhere else on this surface. */
  it("borrows nothing from the court box", () => {
    for (const chip of Object.values(DOOR_OUTCOME_CHIPS)) {
      for (const boxOnly of ["court", "relay", "lights"]) {
        expect(chip.toLowerCase()).not.toContain(boxOnly);
      }
    }
  });

  /** A chip is a label on a row that is eight characters wide on a phone. */
  it("keeps every label short enough to be a chip", () => {
    for (const [reason, chip] of Object.entries(DOOR_OUTCOME_CHIPS)) {
      expect(chip.length, reason).toBeLessThanOrEqual(16);
    }
  });
});

/**
 * <b>A5 / E-M6 / WIRE-R2 §2 — what actually changed, and who changed it.</b>
 *
 * <p>
 * `kind` could not say: the backend wrote `device.updated` for a rename, a details change, a
 * shut and a reopen alike, so a reviewer met nine identical rows reading "this door's details
 * or state were changed" and learned nothing from any of them — while the door card told
 * every admin in the club "You shut this door."
 * </p>
 */
describe("describeDoorEventChange", () => {
  const event = (over: Partial<DoorEventEntry> = {}): DoorEventEntry => ({
    at: "2026-09-20T19:40:00Z", action: "device.updated", kind: "edited", ...over,
  });

  it("says which of the four an edit was, and who did it", () => {
    expect(describeDoorEventChange(event({ change: "shut", actor_name: "Priya Naidoo" })))
      .toBe("Shut by Priya Naidoo");
    expect(describeDoorEventChange(event({ change: "renamed", actor_name: "Ruth Adams" })))
      .toBe("Renamed by Ruth Adams");
    expect(describeDoorEventChange(event({ change: "reopened", actor_name: "Ruth Adams" })))
      .toBe("Reopened by Ruth Adams");
    expect(describeDoorEventChange(event({ change: "details", actor_name: "Ruth Adams" })))
      .toBe("Details changed by Ruth Adams");
  });

  /** A row written before the server recorded which. Broad, and true — never a guessed verb. */
  it("says the broad thing for an edit nobody classified", () => {
    expect(describeDoorEventChange(event({ change: "other", actor_name: "Ruth Adams" })))
      .toBe("Details or state changed by Ruth Adams");
  });

  /** An older API sends no `change` at all, and `kind` is all it has to say. */
  it("falls back to the kind against an API that does not carry a change", () => {
    expect(describeDoorEventChange(event())).toBe("This door's details or state were changed");
  });

  /**
   * A board-side event has no actor and must not be given one: "The board registered itself
   * by Priya Naidoo" is a sentence about a thing that did not happen.
   */
  it("names nobody for something a board did to itself", () => {
    expect(describeDoorEventChange(event({ change: "registered", actor_name: "Priya Naidoo" })))
      .toBe("The board registered itself");
    expect(describeDoorEventChange(event({ change: "clock_corrected", actor_name: "Priya Naidoo" })))
      .toBe("The board's clock was out and was corrected");
  });

  it("names nobody where the API named nobody", () => {
    expect(describeDoorEventChange(event({ change: "shut", actor_name: null }))).toBe("Shut");
    expect(describeDoorEventChange(event({ change: "shut" }))).toBe("Shut");
  });

  /** A change this build has never seen reads out rather than borrowing somebody else's words. */
  it("does not guess at a change it has no copy for", () => {
    expect(describeDoorEventChange(event({ change: "teleported", actor_name: "Ruth Adams" })))
      .toBe("Unrecognised event by Ruth Adams");
  });

  /** Every arm is a phrase a volunteer reads, not an audit token. */
  it("never renders a raw token as the sentence", () => {
    for (const change of Object.keys(DOOR_EVENT_CHANGE_WORDS)) {
      const words = describeDoorEventChange(event({ change }));
      expect(words).not.toContain("_");
      expect(words).not.toContain("device.");
    }
  });
});
