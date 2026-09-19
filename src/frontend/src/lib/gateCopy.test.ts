import { describe, expect, it } from "vitest";
import {
  GATE_KEY_MAX_LENGTH, GATE_POLICY_LABELS, NEW_GATE_BADGE, UNNAMED_GATE, describeGate,
  describeGatePolicy, gateDeleteConfirm, gateOfflineFallbackNotice, gateOutOfServiceConfirm,
  gateOutOfServiceNotice,
} from "./gateCopy";
import { GATE_ACCESS_POLICIES } from "./api";

/**
 * Every sentence the console says about a door, pinned word for word.
 *
 * <p>
 * <b>Why exact strings and why here.</b> The court-box half of the Devices screen shipped a
 * false out-of-service sentence three rounds running, each time green on the day, because
 * each sentence was pinned only by whichever rendered fixture that round happened to build.
 * `deviceCoverage.test.ts` is the answer to that on the box side; this is the same answer on
 * the door side, written before the first mistake rather than after the third.
 * </p>
 *
 * <p>
 * Each test below names the CLAIM it is holding, not the wording, so that a rewrite which
 * keeps the meaning can update the string while a rewrite that drops the claim goes red for
 * a reason somebody can read.
 * </p>
 */

describe("describeGate", () => {
  it("names the door when it has a name", () => {
    expect(describeGate("front-door")).toBe("Door gate · front-door");
  });

  /**
   * A gate self-registers with `GateKey = null`, so "unnamed" is the state every door in the
   * club is in the first time an admin opens the screen — the common case, not an edge one.
   * An empty gap where a box's courts go reads as a rendering fault rather than as a job.
   */
  it("says the door has no name rather than leaving a gap", () => {
    expect(describeGate(null)).toBe("Door gate · no door name yet");
    expect(describeGate(null)).toContain(UNNAMED_GATE);
    expect(describeGate(null)).not.toBe("Door gate · ");
  });

  it("always says what kind of board it is, named or not", () => {
    for (const key of ["front-door", "x".repeat(GATE_KEY_MAX_LENGTH), null]) {
      expect(describeGate(key)).toContain("Door gate");
    }
  });
});

/**
 * The badge a new door wears. The box badge says "check court numbers"; on a door that would
 * send an admin looking for an editor the row does not have and must not have, because the
 * API refuses court fields on a Gate row outright.
 */
describe("NEW_GATE_BADGE", () => {
  it("asks for the one thing a new door is actually missing", () => {
    expect(NEW_GATE_BADGE).toBe("New — name this door");
  });

  it("says nothing about courts, which a door does not have", () => {
    expect(NEW_GATE_BADGE.toLowerCase()).not.toContain("court");
  });
});

/**
 * The out-of-service notice, which the row and the toast both render.
 *
 * <p>
 * Three claims, each asserted on its own as well as inside the exact string, because an
 * equality goes red on any edit at all and says nothing about which edit mattered.
 * </p>
 */
describe("gateOutOfServiceNotice", () => {
  it("is exactly this", () => {
    expect(gateOutOfServiceNotice()).toBe(
      "The club is not alerted about its silence, and the API stops answering scans at this"
      + " door, so it opens nothing from the instant the switch is thrown. The door keeps whatever"
      + " roster it last downloaded, so a member with a booking already in that cache may still get"
      + " in until it goes stale — nobody else will. Bookings, check-ins, refunds and no-show"
      + " penalties are untouched either way: opening a door is not attendance.",
    );
  });

  /**
   * <b>It does not claim the door stops opening.</b>
   *
   * <p>
   * This is the claim that would have been wrong, and it is the exact shape of the box
   * side's "nobody can check in there" — a plausible, simple sentence that the code does not
   * support and that survived three rounds. A 403 is not a refusal to the firmware, it is an
   * outage, and the documented response to any non-200 is the cached roster. So a door whose
   * API has stopped answering it keeps opening for a booked member until that roster goes
   * stale, and an admin who believed the flat sentence would have no way to understand
   * somebody walking through a door the screen had told them was shut.
   * </p>
   */
  it("does not promise the door stops opening, because a cached roster still opens it", () => {
    const notice = gateOutOfServiceNotice();
    expect(notice).toContain("roster it last downloaded");
    expect(notice).toContain("may still get in until it goes stale");
    expect(notice).not.toContain("stops opening");
    expect(notice).not.toContain("opens for nobody");
    // And the limit on the caveat, or it reads as "out of service does nothing".
    expect(notice).toContain("nobody else will");
  });

  /**
   * <b>It says no money moves.</b> The identical control one row above — on a court box —
   * waives no-show penalties across a whole court, so an admin who has read THAT notice has
   * every reason to assume this one does something similar. It does not: a gate decision
   * never writes a booking, a CheckedInAt, a ledger entry or a settlement row, online or
   * from the roster.
   */
  it("says explicitly that nothing settles, because the control beside it does settle", () => {
    expect(gateOutOfServiceNotice()).toContain(
      "Bookings, check-ins, refunds and no-show penalties are untouched either way",
    );
  });

  /** And none of the court-box vocabulary, none of which is true of a door. */
  it("borrows nothing from the court box's copy", () => {
    const notice = gateOutOfServiceNotice();
    for (const boxOnly of ["court", "relay", "lights", "refunded in full", "judged as normal"]) {
      expect(notice.toLowerCase()).not.toContain(boxOnly);
    }
  });
});

