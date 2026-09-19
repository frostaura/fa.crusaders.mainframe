import { describe, expect, it } from "vitest";
import {
  DOOR_REOPEN_LABEL, DOOR_SHUT_LABEL, GATE_KEY_MAX_LENGTH, GATE_POLICY_LABELS, NEW_GATE_BADGE,
  UNNAMED_GATE, describeCourtSettingDoorReach, describeDoorBookingHorizon, describeEarlyEntry,
  describeGate, describeGatePolicy, doorConfirmedLine, doorExitIsMechanical,
  doorFleetReopenConfirm, doorFleetShutConfirm, doorNotConfirmedLine, doorPowerLossLine,
  doorPowerLossUnknownFooter, doorReopenConfirm, doorShutConfirm, doorShutNotice,
  doorShutStandingNotice, doorsShutBanner, gateDeleteConfirm, gateOfflineFallbackNotice,
  unnamedGateOfflineNotice,
} from "./gateCopy";
import { GATE_ACCESS_POLICIES } from "./api";
import { DOOR_BOOKING_HORIZON_MAX_MINUTES, doorBookingHorizonMinutes } from "./tenantSettings";

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
describe("doorShutNotice", () => {
  it("is exactly this", () => {
    expect(doorShutNotice()).toBe(
      "The club is not alerted about its silence, and the API refuses every scan at this door"
      + " from the instant the switch is thrown. A door that can still reach the API hears that"
      + " refusal and opens for nobody, with no fall back to its roster. A door that has also lost"
      + " the network never hears it, and keeps admitting members with a booking from the roster it"
      + " last downloaded until that goes stale, which takes up to six hours. Bookings, refunds and"
      + " no-show penalties are untouched either way, and a door marks nobody as having arrived.",
    );
  });

  /**
   * <b>A1.1: the ban is on the CLAIM, and the denial survives it.</b>
   *
   * <p>
   * P5 bans "attendance" and "check-in". This sentence carried both — in the NEGATIVE, and
   * that denial is the only place an admin learns that a door scan is not a court arrival.
   * Read literally, P5 deletes the denial and leaves the inference it was written to kill.
   * A1.1 rules that the clause is REWRITTEN rather than dropped: same claim, neither token.
   * </p>
   */
  it("still denies that a door records an arrival, without using the banned words", () => {
    const notice = doorShutNotice();
    expect(notice).toContain("a door marks nobody as having arrived");
    expect(notice.toLowerCase()).not.toContain("attendance");
    expect(notice.toLowerCase()).not.toContain("check-in");
    expect(notice.toLowerCase()).not.toContain("check in");
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
    const notice = doorShutNotice();
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
    expect(doorShutNotice()).toContain(
      "Bookings, refunds and no-show penalties are untouched either way",
    );
  });

  /** And none of the court-box vocabulary, none of which is true of a door. */
  it("borrows nothing from the court box's copy", () => {
    const notice = doorShutNotice();
    for (const boxOnly of ["court", "relay", "lights", "refunded in full", "judged as normal"]) {
      expect(notice.toLowerCase()).not.toContain(boxOnly);
    }
  });
});

/**
 * The confirm is shorter than the notice it produces and must not out-promise it. The box
 * pair disagreed twice, at different call sites, about what the very next click would do.
 */
