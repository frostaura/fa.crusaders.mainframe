import { describe, expect, it } from "vitest";
import { HEARTBEAT_FALLBACK_SECONDS, isOnline, offlineAfterSecondsFor, relative } from "./deviceLiveness";
import { OFFLINE_FLOOR_SECONDS, offlineAfterSeconds } from "./tenantSettings";
import { type AdminDevice } from "./api";

/**
 * The one liveness formula, pinned.
 *
 * <p>
 * <b>Why this file exists at all.</b> `relative()`, `isOnline()` and an
 * `offlineAfterSeconds()` were module-private in `pages/AdminDevices.tsx`, and that copy
 * multiplied the cadence by three WITHOUT the 180-second floor that
 * `lib/tenantSettings.ts`'s `offlineAfterSeconds` applies. Two screens therefore disagreed
 * about when a board is deaf, and a club on the 15-second minimum had one screen calling a
 * door offline after 45 seconds of ordinary jitter while the other waited 180. A third
 * screen must not inherit that, so the fork is deleted rather than copied — and the floor
 * is asserted here, on the arm where the two formulas actually differ.
 * </p>
 *
 * <p>
 * `relative()` takes `now` as an argument. Reading `Date.now()` inside it meant three ages
 * rendered in one paint could straddle a second boundary and print two different numbers for
 * one instant — and it made the ticking untestable without faking the clock.
 * </p>
 */

const AT = Date.parse("2026-09-19T09:00:00Z");

function gate(overrides: Partial<AdminDevice> = {}): AdminDevice {
  return {
    id: "99999999-9999-9999-9999-999999999999",
    device_code: "gate-0a1b2c",
    name: "Door gate",
    kind: "Gate",
    hardware: "Esp32",
    court_numbers: [],
    gate_key: null,
    mac_address: "5ccf7f0a1b2c",
    enabled: true,
    last_seen_at: new Date(AT).toISOString(),
    last_ip_address: null,
    created_at: new Date(AT).toISOString(),
    auto_registered: false,
    ...overrides,
  };
}

describe("relative", () => {
  it("counts from the instant it is given, not from the wall clock", () => {
    const seen = new Date(AT - 12_000).toISOString();
    expect(relative(seen, AT)).toBe("12 seconds ago");
    // The same string, a minute of wall time later, from the same input — which is only
    // possible because the caller owns the clock.
    expect(relative(new Date(AT + 48_000).toISOString(), AT + 60_000)).toBe("12 seconds ago");
  });

  it("steps through seconds, minutes, hours and days", () => {
    expect(relative(new Date(AT - 59_000).toISOString(), AT)).toBe("59 seconds ago");
    expect(relative(new Date(AT - 6 * 60_000).toISOString(), AT)).toBe("6 minutes ago");
    expect(relative(new Date(AT - 3 * 3_600_000).toISOString(), AT)).toBe("3 hours ago");
    expect(relative(new Date(AT - 2 * 86_400_000).toISOString(), AT)).toBe("2 days ago");
  });

  /**
   * A row that has never called in. "0s ago" would be a claim that it just did, and
   * `NaN` / `Invalid Date` is what a naive subtraction prints.
   */
  it("says never for a board that has never called in", () => {
    expect(relative(null, AT)).toBe("never");
    expect(relative(null, AT)).not.toContain("NaN");
  });
});

describe("offlineAfterSecondsFor", () => {
  it("takes the API's own threshold where the API sent one", () => {
    expect(offlineAfterSecondsFor(gate({ offline_after_seconds: 3600 }), 15)).toBe(3600);
  });

  it("prefers the interval the board reports over the club's wish, because the board clamps", () => {
    // 600 asked for, 300 run. Three beats of 300 is 900, and that is above the floor.
    expect(offlineAfterSecondsFor(gate({ effective_heartbeat_seconds: 300 }), 600)).toBe(900);
  });

  it("clamps an out-of-range club setting the way the firmware does", () => {
    expect(offlineAfterSecondsFor(gate(), 3600)).toBe(900);
  });

  it("falls back to the tenant default when nothing says otherwise", () => {
    expect(offlineAfterSecondsFor(gate(), null)).toBe(HEARTBEAT_FALLBACK_SECONDS * 3);
  });

  /**
   * <b>The arm the deleted fork got wrong.</b> A club on the 15-second minimum: three beats
   * is 45 seconds, and `tenantSettings.offlineAfterSeconds` floors that at 180 so ordinary
   * jitter is not an outage. AdminDevices' private copy did not, so the two screens called a
   * board deaf 135 seconds apart.
   */
  it("applies the 180-second floor, which is the whole reason the fork was a defect", () => {
    expect(offlineAfterSecondsFor(gate(), 15)).toBe(OFFLINE_FLOOR_SECONDS);
    expect(offlineAfterSecondsFor(gate({ effective_heartbeat_seconds: 15 }), 60)).toBe(OFFLINE_FLOOR_SECONDS);
  });

  it("is the tenantSettings formula and not a second one", () => {
    for (const configured of [1, 15, 30, 59, 60, 61, 120, 300, 600, 3600]) {
      expect(offlineAfterSecondsFor(gate(), configured)).toBe(offlineAfterSeconds(configured));
    }
  });
});

describe("isOnline", () => {
  it("is true inside the threshold and false outside it", () => {
    const seen = (s: number) => gate({ last_seen_at: new Date(AT - s * 1000).toISOString() });
    expect(isOnline(seen(179), 180, AT)).toBe(true);
    expect(isOnline(seen(181), 180, AT)).toBe(false);
  });

  it("is false for a board that has never called in, whatever the threshold", () => {
    expect(isOnline(gate({ last_seen_at: null }), 86_400, AT)).toBe(false);
  });
});
