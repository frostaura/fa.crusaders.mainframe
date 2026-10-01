import type { GroupAddRow, GroupAddResult, GroupWindow, MemberGroup, MemberBookingRules, Weekday } from "../lib/adminApi";

/**
 * Fixtures for member groups — GOAL items 3 + 19.
 *
 * <p>
 * <b>Scope-local, not in `src/test/harness.tsx`.</b> Six workers share that file in this wave
 * and a fixture added to it is a merge conflict for five of them. Everything here is about
 * groups and nothing else reads it.
 * </p>
 *
 * <p>
 * <b>The default group is UNRESTRICTED and INHERITS, because that is what the seed writes.</b>
 * `MemberGroupSeeder` creates both system groups with no window rows, no package discount (P13)
 * and null caps, so installing the feature changes nothing for any existing club. A fixture
 * that defaulted to a restricted group would let a test prove the screen handles a state no
 * club is ever in on the day of the migration — and, worse, would hide the one clause that
 * matters most: a group with NO windows at all is unrestricted, not silenced.
 * </p>
 */

export function groupFixture(overrides: Partial<MemberGroup> = {}): MemberGroup {
  return {
    id: "g-regular",
    name: "Regular",
    description: null,
    status: "active",
    sort_order: 0,
    is_system_default: true,
    caps: { max_slots_per_day: null, max_minutes_per_day: null, advance_booking_days: null },
    windows: [],
    member_count: 0,
    // D2 + P13, as the seed writes the Regular group: no system key, no package discount, no peak say.
    system_key: null,
    package_discount_bps: null,
    peak_priority: null,
    ...overrides,
  };
}

/** A window row, in the API's own weekday vocabulary and its `HH:mm` faces. */
export function windowFixture(day: Weekday, start: string, end: string): GroupWindow {
  return { day, start, end };
}

/**
 * The same times on several days — the shape an admin paints, written once.
 *
 * Spelling seven rows out at each call site is how a fixture ends up saying Wednesday twice
 * and never saying Thursday, which reads as a real rule and is a typo.
 */
export function weekdayWindows(days: Weekday[], start: string, end: string): GroupWindow[] {
  return days.map((day) => windowFixture(day, start, end));
}

/**
 * A group that restricts: weekday evenings only, at the court's own price.
 *
 * This is the "Non-league members" shape the GOAL describes and the seed deliberately does
 * NOT write — the restriction is the club's to author.
 */
export function restrictedGroupFixture(overrides: Partial<MemberGroup> = {}): MemberGroup {
  return groupFixture({
    id: "g-offpeak",
    name: "Off-peak",
    is_system_default: false,
    windows: weekdayWindows(["mon", "tue", "wed", "thu", "fri"], "06:00", "16:00"),
    ...overrides,
  });
}

/**
 * What `GET /admin/members/{id}/booking-rules` answers, at the club's own hours.
 *
 * <p>
 * `empty_window_reason` is absent rather than null by default, and that is the point: three
 * backend lanes are writing this endpoint, so the field may not have shipped. A fixture that
 * carried `null` would let the page's "there is nothing wrong" arm stand in for "the server
 * has not told us", which is the unknown-is-never-false trap in one field.
 * </p>
 */
export function bookingRulesFixture(overrides: Partial<MemberBookingRules> = {}): MemberBookingRules {
  return {
    groups: [{ id: "g-regular", name: "Regular", description: null }],
    allowed_windows: [{ start: "06:00", end: "22:00" }],
    // No `club_hours`: the server's booking-rules never sends it (pinned as it.fails in
    // adminResponses.contract.test.ts). The preview takes the club's hours from its settings.
    max_slots_per_day: 4,
    max_minutes_per_day: 60,
    advance_booking_days: 14,
    ...overrides,
  };
}

/**
 * One row of `GET /admin/member-groups/{id}/members`.
 *
 * `name`, not `full_name`: the row is an `AdminPerson` widened, and `AdminPerson.name` is what
 * every other admin surface in this codebase reads. A fixture spelling it the other way would
 * let the page render a blank name against a server that sends one.
 */
export function groupMemberFixture(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "44444444-4444-4444-4444-444444444444",
    name: "Ada Lovelace",
    photo_url: null,
    membership_number: "CR-0001",
    added_at: "2026-09-20T06:00:00Z",
    added_by_name: "Priya Naidoo",
    ...overrides,
  };
}

/**
 * `POST /member-groups/{id}/members`'s answer, key for key as `AddMembersAsync` writes it (pinned
 * in `adminResponses.contract.test.ts`): rows only, no counts (A4-2).
 */
export function groupAddResponse(rows: GroupAddRow[]): GroupAddResult {
  return { results: rows.map((row) => ({ user_id: row.user_id, result: row.result })) };
}