describe("doorShutConfirm", () => {
  it("is exactly this", () => {
    expect(doorShutConfirm()).toBe(
      "Shut this door? A door that can reach the API opens for nobody from this click. One that"
      + " has also lost the network keeps admitting booked members from the list it last downloaded"
      + " for up to six hours. No booking and no no-show penalty changes, and a door marks nobody"
      + " as having arrived.",
    );
  });

  it("carries all three halves the notice carries, compressed rather than dropped", () => {
    const confirm = doorShutConfirm();
    expect(confirm).toContain("can reach the API opens for nobody");
    expect(confirm).toContain("the list it last downloaded");
    expect(confirm).toContain("up to six hours");
    expect(confirm).toContain("No booking and no no-show penalty changes");
  });

  /**
   * The confirm and the notice must agree about the cut-off door, which is the half a
   * shorter sentence drops first — and dropping it is what would make this a promise the
   * click cannot keep.
   */
  it("does not claim more than the notice the click produces", () => {
    const confirm = doorShutConfirm();
    expect(confirm).not.toContain("stops opening");
    expect(confirm).toContain("has also lost the network");
    expect(doorShutNotice()).toContain("has also lost the network");
  });

  /** A1.1 again: the denial is here too, because the confirm is what an admin actually reads. */
  it("denies the arrival claim without the banned tokens", () => {
    expect(doorShutConfirm()).toContain("a door marks nobody as having arrived");
    expect(doorShutConfirm().toLowerCase()).not.toContain("check-in");
    expect(doorShutConfirm().toLowerCase()).not.toContain("attendance");
  });

  /**
   * <b>A1.4: one name for the 403 path on a gate.</b> `AdminDevices` shipped "Take out of
   * service" over this same PATCH. Two names for one mechanism is the failure this module's
   * own header documents, one level up — so the vocabulary is "Shut" / "Reopen" everywhere a
   * DOOR is meant, and the confirm opens with the words on the button.
   */
  it("opens with the words on the button, not with the court box's vocabulary", () => {
    expect(doorShutConfirm().startsWith(`${DOOR_SHUT_LABEL}?`)).toBe(true);
    expect(doorShutConfirm()).not.toContain("Out of service");
    expect(DOOR_SHUT_LABEL).toBe("Shut this door");
    expect(DOOR_REOPEN_LABEL).toBe("Reopen this door");
  });
});

/**
 * Reopening, whose honest half is the OPPOSITE of shutting's.
 *
 * <p>
 * A scan is a pull, so reopening applies at a reachable door on the very next scan with no
 * heartbeat wait — there is nothing to queue and nothing to deliver. The cut-off door is the
 * inverted arm: it never stopped admitting booked members, so "reopened" changes nothing
 * there and saying "the doors are open again" flatly would be a claim about a board nobody
 * can reach.
 * </p>
 */
describe("doorReopenConfirm", () => {
  it("is exactly this", () => {
    expect(doorReopenConfirm()).toBe(
      "Reopen this door? A door that can reach the API opens for members again from the very next"
      + " scan — there is no wait. A door that has lost the network has been admitting booked"
      + " members from its cached list all along, and nothing changes there.",
    );
  });

  it("states both halves, and the reachable half has no wait in it", () => {
    const confirm = doorReopenConfirm();
    expect(confirm).toContain("from the very next scan — there is no wait");
    expect(confirm).toContain("has lost the network has been admitting booked members");
    // The one thing a reopen must never imply: that anything was delivered to a board.
    expect(confirm.toLowerCase()).not.toContain("heartbeat");
  });
});

describe("the fleet confirms", () => {
  it("name the count and both halves, shutting", () => {
    expect(doorFleetShutConfirm(4)).toBe(
      "Shut all 4 doors? Every door that can reach the club's server opens for nobody from this"
      + " click. Any door that has lost the network keeps admitting booked members from the list it"
      + " last downloaded for up to six hours. No booking and no no-show penalty changes.",
    );
  });

  it("name the count and both halves, reopening", () => {
    expect(doorFleetReopenConfirm(4)).toBe(
      "Reopen all 4 doors? Every door that can reach the club's server opens for members again from"
      + " the very next scan. A door that has lost the network has been admitting booked members"
      + " from its cached list all along.",
    );
  });

  /** A club with one door reads a sentence about its door, not "all 1 doors". */
  it("do not say 'all 1 doors' to a club with one door", () => {
    expect(doorFleetShutConfirm(1)).toContain("the club's one door");
    expect(doorFleetShutConfirm(1)).not.toContain("all 1");
    expect(doorFleetReopenConfirm(1)).toContain("the club's one door");
    expect(doorFleetReopenConfirm(1)).not.toContain("all 1");
  });
});

