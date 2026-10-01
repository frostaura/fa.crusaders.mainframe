import type {
  ControlBoardCourt, ControlBoardView, DeviceErrorPage, DeviceErrorRow,
} from "../lib/adminApi";

/**
 * Fixtures for the Monitoring surfaces.
 *
 * <p>
 * Kept out of `src/test/harness.tsx` on purpose: that file is shared by every lane building
 * this release, and a fixture added to it is a merge conflict in a file whose whole value is
 * that four screens agree about what the API answers. These are the shapes D2 §7 and §10
 * specify, and nothing here invents a field the wire does not have.
 * </p>
 *
 * <p>
 * <b>Every optional field is genuinely optional in the fixtures too.</b> The default court
 * below carries `stale`; {@link courtFixture} lets a test delete it, because "the backend has
 * not shipped this field yet" is a real state of this release and the screens have a third
 * arm for it that only a fixture without the field can exercise.
 * </p>
 */

/** 18:00:31 club time in Africa/Johannesburg on 22 September 2026. */
export const EVENING = "2026-09-22T16:00:31.000Z";
/** 18:45:00 club time — the end of the slot the default court is in. */
export const SLOT_END = "2026-09-22T16:45:00.000Z";

export function boardCourtFixture(overrides: Partial<ControlBoardCourt> = {}): ControlBoardCourt {
  return {
    court_id: "11111111-1111-1111-1111-111111111111",
    court_number: 2,
    name: "Court 2",
    is_active: true,
    lights: {
      state: "on",
      since: EVENING,
      until: SLOT_END,
      seconds_remaining: 1729,
      stale: false,
      as_of: EVENING,
      turned_on_by: { user_id: "u1", name: "Thandi Mokoena", kind: "member" },
    },
    current: {
      booking_id: "b1",
      starts_at: EVENING,
      ends_at: SLOT_END,
      status: "booked",
      kind: "booking",
      label: null,
      booked_by: { user_id: "u1", name: "Thandi Mokoena" },
      checked_in_at: EVENING,
      amount_minutes: 36,
    },
    next: {
      booking_id: "b2",
      starts_at: SLOT_END,
      minutes_until: 41,
      kind: "booking",
      booked_by: { user_id: "u2", name: "Sipho D." },
    },
    device: {
      device_id: "d1",
      device_code: "CB-01",
      name: "Box 1-4",
      relay: "B",
      link: "online",
      last_seen_at: EVENING,
      silent_seconds: 12,
      offline_after_seconds: 180,
      open_errors: { critical: 0, error: 0, warning: 1 },
    },
    door: null,
    ...overrides,
  };
}

export function boardFixture(overrides: Partial<ControlBoardView> = {}): ControlBoardView {
  return {
    generated_at: EVENING,
    timezone: "Africa/Johannesburg",
    slice_minutes: 15,
    club_day: "2026-09-22",
    courts: [boardCourtFixture()],
    ...overrides,
  };
}

export function deviceErrorFixture(overrides: Partial<DeviceErrorRow> = {}): DeviceErrorRow {
  return {
    id: "e1",
    device_id: "d1",
    device_code: "CB-01",
    device_name: "Box 1-4",
    device_kind: "CourtBox",
    source: "device",
    code: "scanner_timeout",
    severity: "error",
    detail: "GM65 no reply in 800ms",
    court: 1,
    first_seen_at: "2026-09-20T16:02:00.000Z",
    last_seen_at: EVENING,
    count: 47,
    resolved_at: null,
    resolved_by_name: null,
    resolution_note: null,
    headline: "The scanner stopped answering",
    ...overrides,
  };
}

export function deviceErrorPageFixture(
  rows: DeviceErrorRow[] = [deviceErrorFixture()],
  overrides: Partial<DeviceErrorPage> = {},
): DeviceErrorPage {
  return {
    rows,
    total: rows.length,
    cursor: null,
    retention_days: 90,
    timezone: "Africa/Johannesburg",
    counts: { critical: 0, error: 1, warning: 0, info: 0 },
    ...overrides,
  };
}
