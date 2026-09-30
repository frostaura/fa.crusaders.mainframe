import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BOARD_STANDING_NOTICE, EXPECTATION_WORD, boardStaleBand, courtAnnouncement, courtExpectation,
  expectationMeaning, freshnessLine, healthLine, lightsLine, nextLine, partialBoardNotice,
  startedLine,
} from "./monitoringCopy";
import { forgetClubZone } from "./clubZone";
import type { ControlBoardCourt } from "./adminApi";

/**
 * What the Control Board is allowed to claim.
 *
 * <p>
 * Every case here is an HONESTY claim rather than a wording one. The board is going on a wall
 * tablet in a club, and the one thing that would make it worse than no board at all is a tile
 * that says a court is lit when the software has no way of knowing. `IRelayClient` is not
 * registered in the container; the court box is pull-only; the heartbeat response carries no
 * relay state. So every sentence below is tested for what it refuses to say.
 * </p>
 */

const CLUB = "Africa/Johannesburg";

/** The club's own zone, a club ten hours ahead, and a DST club west of UTC. */
const RUNNER_ZONES = ["Africa/Johannesburg", "Pacific/Auckland", "America/Chicago"] as const;
const realTz = process.env.TZ;
afterAll(() => { process.env.TZ = realTz; });

function court(overrides: Partial<ControlBoardCourt> = {}): ControlBoardCourt {
  return {
    court_id: "c1", court_number: 2, name: "Court 2", is_active: true,
    lights: null, current: null, next: null, device: { link: "online", last_seen_at: new Date().toISOString() },
    ...overrides,
  };
}

describe("what the club EXPECTS, from bookings and check-ins", () => {
  it("is free when nothing is booked", () => {
    expect(courtExpectation(court())).toBe("free");
  });

  it("is lit once somebody has identified at the box", () => {
    expect(courtExpectation(court({ current: { kind: "booking", checked_in_at: "2026-09-22T16:03:00Z" } })))
      .toBe("lit");
  });

  it("is due, not lit, when a booking covers now and nobody has arrived", () => {
    expect(courtExpectation(court({ current: { kind: "booking", checked_in_at: null } }))).toBe("due");
  });

  it("takes the no-show from the server's own sweep, never from its own arithmetic", () => {
    // The grace window that matters is the one the sweep actually used. A second window
    // computed on this screen would disagree with the penalty the member was charged.
    expect(courtExpectation(court({ current: { kind: "booking", checked_in_at: null, status: "no_show" } })))
      .toBe("no_show");
  });

  it("says HELD for a club hold rather than calling it a booking", () => {
    expect(courtExpectation(court({ current: { kind: "block", label: "League night" } }))).toBe("held");
    expect(courtExpectation(court({ current: { kind: "schedule", label: "League night" } }))).toBe("held");
  });

  /**
   * The rule that outranks all of the above: a court whose box has stopped calling in is
   * UNKNOWN whatever the booking says. "Should be lit" is a claim about the present, and the
   * present is exactly what the server has stopped hearing about.
   */
  it("is unknown when the box is silent, however confident the booking looks", () => {
    const checkedIn = { kind: "booking", checked_in_at: "2026-09-22T16:03:00Z" };
    expect(courtExpectation(court({ current: checkedIn, device: { link: "offline" } }))).toBe("unknown");
    expect(courtExpectation(court({ current: checkedIn, device: { link: "unlinked" } }))).toBe("unknown");
    expect(courtExpectation(court({ current: checkedIn, device: { link: "out_of_service" } }))).toBe("unknown");
  });

  /**
   * The mutant this kills: treating an ABSENT `link` as silence. Three backend lanes are
   * building this payload; the day the frontend ships ahead of the field, every tile in the
   * club would go UNKNOWN and an admin would go looking for four boards that are fine.
   */
  it("does not read a field the API has not shipped as a dead board", () => {
    expect(courtExpectation(court({ current: { kind: "booking", checked_in_at: "2026-09-22T16:03:00Z" }, device: {} })))
      .toBe("lit");
    expect(courtExpectation(court({ current: null, device: null }))).toBe("free");
  });

  it("gives every state a word, because a wall is read across a room", () => {
    // Never colour alone: under forced colours the fills are discarded and these are all that
    // is left, and a colour-blind admin reads DUE and NO-SHOW rather than amber and red.
    for (const word of Object.values(EXPECTATION_WORD)) expect(word).toMatch(/[A-Z]/);
    expect(EXPECTATION_WORD.lit).toBe("SHOULD BE LIT");
    expect(EXPECTATION_WORD.lit).not.toMatch(/^LIT$/);
  });

  it("says both halves under DUE — what is expected AND that nobody is there", () => {
    expect(expectationMeaning("due", 5)).toContain("nobody has identified");
    expect(expectationMeaning("due", 5)).toContain("5 minutes of grace");
    // And when the club's grace window is not known, the sentence drops the clause rather
    // than printing "null minutes of grace".
    expect(expectationMeaning("due", null)).toContain("nobody has identified");
    expect(expectationMeaning("due", null)).not.toMatch(/null|undefined|NaN/);
  });

  it("explains UNKNOWN as a fact about the box, not as a fact about the court", () => {
    expect(expectationMeaning("unknown", null)).toContain("has not called in");
  });
});