/**
 * The per-door result lines — W1.5's whole point, and the reason the result is a screen
 * rather than a toast.
 *
 * <p>
 * The server did the work at the server. Whether a DOOR knows is a separate fact, and the
 * only evidence for it is how recently that door called in. A result that said "4 doors
 * shut" and stopped would be true of the database and false of the corridor.
 * </p>
 */
describe("doorConfirmedLine / doorNotConfirmedLine", () => {
  it("confirmed carries the age the server saw, and the literal the tests pin", () => {
    expect(doorConfirmedLine("12s ago")).toBe("confirmed — heard from 12s ago");
  });

  it("not confirmed, having been heard from before, bounds how long it may still admit", () => {
    expect(doorNotConfirmedLine("shut", "04:12")).toBe(
      "NOT CONFIRMED — last heard 04:12. It may still admit booked members from its cached list for"
      + " up to six hours.",
    );
  });

  it("not confirmed, never heard from, claims nothing about what it is admitting", () => {
    expect(doorNotConfirmedLine("shut", null)).toBe(
      "NOT CONFIRMED — never heard from. It has never called in, so nothing is known about what it"
      + " is admitting.",
    );
  });

  /**
   * <b>The reopen arm is written, not reused.</b> An unconfirmed SHUT may still be letting
   * booked members in; an unconfirmed REOPEN has been letting them in all along and does not
   * yet know it is open. Reusing the shut sentence on a reopen result would describe the
   * state backwards.
   */
  it("inverts on a reopen rather than reusing the shut sentence", () => {
    expect(doorNotConfirmedLine("reopen", "04:12")).toBe(
      "NOT CONFIRMED — last heard 04:12. It has been admitting booked members from its cached list"
      + " all along, and it will not know it is open again until it reaches the server.",
    );
    expect(doorNotConfirmedLine("reopen", "04:12")).not.toContain("may still admit");
  });

  it("says NOT CONFIRMED in words on every arm, because colour is not a signal", () => {
    for (const at of ["04:12", null]) {
      for (const action of ["shut", "reopen"] as const) {
        expect(doorNotConfirmedLine(action, at)).toContain("NOT CONFIRMED");
      }
    }
  });
});

describe("doorPowerLossLine", () => {
  it("has one sentence per recorded value and none of them is a blank", () => {
    expect(doorPowerLossLine("released")).toBe("With no power this door is: released.");
    expect(doorPowerLossLine("locked")).toBe("With no power this door is: locked.");
    expect(doorPowerLossLine("not_established")).toBe("With no power this door is: not established.");
  });

  /**
   * The default is a real answer, not a placeholder — and the footer says whose job it is,
   * because §11 and the load-shedding moment both turn on somebody walking to the lock.
   */
  it("says the unknown is a property of the lock and that somebody has to look", () => {
    const footer = doorPowerLossUnknownFooter();
    expect(footer).toContain("a property of the lock, not of this software");
    expect(footer).toContain("someone has to look");
  });
});

describe("doorExitIsMechanical", () => {
  it("says getting out is untouched, with or without power", () => {
    const line = doorExitIsMechanical();
    expect(line).toContain("Getting out is mechanical");
    expect(line).toContain("from the inside by hand, with or without power");
  });

  it("uses none of the words this product refuses", () => {
    for (const banned of ["lockdown", "secure the building", "attendance", "check-in", "hold open", "operator", "relay"]) {
      expect(doorExitIsMechanical().toLowerCase()).not.toContain(banned);
    }
  });
});

/**
 * The standing notice on a door that is already shut, and the club-wide banner (D5 / A1.5).
 *
 * <p>
 * W1.5 gave shut-all a result screen and nothing that says, at 05:50 the next morning, that
 * the doors are still shut. A volunteer club discovers that state with thirty members
 * outside. Both halves of the time are stated: a shut door whose `out_of_service_since` the
 * payload does not carry still says it is shut.
 * </p>
 */
