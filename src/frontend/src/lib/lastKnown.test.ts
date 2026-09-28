import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import type { LastKnownDoor } from "./lastKnown";
import {
  LAST_KNOWN_KEY,
  LAST_KNOWN_VERSION,
  forgetLastKnown,
  minutesSince,
  readLastKnown,
  rememberDoor,
} from "./lastKnown";

/**
 * The page's own last-known-good store, and the whole of its offline design.
 *
 * <p>
 * The service worker returns false from `mayCache()` for anything under `/api/` and for
 * any request carrying an `authorization` header. Both guards are correct and must stay.
 * The consequence is that a member who opens the code page with no signal gets the shell
 * and nothing in it — no code, no door statement, no number to call — and "three states
 * for every read" then gives them three ways of saying nothing.
 * </p>
 *
 * <p>
 * So the page keeps its own record of the DOOR facts. The last door DECISION is never stored,
 * because a refusal from yesterday shown to somebody standing at a door tonight is worse than
 * an empty screen.
 * </p>
 *
 * <p>
 * <b>D1 — the code half, and its tests, are retired.</b> This store used to hold the last booking
 * or ident code (with an absolute expiry so it could never be drawn as live). The single rotating
 * code is made on the phone from a non-extractable key in IndexedDB (`lib/memberCode/`), so no
 * code is stored here at all, and the tests that pinned the stored code's expiry, its round-trip
 * and its separate timestamp went with it. What is asserted instead: a v3 record's code is
 * discarded, and nothing this store writes can carry one.
 * </p>
 */
