import { describe, expect, it } from "vitest";
import type { AdminDevice } from "./api";
import {
  coverageWithout, listCourts, outOfServiceConfirm, outOfServiceConsequences, type CourtCoverage,
} from "./deviceCoverage";

/**
 * The whole number matrix of the Devices screen's out-of-service copy, in one place.
 *
 * <p>
 * <b>Why exhaustively, and why here.</b> Three rounds each shipped one more sentence on that
 * screen and one more way for it to disagree with itself about number, and every one of them
 * was green the day it shipped — because each sentence was pinned by whichever rendered fixture
 * the round happened to build, and the arms nobody rendered had never once been executed.
 * Round 9's verifier proved that directly: forcing `pronoun()` to always return "it" left
 * vitest at 485/485 and the whole Playwright suite at 230/230, so the screen could confirm
 * "…their no-shows stop being penalised" and then say "bookings on it are refunded" one line
 * below with both suites green. In the same state, a single quiet box driving two courts told
 * an admin "the other boxes that drive them have gone quiet" — the wrong number of boxes to go
 * and walk to, on a screen whose entire job is saying which hardware to look at.
 * </p>
 *
 * <p>
 * So these are exact strings over every arm, not substrings over one: one court / many courts ×
 * one box / many boxes × shut / quiet / covered. A page test cannot do this — it can only reach
 * the corners a rendered fixture happens to produce — and that is precisely how the arms got
 * shipped unexecuted. The rendered tests in `AdminDevices.test.tsx` stay, and answer the other
 * question: that the page feeds this real coverage rather than a hand-built one.
 * </p>
 */

const shutOnly = (courts: number[]): CourtCoverage =>
  ({ shut: courts, unattested: [], covered: [], quietBoxes: 0, reportingBoxes: 0 });

const quietOnly = (courts: number[], boxes: number): CourtCoverage =>
  ({ shut: [], unattested: courts, covered: [], quietBoxes: boxes, reportingBoxes: 0 });

const coveredOnly = (courts: number[], boxes: number): CourtCoverage =>
  ({ shut: [], unattested: [], covered: courts, quietBoxes: 0, reportingBoxes: boxes });

describe("listCourts", () => {
  it("names one, two and three courts the way a sentence needs them", () => {
    expect(listCourts([1])).toBe("court 1");
    expect(listCourts([1, 2])).toBe("courts 1 and 2");
    expect(listCourts([1, 2, 4])).toBe("courts 1, 2 and 4");
  });
});

describe("outOfServiceConsequences — the shut-door sentence", () => {
  it("agrees with the number of courts", () => {
    expect(outOfServiceConsequences(shutOnly([1]))).toEqual([
      "No box in service drives court 1, so the API turns that hardware away: no scan, walk-up"
      + " or activation from it reaches the club. The courtside PIN, QR and fingerprint terminal"
      + " is a different machine and still checks members in there. Bookings on it nobody checks"
      + " in on are refunded in full with no no-show penalty, from the instant the switch was"
      + " thrown until a box is back in service.",
    ]);
    expect(outOfServiceConsequences(shutOnly([1, 2]))).toEqual([
      "No box in service drives courts 1 and 2, so the API turns that hardware away: no scan,"
      + " walk-up or activation from it reaches the club. The courtside PIN, QR and fingerprint"
      + " terminal is a different machine and still checks members in there. Bookings on them"
      + " nobody checks in on are refunded in full with no no-show penalty, from the instant the"
      + " switch was thrown until a box is back in service.",
    ]);
  });

  /**
   * <b>It does not say nobody can check in there, because that was never true.</b>
   *
   * <p>
   * The claim shipped for three rounds and read as the whole point of the branch. The 403 it
   * rested on is `DeviceIdentity.ResolveAsync`'s, which guards the four `/api/v1/device/`
   * routes and nothing else; the three `/api/v1/court/` match routes resolve
   * `Courts.CourtNumber` and never read a `Device` row, and the match they make runs
   * `CourtActivationService.ActivateAsync`, which charges the member and stamps `CheckedInAt`.
   * So an admin who believed this sentence had no way to understand a member being charged at
   * a court the screen had told them was closed.
   * </p>
   *
   * <p>
   * Asserted as an absence over every arm rather than left implicit in the equality above,
   * because the equality goes red on any edit at all and says nothing about which edit
   * mattered. This one names the sentence that must not come back.
   * </p>
   */
  it("does not tell an admin nobody can check in there", () => {
    for (const courts of [[1], [1, 2], [1, 2, 4]]) {
      const [sentence] = outOfServiceConsequences(shutOnly(courts));
      expect(sentence).not.toContain("nobody can check in");
      expect(sentence).not.toContain("no one can check in");
      expect(outOfServiceConfirm(shutOnly(courts))).not.toContain("check in there");
      // And it says who still can, or the qualifier on the money clause reads as pedantry
      // rather than as the reason it is there.
      expect(sentence).toContain("courtside PIN, QR and fingerprint terminal");
    }
  });

  /**
   * <b>The waiver is dated from the switch, and the sentence has to say so.</b>
   *
   * <p>
   * Round 9 shipped this promise unqualified while `DoorWasShutFor` read the switched-off
   * board's last heartbeat as the switch-off instant, so the ledger delivered it
   * `offline_after_seconds` later — 180 s at the shipped 60 s cadence. A grace deadline in
   * that window was charged the 30% the screen had just said it would not be. The backend now
   * records `devices.OutOfServiceSince` and answers from it; this pins the console's half of
   * the same fact, so the sentence cannot go back to being silent about when.
   * </p>
   */
  it("dates the waiver from the switch rather than leaving it to be assumed", () => {
    for (const courts of [[1], [1, 2]]) {
      expect(outOfServiceConsequences(shutOnly(courts))[0])
        .toContain("from the instant the switch was thrown until a box is back in service");
      expect(outOfServiceConfirm(shutOnly(courts))).toContain("from that instant");
    }
  });

  /**
   * The refund is for the bookings nobody checked in on — `NoShowWorker` sweeps
   * `b.CheckedInAt == null` and nothing else — so the promise is qualified rather than flat.
   * Flat, it is false for exactly the member who used the courtside terminal and was charged.
   */
  it("promises the refund only for the bookings nobody checks in on", () => {
    expect(outOfServiceConsequences(shutOnly([1]))[0])
      .toContain("Bookings on it nobody checks in on are refunded in full");
    expect(outOfServiceConsequences(shutOnly([1, 2]))[0])
      .toContain("Bookings on them nobody checks in on are refunded in full");
  });
});