describe("doorShutStandingNotice", () => {
  it("names the door and when it was shut, where the payload says when", () => {
    expect(doorShutStandingNotice("front-door", "Tue 19:40")).toBe(
      "front-door is shut. It opens for nobody that can reach the club's server. It was shut on"
      + " Tue 19:40.",
    );
  });

  it("still says the door is shut when nothing recorded when", () => {
    const notice = doorShutStandingNotice("front-door", null);
    expect(notice).toBe("front-door is shut. It opens for nobody that can reach the club's server.");
    expect(notice).not.toContain("It was shut on");
    expect(notice).not.toContain("null");
  });
});

describe("doorsShutBanner", () => {
  it("says how many of how many, singular and plural both", () => {
    expect(doorsShutBanner(1, 4)).toBe("1 of 4 doors is shut.");
    expect(doorsShutBanner(2, 4)).toBe("2 of 4 doors are shut.");
  });

  /** The second sentence is only true when EVERY door is shut, so it only appears then. */
  it("adds that members cannot get in only when every door is shut", () => {
    expect(doorsShutBanner(4, 4)).toBe("4 of 4 doors are shut. Members can't get in.");
    expect(doorsShutBanner(3, 4)).not.toContain("Members can't get in");
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

  /**
   * <b>The carve-out has a third limit, and it is in the same sentence as the carve-out.</b>
   *
   * <p>
   * "Club admins always pass this booking check" is true of a door that can reach the API and
   * false of one that cannot. A cut-off door decides from its cached roster, the roster is
   * built from BOOKINGS, and there is no admin flag anywhere in it — so the one person the
   * club is most certain can always get in is refused at a door that has lost the network.
   * Written as a separate sentence it is a footnote somebody stops reading before; written
   * into the same sentence it is part of the claim, which is what it is.
   * </p>
   */
  it("puts the offline limit on the admin carve-out in the same sentence as the carve-out", () => {
    const strict = describeGatePolicy("booking_window", 30);
    const sentence = strict.split(". ").find((s) => s.includes("Club admins always pass"))!;
    expect(sentence).toBeTruthy();
    expect(sentence).toContain("can still reach the API");
    expect(sentence).toContain("an offline door holds bookings, not admins");
  });

  /**
   * <b>A member who is late is not locked out of the building by the no-show sweep.</b>
   *
   * <p>
   * The sweep marks a booking `NoShow` and the copy used to bound the door at "and has not yet
   * ended", which reads as a lockout at the stroke of the slot's end — and the previous status
   * rule made it one, because only a `Booked` booking counted. It does not: the booking's own
   * code stays live, and a member walking in ten minutes late must not find the door shut on
   * them by a penalty sweep.
   * </p>
   *
   * <p>
   * The sentence names the condition — the code still being live — rather than a clock time,
   * deliberately. Saying "until the booking ends" promises less than the code actually buys,
   * and naming an end-plus-grace arithmetic here promises more than this screen can know.
   * </p>
   */
  it("says a late member still gets in while their code is live, under both policies", () => {
    for (const policy of GATE_ACCESS_POLICIES) {
      const hint = describeGatePolicy(policy, 30);
      expect(hint).toContain("Arriving late is not a lockout");
      expect(hint).toContain("no-show sweep does not take");
    }
    // And the strict arm says which condition actually bounds it, in place of the old
    // "and has not yet ended" — which is the phrase the sweep made a lie.
    expect(describeGatePolicy("booking_window", 30)).toContain("whose code for that booking is still live");
    expect(describeGatePolicy("booking_window", 30)).not.toContain("has not yet ended");
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
      + " from about the time the member's phone starts showing that code — never more than four"
      + " hours before the booking — and only while that code is still live. Arriving late is not a"
      + " lockout: the no-show sweep does not take that code away. A cancelled booking's code opens"
      + " nothing.",
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
    expect(open).toContain("only while that code is still live");
    expect(open).toContain("A cancelled booking's code opens nothing");
    // No number: that horizon is the widest of three settings, so any figure printed here
    // would be wrong for some club. "About" is the honest word and has to survive — and the
    // one bound that IS true of every club is spelt in words, not digits, for the same reason
    // the interpolated early-entry figure would have been wrong here.
    expect(open).toContain("from about the time");
    expect(open).not.toMatch(/\d/);
  });

  /**
   * <b>And the ceiling, which is the half that makes "about the time the phone shows it" safe
   * to print.</b>
   *
   * <p>
   * Without it the sentence is unbounded: a club whose roster reach and lights cue add to more
   * than four hours would read "about the time the phone starts showing that code" as the
   * whole truth, and the door would refuse `too_early` for the difference. The cap is the
   * API's (`GateAccess.MaxEarlyEntryMinutes`), it is four hours, and it is the one number on
   * this arm that is the same for every club.
   * </p>
   */
  it("names the four-hour ceiling on the open policy's booking window", () => {
    expect(describeGatePolicy("active_member", 30)).toContain("never more than four hours before the booking");
    expect(DOOR_BOOKING_HORIZON_MAX_MINUTES).toBe(4 * 60);
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
    expect(strict).toContain("Anyone else is turned away");
  });

  it("does not describe the two policies with the same sentence", () => {
    expect(describeGatePolicy("active_member", 30)).not.toBe(describeGatePolicy("booking_window", 30));
  });
});

/**
 * <b>What the "Early entry" field actually governs, which is not the same thing under the two
 * policies.</b>
 *
 * <p>
 * This is the defect the whole round is about. The field's hint said "How long before a
 * booking starts its holder may come in", flatly, under both policies. Under
 * <code>booking_window</code> that is the door. Under <code>active_member</code> — the API's
 * default — the door's horizon is the wider of this and what the member's phone shows, so at
 * the shipped defaults the hint said 30 and the door opened at 130. The number is still doing
 * two real jobs under that policy (it is the offline roster's reach, and it is the FLOOR under
 * the online horizon), and naming those two is what makes an admin's edit predictable.
 * </p>
 */
describe("describeEarlyEntry", () => {
  it("names the door, and nothing else, under the strict policy", () => {
    const hint = describeEarlyEntry("booking_window");
    expect(hint).toContain("this is the door");
    expect(hint).toContain("a door's cached roster reaches exactly that far");
    // No second horizon to mention: the two court windows do not reach a door under this
    // policy, and naming them would send an admin to edit a field that changes nothing.
    expect(hint).not.toContain("Offline roster reach");
  });

  /** Both jobs under the open policy, and the wider horizon that is not this field's. */
  it("names the offline list and the floor under the open policy, and points at the rest", () => {
    const hint = describeEarlyEntry("active_member");
    expect(hint).toContain("the offline list and the floor");
    expect(hint).toContain("never opens a door less early than this");
    // And the two fields that decide the rest of it, by the labels they carry on screen.
    expect(hint).toContain("Offline roster reach");
    expect(hint).toContain("Lights on this early");
    expect(hint).toContain("never more than 240 minutes");
  });

  /**
   * CLAIM PROBE on "this is the door": the strict arm may say it because under that policy the
   * horizon IS this number, for every value of it. The open arm must not, and does not.
   */
  it("only claims to be the door where it is the door", () => {
    expect(describeEarlyEntry("active_member")).not.toContain("this is the door");
    for (const early of [0, 1, 30, 239, 240]) {
      expect(doorBookingHorizonMinutes({
        gate_access_policy: "booking_window",
        gate_early_entry_minutes: early,
        roster_window_minutes: 1440,
        activation_cue_window_minutes: 1440,
      })).toBe(early);
    }
  });

  it("does not describe the two policies with the same sentence", () => {
    expect(describeEarlyEntry("active_member")).not.toBe(describeEarlyEntry("booking_window"));
  });
});

/**
 * <b>The sentence the two COURT-side settings gained.</b>
 *
 * <p>
 * "Lights on this early" and "Offline roster reach" are filed under Court boxes, they are
 * named for courts, and under the default door policy they are two thirds of what decides
 * when a booking QR opens a DOOR. An admin raising the roster reach to give the boxes a
 * longer outage cushion widened every door in the club, and nothing on either field said so.
 * </p>
 */
describe("describeCourtSettingDoorReach", () => {
  it("says the two court numbers reach the doors under the open policy", () => {
    const line = describeCourtSettingDoorReach("active_member");
    expect(line).toContain("how early a booking's QR opens a door");
    expect(line).toContain("Offline roster reach");
    expect(line).toContain("Lights on this early");
    expect(line).toContain("240 minutes");
  });

  /**
   * And says the opposite under the strict policy, rather than going silent: an admin who
   * read the sentence once needs to know it has stopped applying, and which field took over.
   */
  it("says they do not reach the doors under the strict policy, and names the one that does", () => {
    const line = describeCourtSettingDoorReach("booking_window");
    expect(line).toContain("does not reach the doors");
    expect(line).toContain("Early entry");
    expect(line).not.toContain("how early a booking's QR opens a door");
  });
});

/**
 * <b>The effective number, computed rather than described.</b>
 *
 * <p>
 * Three fields on two blocks decide it, two of them under a heading that says "Court boxes",
 * and the answer under the default policy is none of the three. An admin cannot be asked to
 * do that arithmetic from hints, and a hint that told them to would be the fourth round of
 * this same screen describing a door wrongly.
 * </p>
 */
describe("describeDoorBookingHorizon", () => {
  it("states the number in the sentence the settings block prints", () => {
    expect(describeDoorBookingHorizon(130))
      .toBe("With these settings a booking QR opens a door from 130 minutes before the booking.");
  });

  /** Singular at one, because a line reading "1 minutes" is a line nobody trusts the rest of. */
  it("agrees with itself at one minute and at none", () => {
    expect(describeDoorBookingHorizon(1))
      .toBe("With these settings a booking QR opens a door from 1 minute before the booking.");
    expect(describeDoorBookingHorizon(0))
      .toBe("With these settings a booking QR opens a door from 0 minutes before the booking.");
  });

  /** And at the cap, which is the number an admin is most likely to be surprised by. */
  it("prints the cap as a number like any other", () => {
    expect(describeDoorBookingHorizon(DOOR_BOOKING_HORIZON_MAX_MINUTES))
      .toContain("from 240 minutes before the booking");
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
      + " with an upcoming or running booking can get in — whichever policy is set below. That list"
      + " holds at most 48 bookings, taken in start order, so on a busy night the latest-starting"
      + " bookings beyond that cannot get in while the door is offline. A door nobody has named yet"
      + " is sent no roster at all, so it opens nothing while it is offline.",
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

  /**
   * The cap, which is the half an admin cannot see coming.
   *
   * <p>
   * The roster is ordered by `StartsAt` then `Id` and cut to 48 AFTER ordering
   * (`docs/specs/door-gate.md` §4), so on a night with more than 48 bookings the ones that
   * fall off are the LATEST-STARTING — the members who arrive last. "Only members with an
   * upcoming or running booking can get in" reads as a complete rule without this, and it
   * is not one: a club whose league night runs sixty bookings has twelve members with a
   * live booking and no way in, and nothing on the screen would have said so.
   * </p>
   */
  it("names the 48-booking cap and who falls off it", () => {
    const notice = gateOfflineFallbackNotice();
    expect(notice).toContain("48");
    expect(notice).toContain("latest-starting");
  });

  /**
   * Ordered by START, not by when the booking was made. An admin who reads "the first 48"
   * as "the first 48 booked" would tell the wrong member to re-book.
   */
  it("does not describe the cap as first-come", () => {
    const notice = gateOfflineFallbackNotice().toLowerCase();
    expect(notice).not.toContain("first 48 bookings made");
    expect(notice).not.toContain("first come");
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
