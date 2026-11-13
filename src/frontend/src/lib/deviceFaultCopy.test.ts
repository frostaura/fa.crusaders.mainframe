import { describe, expect, it } from "vitest";
import {
  DEVICE_FAULT_CODES, SERVER_FAULT_CODES, SEVERITY_TONE, SEVERITY_WORD, explainFault,
  faultsEmptyNotice, faultsPartialNotice, occurrenceLine, resolveConfirm, resolvedLine, boardLabel, faultDetail,
} from "./deviceFaultCopy";
import { DEVICE_ERROR_SEVERITIES } from "./adminApi";

/**
 * The fault dictionary, and the one property that matters about it: it never goes dark.
 *
 * <p>
 * The defect this file is written against is on the record. The doors console held its own
 * dictionary of audit actions; the server's vocabulary moved; a door with thirteen admin
 * edits rendered "13 refused scans". A closed table is the right shape, and a closed table
 * with no fall-through is how a firmware release silently empties a monitoring page.
 * </p>
 */
describe("every code the server can write has words a volunteer can act on", () => {
  const ALL = [...DEVICE_FAULT_CODES, ...SERVER_FAULT_CODES];

  it.each(ALL)("%s says what it means and what to do", (code) => {
    const said = explainFault({ code, headline: null, detail: null });
    expect(said.unrecognised, `${code} has no entry`).toBe(false);
    expect(said.means.length, `${code} has no meaning`).toBeGreaterThan(20);
    expect(said.doThis.length, `${code} has no action`).toBeGreaterThan(20);
    // Not "check the logs", not "contact support": the audience is a volunteer standing in a
    // club at 19:00 holding a phone, and the sentence has to name something to walk to.
    expect(said.doThis).not.toMatch(/check the logs|contact support/i);
  });

  it.each(ALL)("%s never renders the word undefined", (code) => {
    const said = explainFault({ code, headline: null, detail: null });
    expect(`${said.title}${said.means}${said.doThis}`).not.toMatch(/undefined|null|NaN|\[object/);
  });

  it("prefers the SERVER's headline to anything held here", () => {
    // The server composes its own sentence from the code, and it is the one that moves when
    // the vocabulary moves. A console that preferred its own copy is the doors defect again.
    const said = explainFault({
      code: "scanner_timeout", headline: "The scanner stopped answering", detail: null,
    });
    expect(said.title).toBe("The scanner stopped answering");
  });

  /**
   * The fall-through, which is the whole point. A firmware release that adds a code must
   * produce something a person can read — never a blank row, never a dropped one.
   */
  it("renders a code it has never heard of, rather than dropping the row", () => {
    const said = explainFault({
      code: "flux_capacitor_drift", headline: null, detail: "coil at 88mph",
    });
    expect(said.unrecognised).toBe(true);
    expect(said.title).toContain("flux_capacitor_drift");
    expect(said.means, "the board's own words are better than nothing").toBe("coil at 88mph");
    expect(said.doThis).toContain("flux_capacitor_drift");
  });

  it("still says something when an unknown code arrives with no detail either", () => {
    const said = explainFault({ code: "mystery", headline: null, detail: null });
    expect(said.means).toContain("does not have a name for this one");
    expect(said.doThis).toContain("mystery");
  });

  it("uses the server's headline even for a code it does not know", () => {
    const said = explainFault({ code: "mystery", headline: "Something odd happened", detail: null });
    expect(said.title).toBe("Something odd happened");
    expect(said.unrecognised, "a headline is not an explanation").toBe(true);
  });
});

describe("severity, in words and never as a colour alone", () => {
  it("covers every severity the wire can carry", () => {
    for (const severity of DEVICE_ERROR_SEVERITIES) {
      expect(SEVERITY_WORD[severity]).toBeTruthy();
      expect(SEVERITY_TONE[severity]).toBeTruthy();
    }
  });

  it("says the CONSEQUENCE rather than the magnitude", () => {
    // "Critical" is a number in a costume. A volunteer triages against "stops people playing".
    expect(SEVERITY_WORD.critical).toBe("Stops people playing");
    expect(SEVERITY_WORD.warning).toBe("Works, but worse");
    expect(SEVERITY_WORD.info).toBe("Worth knowing");
  });
});

describe("what the page says about itself", () => {
  it("says the honest half of a failed read", () => {
    // An empty list after a failed read reads as "nothing is wrong", which is the trap this
    // whole surface exists inside: an empty collection is not an answer.
    const said = faultsEmptyNotice(4, 7);
    expect(said).toContain("No faults in the last 7 days");
    expect(said).toContain("All 4 of the club's boards have called in");
  });

  it("gets the singular right for a club with one board", () => {
    expect(faultsEmptyNotice(1, 7)).toContain("The club's one board has called in");
  });

  it("claims no board count it does not have", () => {
    expect(faultsEmptyNotice(null, null)).toBe("No faults recently.");
    expect(faultsEmptyNotice(null, 7)).toBe("No faults in the last 7 days.");
  });

  it("names the silent board rather than implying the list is complete", () => {
    expect(faultsPartialNotice(3, 4, ["Court box 2"]))
      .toBe("3 of 4 boards reported. Court box 2 hasn't called in, so anything wrong with it isn't here.");
    expect(faultsPartialNotice(4, 4, []), "a notice about nothing").toBeNull();
  });

  it("says resolving is a note, not a repair", () => {
    expect(resolveConfirm(1)).toContain("comes back if the board reports it again");
    expect(resolveConfirm(6)).toContain("Mark all 6 resolved");
    expect(resolveConfirm(6)).toContain("still happening come back");
  });

  it("writes the three numbers that separate a one-off from a fire", () => {
    expect(occurrenceLine(47, "20 Sept, 18:02", "4 minutes ago"))
      .toBe("47 times · first 20 Sept, 18:02 · last 4 minutes ago");
    expect(occurrenceLine(1, "20 Sept, 18:02", "20 Sept, 18:02")).toMatch(/^Once ·/);
  });

  it("keeps a resolved row readable rather than merely filtered away", () => {
    expect(resolvedLine("Priya Naidoo", "07:15", "replaced the scanner"))
      .toBe('Marked resolved by Priya Naidoo at 07:15. "replaced the scanner"');
    // Both halves of the conditional: a note nobody wrote is not an empty pair of quotes.
    expect(resolvedLine("Priya Naidoo", "07:15", null)).toBe("Marked resolved by Priya Naidoo at 07:15.");
    expect(resolvedLine("Priya Naidoo", "07:15", "   ")).toBe("Marked resolved by Priya Naidoo at 07:15.");
    expect(resolvedLine(null, "07:15", null)).toBe("Marked resolved at 07:15.");
  });
});

describe("review round 1, F3.7 — the faults page in words", () => {
  it("heads a board by name AND code, because every box is called Court box", () => {
    expect(boardLabel({ device_name: "Court box", device_code: "CB-01" })).toBe("Court box (CB-01)");
    expect(boardLabel({ device_name: null, device_code: "CB-02" })).toBe("CB-02");
  });

  it("explains restore_not_confirmed instead of printing it", () => {
    const said = explainFault({ code: "restore_not_confirmed", headline: "A court should be lit after a power cut and the box has not confirmed it", detail: null });
    expect(said.unrecognised).toBe(false);
    expect(`${said.title} ${said.means} ${said.doThis}`).not.toMatch(/restore_not_confirmed/);
  });


  it("says the relay detail as a sentence and a UTC instant in the club's time", () => {
    expect(faultDetail("served 4 relay(s), the box reported 0", "Africa/Johannesburg"))
      .toBe("The club's system expected 4 courts to be lit; the box reported none.");
    const said = faultDetail("clock was 2026-09-21T16:05:00Z", "Africa/Johannesburg");
    expect(said).not.toMatch(/T16:05|Z\b/);
    expect(said).toMatch(/18:05/);
  });
});

describe("the v3 faults and the door's own words (device-api §4, §13; BA-22)", () => {
  it.each(["boot", "mega_unacked", "relight_failed", "kind_mismatch", "screen_dropped"])("%s has its own words", (code) => {
    const said = explainFault({ code, headline: null, detail: null });
    expect(said.unrecognised, code).toBe(false);
    expect(said.doThis).not.toMatch(/Pass the code/);
  });

  it("explains a restart in words and turns its raw uptime into a sentence", () => {
    const fresh = explainFault({ code: "boot", headline: "The board restarted", detail: "uptime_ms=0" });
    expect(fresh.title).toBe("The board restarted");
    expect(fresh.means).not.toContain("uptime_ms");
    expect(fresh.means).toContain("It reported starting from zero");
    const later = explainFault({ code: "boot", headline: null, detail: "uptime_ms=11520000" });
    expect(later.means).toContain("It had been running for 3 h 12 min");
  });

  it("talks about doors, not courts, when a door stops reporting", () => {
    const door = explainFault({ code: "outage_opened", headline: null, detail: null, device_kind: "Gate" });
    expect(`${door.means} ${door.doThis}`).not.toMatch(/court/i);
    expect(door.means).toMatch(/door/i);
    const box = explainFault({ code: "outage_opened", headline: null, detail: null, device_kind: "CourtBox" });
    expect(box.doThis).toMatch(/its courts show as unknown/);
  });
});