describe.each(RUNNER_ZONES)("what the BOX last said, with the reader's browser in %s", (runnerZone) => {
  beforeEach(() => { process.env.TZ = runnerZone; forgetClubZone(); });

  const ON = "2026-09-22T16:00:31Z"; // 18:00 club time

  /**
   * <b>Only the BOX's own report licenses the word "confirmed", and nothing else does.</b>
   *
   * <p>
   * This case was written the other way round first — `stale === false` read as confirmation
   * — and checking it against the merged backend showed it was wrong in the direction that
   * matters. `stale` is a fact about how recent the SERVER's record is, i.e. about the
   * activation the API granted; it says nothing whatever about a relay. Every board in the
   * field reports no relay state until the new firmware ships, so that reading would have
   * printed "confirmed by the box" across a whole club on day one — on a wall, in a club,
   * which is the exact failure this surface exists to prevent.
   * </p>
   */
  it("says confirmed only when the box itself reported, never from the server's own freshness", () => {
    expect(lightsLine({ state: "on", stale: false, as_of: ON, confirmed_at: ON, confirmed_state: "on" }, CLUB))
      .toBe("Lights on — confirmed by the box at 18:00.");

    const unconfirmed = lightsLine({ state: "on", stale: false, as_of: ON }, CLUB)!;
    expect(unconfirmed, "confirmation manufactured out of the server's own record")
      .not.toContain("confirmed by the box");
    expect(unconfirmed).toContain("No box has confirmed it.");
  });

  /**
   * And where the two disagree, BOTH are shown. A box reporting a relay open while the club's
   * records say it granted nothing is the contradiction an admin is standing there to see,
   * not one the screen should resolve by picking a side and losing the evidence.
   */
  it("shows the disagreement rather than resolving it", () => {
    const said = lightsLine({ state: "off", stale: false, as_of: ON, confirmed_at: ON, confirmed_state: "on" }, CLUB)!;
    expect(said).toContain("The box says the lights are on");
    expect(said).toContain("the club's records say off");
    expect(said).toContain("They do not agree.");
  });

  it("never asserts a relay it has not heard about, and says when it last did", () => {
    const said = lightsLine({ state: "on", stale: true, as_of: ON }, CLUB)!;
    expect(said, "an unqualified ON on a wall screen").not.toMatch(/^Lights on\b/);
    expect(said).toContain("nothing has confirmed it");
    expect(said).toContain("18:00");
  });

  /**
   * The third arm, and the reason it exists. `stale` is absent from an API that has not
   * shipped the field. Reading absent as `false` would print "confirmed by the box" over a
   * reading nothing has confirmed — the screen manufacturing certainty out of a gap.
   */
  it("makes no freshness claim at all when the API has not shipped the field", () => {
    const said = lightsLine({ state: "on", as_of: ON }, CLUB)!;
    expect(said, "confirmed, out of an absent field").not.toContain("confirmed");
    expect(said, "stale, out of an absent field").not.toContain("nothing has confirmed");
    expect(said).toBe("The club's records say the lights went on at 18:00.");
  });

  it("says nobody knows, rather than nothing, for an unknown relay", () => {
    expect(lightsLine({ state: "unknown" }, CLUB)).toContain("Nobody knows");
  });

  it("renders no line at all rather than an empty one when there is no reading", () => {
    expect(lightsLine(null, CLUB)).toBeNull();
    expect(lightsLine(undefined, CLUB)).toBeNull();
  });

  it("names all three people when the scanner is not the booker", () => {
    const said = startedLine(
      { checked_in_at: ON, booked_by: { user_id: "u1", name: "Thandi Mokoena" } },
      { state: "on", turned_on_by: { user_id: "u2", name: "Jason Fourie", kind: "walk_up" } },
      CLUB,
    );
    expect(said).toBe("Started 18:00 — Jason Fourie scanned, booked by Thandi Mokoena.");
  });

  it("does not name the same person twice when they are the same person", () => {
    const said = startedLine(
      { checked_in_at: ON, booked_by: { user_id: "u1", name: "Thandi Mokoena" } },
      { state: "on", turned_on_by: { user_id: "u1", name: "Thandi Mokoena", kind: "member" } },
      CLUB,
    );
    expect(said).toBe("Started 18:00 (scanned).");
  });

  it("says nothing about a start that has not happened", () => {
    expect(startedLine({ checked_in_at: null }, null, CLUB)).toBeNull();
    expect(startedLine(null, null, CLUB)).toBeNull();
  });

  it("says the court is free afterwards rather than leaving the line blank", () => {
    expect(nextLine(null, CLUB)).toBe("Nothing booked after this.");
    expect(nextLine({ starts_at: ON, booked_by: { user_id: "u1", name: "Sipho D." } }, CLUB))
      .toBe("Next 18:00 · Sipho D.");
    // A club hold has no booker and its label is what a member would see on the grid.
    expect(nextLine({ starts_at: ON, label: "League night" }, CLUB)).toBe("Next 18:00 · League night");
  });
});