/**
 * The clause round 9 got wrong. It names BOXES and counts them, and it names COURTS and counts
 * those separately, inside one em-dash aside — so all four cells differ and all four are here.
 * The two diagonal cells are the ones that were live and false: one box on two courts said
 * "boxes … drive … have", two boxes on one court said "box … drives … has".
 */
describe("outOfServiceConsequences — the quiet-box sentence", () => {
  it("one quiet box, one court", () => {
    expect(outOfServiceConsequences(quietOnly([1], 1))).toEqual([
      "Nothing in service is reporting on court 1 — the other box that drives it has gone quiet —"
      + " so bookings on it are refunded in full with no no-show penalty until one calls in again.",
    ]);
  });

  it("one quiet box driving two courts still names ONE box", () => {
    expect(outOfServiceConsequences(quietOnly([1, 2], 1))).toEqual([
      "Nothing in service is reporting on courts 1 and 2 — the other box that drives them has gone"
      + " quiet — so bookings on them are refunded in full with no no-show penalty until one calls"
      + " in again.",
    ]);
  });

  it("two quiet boxes on one court name BOTH boxes", () => {
    expect(outOfServiceConsequences(quietOnly([1], 2))).toEqual([
      "Nothing in service is reporting on court 1 — the other boxes that drive it have gone quiet"
      + " — so bookings on it are refunded in full with no no-show penalty until one calls in again.",
    ]);
  });

  it("two quiet boxes, two courts", () => {
    expect(outOfServiceConsequences(quietOnly([1, 2], 2))).toEqual([
      "Nothing in service is reporting on courts 1 and 2 — the other boxes that drive them have"
      + " gone quiet — so bookings on them are refunded in full with no no-show penalty until one"
      + " calls in again.",
    ]);
  });
});

/**
 * The same trap on the reassuring branch, and it was live too: this named boxes in the plural
 * whatever the count, so the commonest shape in a four-box club — one spare, still reporting —
 * told an admin there were several.
 */
describe("outOfServiceConsequences — the covered sentence", () => {
  it("one reporting box, one court", () => {
    expect(outOfServiceConsequences(coveredOnly([1], 1))).toEqual([
      "Another box is still reporting on court 1, so its no-shows are judged as normal.",
    ]);
  });

  it("one reporting box, two courts", () => {
    expect(outOfServiceConsequences(coveredOnly([1, 2], 1))).toEqual([
      "Another box is still reporting on courts 1 and 2, so their no-shows are judged as normal.",
    ]);
  });

  it("two reporting boxes, one court", () => {
    expect(outOfServiceConsequences(coveredOnly([1], 2))).toEqual([
      "Other boxes are still reporting on court 1, so its no-shows are judged as normal.",
    ]);
  });

  it("two reporting boxes, two courts", () => {
    expect(outOfServiceConsequences(coveredOnly([1, 2], 2))).toEqual([
      "Other boxes are still reporting on courts 1 and 2, so their no-shows are judged as normal.",
    ]);
  });
});

