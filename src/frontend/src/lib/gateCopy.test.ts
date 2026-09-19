import { describe, expect, it } from "vitest";
import {
  GATE_KEY_MAX_LENGTH, GATE_POLICY_LABELS, NEW_GATE_BADGE, UNNAMED_GATE, describeGate,
  describeGatePolicy, gateDeleteConfirm, gateOfflineFallbackNotice, gateOutOfServiceConfirm,
  gateOutOfServiceNotice, unnamedGateOfflineNotice,
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
      "The club is not alerted about its silence, and the API refuses every scan at this door"
      + " from the instant the switch is thrown. A door that can still reach the API hears that"
      + " refusal and opens for nobody, with no fall back to its roster. A door that has also lost"
      + " the network never hears it, and keeps admitting members with a booking from the roster it"
      + " last downloaded until that goes stale, which takes up to six hours. Bookings, check-ins,"
      + " refunds and no-show penalties are untouched either way: opening a door is not attendance.",
    );
  });

  /**
   * <b>Both halves, because each on its own is now a falsehood.</b>
   *
   * <p>
   * This test used to hold the opposite claim — that the notice must NOT say the door stops
   * opening — and that was right until a 403 became authoritative for a gate. It now is: a
   * board that reaches the API and is refused denies the scan with no roster fallback, and a
   * 403 on its heartbeat commits an empty roster. So "it keeps opening from the cache" is the
   * sentence that is wrong for the ordinary case, and "the door stops opening" is still wrong
   * for the board that has also lost the network and never hears the refusal at all.
   * </p>
   *
   * <p>
   * An admin who reads either half alone cannot explain the other, which is the same failure
   * the box side's "nobody can check in there" was: a plausible, simple sentence that survived
   * three rounds because nothing asserted the half it left out.
   * </p>
   */
  it("says both what a reachable door does and what a cut-off one does", () => {
    const notice = gateOutOfServiceNotice();
    // The reachable board: refused, and explicitly NOT falling back.
    expect(notice).toContain("can still reach the API hears that refusal and opens for nobody");
    expect(notice).toContain("with no fall back to its roster");
    // The cut-off board: never hears it, and the bound on how long that lasts. Without the
    // bound the caveat reads as "out of service does nothing".
    expect(notice).toContain("has also lost the network never hears it");
    expect(notice).toContain("roster it last downloaded");
    expect(notice).toContain("up to six hours");
    // And neither half stated flatly, with no condition attached to it.
    expect(notice).not.toContain("The door opens for nobody.");
    expect(notice).not.toContain("stops opening");
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
      "Out of service? A door that can reach the API opens for nobody from this click. One that"
      + " has also lost the network keeps admitting booked members from its cached roster for up to"
      + " six hours. No booking, check-in or no-show penalty changes.",
    );
  });

  it("carries all three halves the notice carries, compressed rather than dropped", () => {
    const confirm = gateOutOfServiceConfirm();
    expect(confirm).toContain("can reach the API opens for nobody");
    expect(confirm).toContain("cached roster");
    expect(confirm).toContain("up to six hours");
    expect(confirm).toContain("No booking, check-in or no-show penalty changes");
  });

  /**
   * The confirm and the notice must agree about the cut-off door, which is the half a
   * shorter sentence drops first — and dropping it is what would make this a promise the
   * click cannot keep.
   */
  it("does not claim more than the notice the click produces", () => {
    const confirm = gateOutOfServiceConfirm();
    expect(confirm).not.toContain("stops opening");
    expect(confirm).toContain("has also lost the network");
    expect(gateOutOfServiceNotice()).toContain("has also lost the network");
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
   * <b>The exemption is on one arm, and it is about admins, not about missing rows.</b>
   *
   * <p>
   * It used to be printed on both, phrased as "accounts with no membership of their own,
   * such as club admins and operators, always pass". Three things were wrong with that. The
   * rule is `User.IsAdmin`; there is no operator role in this product at all; and under
   * `active_member` every active member passes anyway, so an exemption there exempted
   * nobody from anything — while being FALSE of the one account it could have mattered to,
   * because a club admin whose own membership is suspended is barred like anybody else.
   * </p>
   */
  it("exempts club admins only where there is something to be exempt from", () => {
    const strict = describeGatePolicy("booking_window", 30);
    expect(strict).toContain("Club admins always pass this booking check");
    // And the limit on it, in the same breath: the barred check is not waived for an admin.
    expect(strict).toContain("still turns anyone away, admin or not");

    // Nothing of the sort under the open policy, where it would exempt nobody.
    expect(describeGatePolicy("active_member", 30)).not.toContain("always pass");
    expect(describeGatePolicy("active_member", 30)).not.toContain("admins");
  });

  /** There is no operator role in the product, so the word is in neither arm. */
  it("never says operator, because no such role exists", () => {
    for (const policy of GATE_ACCESS_POLICIES) {
      expect(describeGatePolicy(policy, 30).toLowerCase()).not.toContain("operator");
    }
  });

  it("names the three membership states that are turned away under the open policy", () => {
    const open = describeGatePolicy("active_member", 30);
    expect(open).toBe(
      "Any member whose own code scans opens the door at any hour, unless their membership is"
      + " suspended, pending approval or rejected. A booking's QR is narrower: it opens a door only"
      + " from about the time the member's phone starts showing that code until the booking ends,"
      + " and not at all once the booking is cancelled.",
    );
  });

  /**
   * <b>A booking code is not a standing building key.</b>
   *
   * <p>
   * Under `active_member` a member's OWN code opens a door at any hour, and that is the
   * policy working as named. A `BookingActivation` code is a different thing wearing the
   * same shape: it opens a door only inside its own booking's window — from about the point
   * the member's phone would show that code at all, to the booking's end — and not once the
   * booking is cancelled. Nothing on this screen would let an admin guess that from the
   * policy name, and the previous sentence positively implied the opposite by describing
   * every code as "any member whose code scans".
   * </p>
   */
  it("says a booking's QR is narrower than the member's own code, under the open policy", () => {
    const open = describeGatePolicy("active_member", 30);
    expect(open).toContain("own code scans opens the door at any hour");
    expect(open).toContain("A booking's QR is narrower");
    expect(open).toContain("until the booking ends");
    expect(open).toContain("not at all once the booking is cancelled");
    // No number: that horizon is the widest of three settings, so any figure printed here
    // would be wrong for some club. "About" is the honest word and has to survive.
    expect(open).toContain("from about the time");
    expect(open).not.toMatch(/\d/);
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
      + " with an upcoming or running booking can get in — whichever policy is set below. A door"
      + " nobody has named yet is sent no roster at all, so it opens nothing while it is offline.",
    );
  });

  it("names the policy-independence explicitly, which is the part that surprises", () => {
    expect(gateOfflineFallbackNotice()).toContain("whichever policy is set");
  });

  /**
   * The exception to the sentence above it, and the state every door in the club is in on
   * install day: a heartbeat for a gate with a null key answers an empty roster, so
   * "falls back to the roster it last downloaded" is flatly untrue of an unnamed door.
   */
  it("excepts the unnamed door, which has no roster to fall back to", () => {
    expect(gateOfflineFallbackNotice()).toContain("nobody has named yet is sent no roster at all");
  });
});