describe("the health strip, and how fresh the page itself is", () => {
  const NOW = Date.parse("2026-09-22T16:00:31Z");

  it("names the board, its link in words, and how long ago it spoke", () => {
    expect(healthLine(
      { name: "Box 1-4", link: "online", last_seen_at: "2026-09-22T16:00:19Z" }, NOW, "Box",
    )).toBe("Box 1-4 · online · heard 12s ago");
  });

  it("gives the state that has no name today one — quiet, between online and gone", () => {
    expect(healthLine({ name: "Box 1-4", link: "silent", last_seen_at: "2026-09-22T15:59:00Z" }, NOW, "Box"))
      .toContain("quiet");
  });

  it("says a board has never been heard from rather than printing 'never ago'", () => {
    expect(healthLine({ name: "Box 1-4", link: "offline", last_seen_at: null }, NOW, "Box"))
      .toBe("Box 1-4 · not reporting · never heard from");
  });

  it("renders no row for a court that has no board, rather than a row about nothing", () => {
    expect(healthLine(null, NOW, "Door")).toBeNull();
  });

  /**
   * Four modes, stated, because this audience cannot infer any of them — and because a
   * number on a wall with no qualifier is the defect the whole page is built against.
   */
  it("says which way it is getting its updates, in all four modes", () => {
    expect(freshnessLine("connecting", 10, null)).toContain("Connecting");
    expect(freshnessLine("live", 10, "18:04")).toMatch(/^Live/);
    expect(freshnessLine("polling", 10, "18:04")).toContain("every 10 seconds");
    expect(freshnessLine("polling", 10, "18:04"), "why it is polling").toContain("live connection dropped");
    expect(freshnessLine("lost", 10, "18:04")).toContain("read at 18:04");
  });

  it("never claims a read time it does not have", () => {
    for (const mode of ["live", "polling", "lost"] as const) {
      expect(freshnessLine(mode, 10, null)).not.toMatch(/null|undefined/);
    }
    expect(boardStaleBand(null)).toBe("Can't reach the club, and nothing has been read yet.");
  });

  it("names the silent box rather than counting it", () => {
    const tile = (n: number, box: string | null) => ({
      court_id: `c${n}`, name: `Court ${n}`, device: box ? { device_id: box, device_code: box } : null,
    });
    expect(partialBoardNotice([tile(2, "b1")], "18:31")).toContain("Court 2's box hasn't called in");
    expect(partialBoardNotice([tile(2, "b1"), tile(3, "b2")], "18:31")).toContain("2 boxes haven't called in");
    expect(partialBoardNotice([], "18:31"), "a notice about nothing").toBeNull();
  });

  /** R4 A4-5: one box drives up to four courts; one silent box read "4 boxes haven't called in". */
  it("counts silent boxes, not tiles", () => {
    const tile = (n: number, box: string | null) => ({
      court_id: `c${n}`, name: `Court ${n}`, device: box ? { device_id: box, device_code: box } : null,
    });
    const one = partialBoardNotice([tile(1, "b1"), tile(2, "b1"), tile(3, "b1"), tile(4, "b1")], "18:31");
    expect(one).toContain("The box for Court 1, Court 2, Court 3 and Court 4 hasn't called in");
    expect(one).not.toContain("4 boxes");
    expect(partialBoardNotice([tile(1, "b1"), tile(2, "b1"), tile(3, null)], null)).toContain("2 boxes haven't called in");
  });

  it("says out loud what the board is, and that lights cannot be switched from it", () => {
    expect(BOARD_STANDING_NOTICE).toContain("what should be happening");
    expect(BOARD_STANDING_NOTICE).toContain("do not report back");
  });
});

describe("what a screen reader is told", () => {
  it("speaks the state and the time left, once, as one sentence", () => {
    expect(courtAnnouncement("Court 2", "lit", 24)).toBe("Court 2, should be lit, 24 minutes left.");
  });

  it("gets the singular right at one minute", () => {
    expect(courtAnnouncement("Court 2", "lit", 1)).toBe("Court 2, should be lit, 1 minute left.");
  });

  it("says nothing about a countdown there isn't one of", () => {
    expect(courtAnnouncement("Court 2", "free", null)).toBe("Court 2, free.");
  });
});