describe("outOfServiceConsequences — all three at once", () => {
  it("says one sentence per outcome, in shut / quiet / covered order, and nothing for an empty one", () => {
    expect(outOfServiceConsequences({
      shut: [1], unattested: [2], covered: [3], quietBoxes: 1, reportingBoxes: 1,
    })).toEqual([
      "No box in service drives court 1, so the API turns that hardware away: no scan, walk-up"
      + " or activation from it reaches the club. The courtside PIN, QR and fingerprint terminal"
      + " is a different machine and still checks members in there. Bookings on it nobody checks"
      + " in on are refunded in full with no no-show penalty, from the instant the switch was"
      + " thrown until a box is back in service.",
      "Nothing in service is reporting on court 2 — the other box that drives it has gone quiet —"
      + " so bookings on it are refunded in full with no no-show penalty until one calls in again.",
      "Another box is still reporting on court 3, so its no-shows are judged as normal.",
    ]);
    expect(outOfServiceConsequences({
      shut: [], unattested: [], covered: [], quietBoxes: 0, reportingBoxes: 0,
    })).toEqual([]);
  });
});

describe("outOfServiceConfirm", () => {
  it("stays plain when the click strands nothing", () => {
    expect(outOfServiceConfirm(coveredOnly([1, 2], 1)))
      .toBe("Out of service? The box stops switching lights on.");
  });

  it("agrees with the number of courts on the shut clause", () => {
    expect(outOfServiceConfirm(shutOnly([1])))
      .toBe("Out of service? Nothing else drives court 1 — the API stops taking anything from"
        + " that box, and from that instant its no-shows stop being penalised.");
    expect(outOfServiceConfirm(shutOnly([1, 2])))
      .toBe("Out of service? Nothing else drives courts 1 and 2 — the API stops taking anything"
        + " from that box, and from that instant their no-shows stop being penalised.");
  });

  it("agrees with the number of courts on the quiet clause", () => {
    expect(outOfServiceConfirm(quietOnly([2], 1)))
      .toBe("Out of service? No other box on court 2 is reporting, so its no-shows stop being"
        + " penalised.");
    expect(outOfServiceConfirm(quietOnly([2, 3], 1)))
      .toBe("Out of service? No other box on courts 2 and 3 is reporting, so their no-shows stop"
        + " being penalised.");
  });

  /**
   * Deliberate, and the one place on this screen where a bare singular "box" is right beside
   * several boxes: "No other box … is reporting" is a negative quantifier, so it does not
   * pluralise on the box count the way the row notice's positive "the other boxes … have gone
   * quiet" must. Pinned so that a later round fixing the row notice does not "fix" this too.
   */
  it("does not pluralise its negative quantifier on the box count", () => {
    expect(outOfServiceConfirm(quietOnly([2], 3))).toBe(outOfServiceConfirm(quietOnly([2], 1)));
  });

  it('adds " too" only when it is the second clause', () => {
    expect(outOfServiceConfirm({
      shut: [1], unattested: [2], covered: [], quietBoxes: 1, reportingBoxes: 0,
    })).toBe("Out of service? Nothing else drives court 1 — the API stops taking anything from"
      + " that box, and from that instant its no-shows stop being penalised. No other box on"
      + " court 2 is reporting, so its no-shows stop being penalised too.");
  });

  it("says nothing about the courts that stay covered", () => {
    expect(outOfServiceConfirm({
      shut: [1], unattested: [], covered: [2, 3], quietBoxes: 0, reportingBoxes: 2,
    })).toBe("Out of service? Nothing else drives court 1 — the API stops taking anything from"
      + " that box, and from that instant its no-shows stop being penalised.");
  });
});

// --- coverageWithout: the counts the sentences above are handed -----------------------------

const device = (over: Partial<AdminDevice> & { id: string }): AdminDevice => ({
  device_code: `code-${over.id}`,
  name: `Box ${over.id}`,
  kind: "CourtBox",
  hardware: "wemos-mega",
  court_numbers: [],
  gate_key: null,
  mac_address: null,
  enabled: true,
  last_seen_at: null,
  last_ip_address: null,
  created_at: "2026-01-01T00:00:00Z",
  ...over,
} as AdminDevice);