/**
 * What an unnamed door cannot do — the Devices row, the door-name editor and the
 * cleared-name toast all read this one generator.
 *
 * <p>
 * Online scans work from the moment the board is plugged in, which is what keeps the
 * install plug-and-play; the offline fallback is what waits for a name. The security
 * reason is that anybody holding the club's one device key can self-register a gate with a
 * random MAC, and handing that board the club-wide code set on its first heartbeat is the
 * hole naming the door closes.
 * </p>
 */
describe("unnamedGateOfflineNotice", () => {
  it("is exactly this", () => {
    expect(unnamedGateOfflineNotice()).toBe(
      "Until you name this door it only works while it can reach the server: an unnamed door is"
      + " sent an empty roster, so it opens nothing at all while it is offline.",
    );
  });

  /**
   * Both halves. The consequence alone reads as a bug report; the mechanism alone does not
   * tell an admin what to do about it, and the thing to do is name the door.
   */
  it("says what is lost and what gets it back", () => {
    const notice = unnamedGateOfflineNotice();
    expect(notice).toContain("Until you name this door");
    expect(notice).toContain("only works while it can reach the server");
    expect(notice).toContain("sent an empty roster");
    expect(notice).toContain("opens nothing at all while it is offline");
  });

  /**
   * And it must NOT say the door does not work. It does: an unnamed door opens for whoever
   * the live policy admits, on every scan the API answers. Saying otherwise would send an
   * admin to look at hardware that is behaving exactly as designed.
   */
  it("does not claim an unnamed door is broken", () => {
    const notice = unnamedGateOfflineNotice().toLowerCase();
    expect(notice).not.toContain("does not work");
    expect(notice).not.toContain("opens nothing at all until");
  });
});

describe("GATE_KEY_MAX_LENGTH", () => {
  /** Mirrors the API's `gate_key` column — `HasMaxLength(64)`. */
  it("is the API's own bound", () => {
    expect(GATE_KEY_MAX_LENGTH).toBe(64);
  });
});