/**
 * The confirm is shorter than the notice it produces and must not out-promise it. The box
 * pair disagreed twice, at different call sites, about what the very next click would do.
 */
describe("gateOutOfServiceConfirm", () => {
  it("is exactly this", () => {
    expect(gateOutOfServiceConfirm()).toBe(
      "Out of service? The API stops answering scans at this door. It may still open from its"
      + " cached roster until that goes stale. No booking, check-in or no-show penalty changes.",
    );
  });

  it("carries both halves the notice carries, compressed rather than dropped", () => {
    const confirm = gateOutOfServiceConfirm();
    expect(confirm).toContain("cached roster");
    expect(confirm).toContain("No booking, check-in or no-show penalty changes");
  });

  it("does not claim more than the notice the click produces", () => {
    expect(gateOutOfServiceConfirm()).not.toContain("stops opening");
  });
});

/**
 * Deleting forgets a row and revokes nothing — the board still holds the club's one key. A
 * door differs from a box in what comes BACK: a gate self-registers with a null key, so the
 * door's name is what is actually lost and has to be redone.
 */
describe("gateDeleteConfirm", () => {
  it("says the door comes straight back, and comes back unnamed", () => {
    expect(gateDeleteConfirm()).toBe("Delete? The door re-registers on its next heartbeat with no name.");
  });

  it("does not read as a revocation", () => {
    const confirm = gateDeleteConfirm().toLowerCase();
    expect(confirm).not.toContain("really delete");
    expect(confirm).toContain("re-registers");
  });
});

describe("describeGatePolicy", () => {
  /**
   * Both arms name the exemption, because it is the one an admin cannot guess and the one
   * that matters at 6am: a user with no membership row is NOT barred, which is how an
   * operator or a club admin opens a door at all.
   */
  it("names the accounts that pass under either policy", () => {
    for (const policy of GATE_ACCESS_POLICIES) {
      expect(describeGatePolicy(policy, 30)).toContain("club admins and operators, always pass");
    }
  });

  it("names the three membership states that are turned away under the open policy", () => {
    const open = describeGatePolicy("active_member", 30);
    expect(open).toBe(
      "Any member whose code scans opens the door, unless their membership is suspended,"
      + " pending approval or rejected. Accounts with no membership of their own, such as club"
      + " admins and operators, always pass.",
    );
  });

  /**
   * The early-entry number is interpolated rather than described. "Within the early-entry
   * window" makes an admin scroll and do arithmetic to learn what they have just chosen;
   * the number itself is the whole answer.
   */
  it("spells out the early-entry minutes the strict policy actually allows", () => {
    expect(describeGatePolicy("booking_window", 30)).toContain("starts within the next 30 minutes");
    expect(describeGatePolicy("booking_window", 0)).toContain("starts within the next 0 minutes");
    // Singular at one, because a hint that reads "1 minutes" is a hint nobody trusts the
    // rest of.
    expect(describeGatePolicy("booking_window", 1)).toContain("starts within the next 1 minute,");
  });

  it("says the strict policy counts a booking on any court, and turns everyone else away", () => {
    const strict = describeGatePolicy("booking_window", 30);
    expect(strict).toContain("on any court");
    expect(strict).toContain("has not yet ended");
    expect(strict).toContain("Anyone else is turned away");
  });

  it("does not describe the two policies with the same sentence", () => {
    expect(describeGatePolicy("active_member", 30)).not.toBe(describeGatePolicy("booking_window", 30));
  });
});

describe("GATE_POLICY_LABELS", () => {
  it("names both wire values, and only those", () => {
    expect(Object.keys(GATE_POLICY_LABELS).sort()).toEqual(["active_member", "booking_window"]);
    expect(GATE_POLICY_LABELS.active_member).toBe("Any member in good standing");
    expect(GATE_POLICY_LABELS.booking_window).toBe("Only a member with a booking");
  });

  /** A label per policy the client knows about — a policy with no label renders blank. */
  it("has a label for every policy the client offers", () => {
    for (const policy of GATE_ACCESS_POLICIES) {
      expect(GATE_POLICY_LABELS[policy]).toBeTruthy();
    }
  });
});

/**
 * The degraded mode — the one door behaviour nobody would predict from the controls.
 *
 * <p>
 * Whichever policy is chosen, a door that loses the network falls back to a roster built
 * from BOOKINGS, so a club running the open policy silently becomes booking-only for the
 * length of the outage. An admin who does not know that reads a member locked out during an
 * outage as a broken lock, and sends somebody to look at the hardware.
 * </p>
 */
describe("gateOfflineFallbackNotice", () => {
  it("says the offline fallback is bookings only, whichever policy is set", () => {
    expect(gateOfflineFallbackNotice()).toBe(
      "When a door cannot reach the API it falls back to the roster it last downloaded, and"
      + " that roster holds bookings and nothing else. So while a door is offline, only members"
      + " with an upcoming or running booking can get in — whichever policy is set below.",
    );
  });

  it("names the policy-independence explicitly, which is the part that surprises", () => {
    expect(gateOfflineFallbackNotice()).toContain("whichever policy is set");
  });
});

describe("GATE_KEY_MAX_LENGTH", () => {
  /** Mirrors the API's `gate_key` column — `HasMaxLength(64)`. */
  it("is the API's own bound", () => {
    expect(GATE_KEY_MAX_LENGTH).toBe(64);
  });
});