/** Reporting unless the fixture named it quiet. */
const reportingExcept = (...quiet: string[]) => (d: AdminDevice) => !quiet.includes(d.id);

describe("coverageWithout", () => {
  it("splits a box's courts into shut, quiet and covered", () => {
    const subject = device({ id: "a", court_numbers: [1, 2, 3] });
    const devices = [
      subject,
      device({ id: "b", court_numbers: [2] }),            // quiet
      device({ id: "c", court_numbers: [3] }),            // reporting
      device({ id: "d", court_numbers: [1], enabled: false }), // out of service: not cover
    ];

    expect(coverageWithout(subject, devices, reportingExcept("b"))).toEqual({
      shut: [1], unattested: [2], covered: [3], quietBoxes: 1, reportingBoxes: 1,
    });
  });

  /**
   * The wiring the sentence matrix above cannot see, and the half that made round 9's clause
   * wrong in the FIRST direction: one box, two courts. The copy has to be handed 1, not 2.
   */
  it("counts one quiet box once however many of this box's courts it drives", () => {
    const subject = device({ id: "a", court_numbers: [1, 2] });
    const devices = [subject, device({ id: "b", court_numbers: [1, 2] })];

    expect(coverageWithout(subject, devices, reportingExcept("b"))).toEqual({
      shut: [], unattested: [1, 2], covered: [], quietBoxes: 1, reportingBoxes: 0,
    });
  });

  /** And the other direction: two quiet boxes on one court are two boxes to walk to. */
  it("counts every quiet box that drives a stranded court", () => {
    const subject = device({ id: "a", court_numbers: [1] });
    const devices = [
      subject,
      device({ id: "b", court_numbers: [1] }),
      device({ id: "c", court_numbers: [1] }),
    ];

    expect(coverageWithout(subject, devices, reportingExcept("b", "c"))).toEqual({
      shut: [], unattested: [1], covered: [], quietBoxes: 2, reportingBoxes: 0,
    });
  });

  /**
   * Only the boxes that are actually reporting are counted as cover — a quiet box beside a
   * reporting one on the same court is not a second box "still reporting on" it.
   */
  it("counts only the reporting boxes on a covered court", () => {
    const subject = device({ id: "a", court_numbers: [1] });
    const devices = [
      subject,
      device({ id: "b", court_numbers: [1] }),
      device({ id: "c", court_numbers: [1] }),
    ];

    expect(coverageWithout(subject, devices, reportingExcept("c"))).toEqual({
      shut: [], unattested: [], covered: [1], quietBoxes: 0, reportingBoxes: 1,
    });
  });

  /**
   * The mirror of the two quiet-box cases above, on the reassuring branch — and the case that
   * survived this round's own first mutation sweep: with only one-box-one-court fixtures,
   * `reportingBoxes` and `covered.length` are the same number, so counting courts instead of
   * boxes was invisible. These are the two shapes where they differ.
   */
  it("counts one reporting box once however many of this box's courts it covers", () => {
    const subject = device({ id: "a", court_numbers: [1, 2] });
    const devices = [subject, device({ id: "b", court_numbers: [1, 2] })];

    expect(coverageWithout(subject, devices, reportingExcept())).toEqual({
      shut: [], unattested: [], covered: [1, 2], quietBoxes: 0, reportingBoxes: 1,
    });
  });

  it("counts every reporting box that covers one court", () => {
    const subject = device({ id: "a", court_numbers: [1] });
    const devices = [
      subject,
      device({ id: "b", court_numbers: [1] }),
      device({ id: "c", court_numbers: [1] }),
    ];

    expect(coverageWithout(subject, devices, reportingExcept())).toEqual({
      shut: [], unattested: [], covered: [1], quietBoxes: 0, reportingBoxes: 2,
    });
  });

  /**
   * The box's own row is excluded whatever its state, so the answer reads the same from an
   * enabled row ("what taking this out would strand") and a disabled one ("what is stranded
   * now") — including when the subject itself is the only box that is reporting.
   */
  it("never counts the box itself as its own cover", () => {
    const subject = device({ id: "a", court_numbers: [1] });
    expect(coverageWithout(subject, [subject], reportingExcept())).toEqual({
      shut: [1], unattested: [], covered: [], quietBoxes: 0, reportingBoxes: 0,
    });

    const disabled = device({ id: "a", court_numbers: [1], enabled: false });
    expect(coverageWithout(disabled, [disabled], reportingExcept())).toEqual({
      shut: [1], unattested: [], covered: [], quietBoxes: 0, reportingBoxes: 0,
    });
  });
});
