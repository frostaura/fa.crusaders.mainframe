import { describe, expect, it } from "vitest";
import { doorBookingHorizonBasis, doorBookingHorizonMinutes } from "./tenantSettings";

/**
 * C13 — not the number, but WHICH fields on screen produced it.
 *
 * <p>
 * The settings page prints "a booking QR opens a door from 130 minutes before the booking"
 * directly under a field reading "Early entry: 30", and reviewer C edited that field and
 * watched the sentence not move. It was not a stale render: under <code>active_member</code>
 * the number really is read from two OTHER fields, on a different card, under a heading that
 * says "Court boxes". Correct, unresponsive to the control beside it, and silent about why —
 * three properties that together read as a bug and send an admin to change the wrong number.
 * </p>
 *
 * <p>
 * The answer is not to make it respond to early entry, which would be a lie. It is to say
 * what it does respond to, which means the derivation has to be able to name its own inputs.
 * </p>
 */

const DEFAULTS = {
  gate_access_policy: "active_member",
  gate_early_entry_minutes: 30,
  roster_window_minutes: 120,
  activation_cue_window_minutes: 10,
};

describe("doorBookingHorizonBasis", () => {
  it("agrees with the number the page prints, in every case it reports", () => {
    const cases = [
      DEFAULTS,
      { ...DEFAULTS, gate_access_policy: "booking_window" },
      { ...DEFAULTS, gate_early_entry_minutes: 200 },
      { ...DEFAULTS, roster_window_minutes: 1440, activation_cue_window_minutes: 1440 },
      { ...DEFAULTS, gate_early_entry_minutes: Number.NaN },
    ];
    for (const settings of cases) {
      expect(doorBookingHorizonBasis(settings).minutes).toBe(doorBookingHorizonMinutes(settings));
    }
  });

  /** The strict policy: one field, on the same block, and the court windows play no part. */
  it("names early entry alone under the strict policy", () => {
    const basis = doorBookingHorizonBasis({
      ...DEFAULTS, gate_access_policy: "booking_window", gate_early_entry_minutes: 45,
    });

    expect(basis.minutes).toBe(45);
    expect(basis.from).toEqual(["gate_early_entry_minutes"]);
    expect(basis.courtWindowsMinutes).toBeNull();
    expect(basis.capped).toBe(false);
  });

  /** The default policy, at the API's own defaults: the two court fields, and NOT early entry. */
  it("names the two court-box windows under the open policy", () => {
    const basis = doorBookingHorizonBasis(DEFAULTS);

    expect(basis.minutes).toBe(130);
    expect(basis.from).toEqual(["roster_window_minutes", "activation_cue_window_minutes"]);
    expect(basis.floorGoverns).toBe(false);
    // The number an admin needs in order to understand why editing early entry did nothing.
    expect(basis.floorMinutes).toBe(30);
    expect(basis.courtWindowsMinutes).toBe(130);
  });

  /**
   * The floor, which is the half nobody guesses: raising early entry PAST the pair moves the
   * answer, lowering it below them does not. A sentence that named the court windows in both
   * cases would be wrong in one of them.
   */
  it("names early entry once it is the floor that wins", () => {
    const basis = doorBookingHorizonBasis({ ...DEFAULTS, gate_early_entry_minutes: 200 });

    expect(basis.minutes).toBe(200);
    expect(basis.from).toEqual(["gate_early_entry_minutes"]);
    expect(basis.floorGoverns).toBe(true);
    expect(basis.courtWindowsMinutes).toBe(130);
  });

  /** And the cap, which is the answer an admin is most likely to be surprised by. */
  it("reports the four-hour cap as a cap rather than as an arithmetic result", () => {
    const basis = doorBookingHorizonBasis({
      ...DEFAULTS, roster_window_minutes: 1440, activation_cue_window_minutes: 1440,
    });

    expect(basis.minutes).toBe(240);
    expect(basis.capped).toBe(true);

    // Exactly at the cap is not capped: the sentence would otherwise blame a bound that did
    // nothing, on the one setting where the admin got precisely what they asked for.
    const exact = doorBookingHorizonBasis({
      ...DEFAULTS, roster_window_minutes: 230, activation_cue_window_minutes: 10,
    });
    expect(exact.minutes).toBe(240);
    expect(exact.capped).toBe(false);
  });

  /**
   * An emptied box is NaN on this page while the admin retypes it. The API clamps on read,
   * so the sentence has to as well — quoting "NaN minutes" at somebody mid-keystroke is the
   * shape of failure the whole `toNumber` sentinel exists to avoid.
   */
  it("clamps a half-typed field the way the API would read it", () => {
    const basis = doorBookingHorizonBasis({ ...DEFAULTS, roster_window_minutes: Number.NaN });

    expect(Number.isFinite(basis.minutes)).toBe(true);
    // The roster floor is 5, plus the 10-minute cue, is below the 30-minute early-entry floor.
    expect(basis.minutes).toBe(30);
    expect(basis.from).toEqual(["gate_early_entry_minutes"]);
  });
});