describe("lastKnown", () => {
  beforeEach(() => forgetLastKnown());
  afterEach(() => vi.restoreAllMocks());

  const DOOR = {
    doors: true,
    // WIRE-R2 §4. Both are stored, and both have to be: a cached record that lost
    // `doors_shut` reads as "none", which is the page going back to promising a member that
    // a shut door opens for them — see LAST_KNOWN_VERSION's note on why v2 is discarded.
    doors_shut: "some" as const,
    timezone: "Africa/Johannesburg",
    policy: "booking_window" as const,
    membership: "active" as const,
    membership_detail: "active",
    is_club_admin: false,
    next_booking: {
      starts_at: "2026-09-19T17:00:00Z",
      ends_at: "2026-09-19T17:45:00Z",
      court_number: 3,
      door_opens_at: "2026-09-19T16:30:00Z",
      door_closes_at: "2026-09-19T18:05:00Z",
    },
    early_entry_minutes: 30,
    roster_max_entries: 48,
    contact: { phone: "021 555 0134", email: "info@crusaders.co.za" },
    door_log_retention_days: 90,
    last_decision: {
      at: "2026-09-19T06:04:00Z", delivered_at: null, door_name: "front-door", released: false,
      reason: "too_early", offline: false, opens_at: "2026-09-19T16:30:00Z",
    },
  };

  it("has nothing to say before anything has been stored", () => {
    expect(readLastKnown()).toEqual({ door: null });
  });

  it("round-trips the standing door facts", () => {
    rememberDoor(DOOR);
    const stored = readLastKnown().door;
    expect(stored?.value.policy).toBe("booking_window");
    expect(stored?.value.contact.phone).toBe("021 555 0134");
    expect(stored?.value.next_booking?.starts_at).toBe("2026-09-19T17:00:00Z");
  });

  /**
   * Every standing field the offline page reads for a SENTENCE, named one at a time.
   *
   * <p>
   * A round-trip that checks three keys passes just as happily when the other seven were
   * dropped, and what a member then reads is not an error — it is the standing line saying
   * "not active" over a suspended membership, or the offline note naming a roster cap of
   * `undefined`. Plausible prose is the failure mode this store has, so each field is
   * asserted rather than the object compared.
   * </p>
   */
  it.each([
    ["membership_detail", "active"],
    ["is_club_admin", false],
    ["early_entry_minutes", 30],
    ["roster_max_entries", 48],
    ["door_log_retention_days", 90],
    // WIRE-R2 §4. Dropping either is a sentence a member reads and acts on: a lost
    // `doors_shut` promises that a shut door opens, and a lost `timezone` silently puts
    // every cached clock face back on the VIEWER's day.
    ["doors_shut", "some"],
    ["timezone", "Africa/Johannesburg"],
  ])("remembers %s, which the page reads for a sentence", (key, expected) => {
    rememberDoor(DOOR);
    expect(readLastKnown().door!.value[key as keyof LastKnownDoor]).toBe(expected);
  });

  /** Both edges of the window and the court, so the cached standing line reads as the live one. */
  it("remembers the whole booking, not only when it starts", () => {
    rememberDoor(DOOR);
    expect(readLastKnown().door!.value.next_booking).toEqual(DOOR.next_booking);
  });

  /**
   * The decision is a MOMENT, not a standing fact. Showing a member a refusal from an
   * earlier visit because the network happens to be down now is the page inventing an
   * event, which is the one thing a screen about a lock may never do.
   */
  it("never stores the last decision", () => {
    rememberDoor(DOOR);
    expect(readLastKnown().door!.value).not.toHaveProperty("last_decision");
    expect(JSON.stringify(readLastKnown())).not.toContain("too_early");
  });

  it("stamps the door facts with the wall time they were saved at", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-19T06:05:00Z"));
    rememberDoor(DOOR);
    expect(readLastKnown().door!.savedAt).toBe("2026-09-19T06:05:00.000Z");
    vi.useRealTimers();
  });

  /** D1. A member code is a key in IndexedDB now; this store never holds one. */
  it("writes no code of any kind", () => {
    rememberDoor(DOOR);
    const raw = JSON.parse(window.localStorage.getItem(LAST_KNOWN_KEY)!);
    expect(Object.keys(raw).sort()).toEqual(["door", "version"]);
  });

  // --- storage that is not there, or lies -------------------------------------------

  /**
   * Private browsing throws on `setItem`; a locked-down profile throws on `getItem`; an
   * embedded webview can have no `localStorage` at all. None of those is a reason for the
   * page not to render, so every accessor is wrapped and a failure is simply "nothing
   * stored".
   */
  it("says nothing rather than throwing when reading storage is refused", () => {
    rememberDoor(DOOR);
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => readLastKnown()).not.toThrow();
    expect(readLastKnown().door).toBeNull();
  });

  it("carries on when writing to storage is refused", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => rememberDoor(DOOR)).not.toThrow();
  });

  it("carries on when clearing is refused", () => {
    vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => forgetLastKnown()).not.toThrow();
  });

  it("discards a record it cannot parse rather than crashing the page on it", () => {
    window.localStorage.setItem(LAST_KNOWN_KEY, "{ not json");
    expect(readLastKnown().door).toBeNull();
  });

  /**
   * A version bump discards the lot. The alternative is a shape from three releases ago
   * being read field-by-field by code that assumes the current one, which surfaces as a
   * blank card rather than as an error anybody can act on.
   */
  /** D1's bump: a v3 record carries the last legacy code, and none of it is read back. */
  it("discards a record written by an older version of this store, code and all", () => {
    rememberDoor(DOOR);
    const current = JSON.parse(window.localStorage.getItem(LAST_KNOWN_KEY)!);
    window.localStorage.setItem(LAST_KNOWN_KEY, JSON.stringify({
      ...current,
      version: LAST_KNOWN_VERSION - 1,
      qr: { savedAt: "2026-09-19T06:00:00.000Z", value: { code: "OLDCODE00000" } },
    }));
    expect(readLastKnown()).toEqual({ door: null });
    expect(JSON.stringify(readLastKnown())).not.toContain("OLDCODE00000");
  });

  it("discards a record with no version at all", () => {
    window.localStorage.setItem(LAST_KNOWN_KEY, JSON.stringify({ door: { savedAt: "x", value: DOOR } }));
    expect(readLastKnown().door).toBeNull();
  });

  /**
   * The bump that had to happen when the door record grew five fields.
   *
   * <p>
   * This is the case the counter exists for and the one that would otherwise pass every
   * other test in this file: a v1 door record parses cleanly, carries `policy`,
   * `membership` and `contact` exactly as the current shape does, and is then read for
   * five fields it has never held. The result is not a blank card — it is the standing line
   * telling a suspended member the club has theirs as "not active", and the offline note
   * naming a roster cap of `undefined`. Nothing about that looks like a bug to the person
   * reading it.
   * </p>
   */
  it("discards a door record written before the endpoint grew its five sentences", () => {
    window.localStorage.setItem(LAST_KNOWN_KEY, JSON.stringify({
      version: 1,
      qr: null,
      door: {
        savedAt: "2026-09-19T06:00:00.000Z",
        value: {
          doors: true,
          policy: "booking_window",
          membership: "not_active",
          next_booking: null,
          contact: { phone: "021 555 0134", email: null },
        },
      },
    }));
    expect(readLastKnown().door).toBeNull();
  });

  /** And the version this build writes is the one it reads back. */
  it("writes the current version", () => {
    rememberDoor(DOOR);
    const raw = JSON.parse(window.localStorage.getItem(LAST_KNOWN_KEY)!);
    expect(raw.version).toBe(LAST_KNOWN_VERSION);
    expect(LAST_KNOWN_VERSION).toBe(4);
  });

  it("forgets everything on request", () => {
    rememberDoor(DOOR);
    forgetLastKnown();
    expect(readLastKnown().door).toBeNull();
  });

  // --- how old is it ------------------------------------------------------------------

  it("counts whole minutes since a record was saved", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-19T06:09:00Z"));
    expect(minutesSince("2026-09-19T06:02:00.000Z")).toBe(7);
    expect(minutesSince("2026-09-19T06:08:30.000Z")).toBe(0);
    vi.useRealTimers();
  });

  /** A clock that has been dragged backwards must not report a record from the future. */
  it("never reports a negative age", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-19T06:00:00Z"));
    expect(minutesSince("2026-09-19T07:00:00.000Z")).toBe(0);
    vi.useRealTimers();
  });

  it("reports nothing readable as zero rather than as NaN minutes", () => {
    expect(minutesSince("not a date")).toBe(0);
  });
});
