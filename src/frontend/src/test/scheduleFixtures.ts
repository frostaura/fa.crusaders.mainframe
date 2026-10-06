import type {
  AdminChangeRow, ScheduleConflict, ScheduleCreateResponse, ScheduleDetailResponse,
  ScheduleEndResponse, ScheduleOccurrence, ScheduleOccurrenceResponse, ScheduleOccurrencesResponse,
  SchedulePreview, ScheduleRow, ScheduleUpdateResponse,
} from "../lib/adminApi";
import type { StubRoute } from "./harness";
import { SETTINGS_FIXTURE } from "./harness";

/**
 * Fixtures for the repeating-bookings surface, scope-local on purpose.
 *
 * <p>
 * `src/test/harness.tsx` is shared by six workers writing this tree at once, so anything only
 * this surface needs lives here instead. What is taken from the harness is taken by import —
 * `SETTINGS_FIXTURE` above — rather than copied, because a fixture that drifts from the club's
 * real shipping settings is a test that proves something about a club nobody has.
 * </p>
 *
 * <p>
 * <b>Every optional field is genuinely optional here.</b> Three backend lanes are building
 * these endpoints in parallel, so the shapes below are written as the minimum D2 §11.8
 * promises, and the fields a page must not require — `would_refund_minutes`,
 * `next_occurrence`, `materialised_through` — are set only where a test
 * is about them. A fixture that always carries every field cannot fail the way production
 * will.
 * </p>
 */

/** The club whose settings these tests run against, unless a case says otherwise. */
export const SCHEDULE_SETTINGS = SETTINGS_FIXTURE;

export const COURT_IDS = {
  one: "c0000000-0000-0000-0000-000000000001",
  two: "c0000000-0000-0000-0000-000000000002",
  three: "c0000000-0000-0000-0000-000000000003",
} as const;

export function courtsFixture() {
  return [
    { id: COURT_IDS.one, court_number: 1, name: "Court 1", court_type: "Squash", is_active: true },
    { id: COURT_IDS.two, court_number: 2, name: "Court 2", court_type: "Squash", is_active: true },
    { id: COURT_IDS.three, court_number: 3, name: "Court 3", court_type: "Squash", is_active: true },
    // Inactive, and therefore not offerable: a court an admin cannot book one slot on is not a
    // court they may hold every Tuesday for a season.
    { id: "c0000000-0000-0000-0000-000000000009", court_number: 9, name: "Court 9", court_type: "Squash", is_active: false },
  ];
}

export const SCHEDULE_ID = "50000000-0000-0000-0000-000000000001";

export function scheduleRowFixture(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: SCHEDULE_ID,
    name: "Tuesday league",
    label: "League night",
    days: ["tue"],
    start: "18:00",
    end: "21:00",
    start_date: "2026-10-06",
    end_date: "2026-12-15",
    interval_weeks: 1,
    status: "active",
    courts: [
      { id: COURT_IDS.one, name: "Court 1" },
      { id: COURT_IDS.two, name: "Court 2" },
      { id: COURT_IDS.three, name: "Court 3" },
    ],
    created_by_name: "Review Admin",
    ...overrides,
  };
}

/**
 * A row carrying EVERY key the server's `Project` writes — `AdminSchedules.contract.test.ts`
 * compares its keys with the C# source, so the partial fixture above cannot quietly become the
 * only shape anybody tests against.
 */
export function fullScheduleRowFixture(): Required<ScheduleRow> {
  return {
    ...scheduleRowFixture(),
    days: ["tue"],
    start: "18:00",
    end: "21:00",
    start_date: "2026-10-06",
    end_date: "2026-12-15",
    interval_weeks: 1,
    status: "active",
    courts: [{ id: COURT_IDS.one, name: "Court 1" }],
    next_occurrence: "2026-10-06T16:00:00.000Z",
    rules: [{ from: "2026-10-06", until: null, days: ["tue"], start: "18:00", end: "21:00", interval_weeks: 1, in_force: true }],
    materialised_through: "2026-11-03",
    created_by_name: "Review Admin",
    created_at: "2026-09-21T18:31:00.000Z",
  };
}

// ---------------------------------------------------------------------------------------
// Response envelopes (C7) — what each route ANSWERS, pinned against the C# handlers
// ---------------------------------------------------------------------------------------

export function scheduleDetailResponse(row: ScheduleRow = scheduleRowFixture()): ScheduleDetailResponse {
  return { schedule: row, timezone: "Africa/Johannesburg" };
}

export function scheduleOccurrencesResponse(occurrences: ScheduleOccurrence[]): Required<ScheduleOccurrencesResponse> {
  return { occurrences, timezone: "Africa/Johannesburg" };
}

export function scheduleCreateResponse(row: ScheduleRow = scheduleRowFixture(), rowsCreated = 33): ScheduleCreateResponse {
  return { schedule: row, rows_created: rowsCreated };
}

export function scheduleUpdateResponse(
  row: ScheduleRow = scheduleRowFixture(), overrides: Partial<ScheduleUpdateResponse> = {},
): ScheduleUpdateResponse {
  return {
    schedule: row, rows_created: 30, effective_from: "2026-10-13", effective_from_clamped_to: null, ...overrides,
  };
}

export function scheduleOccurrenceResponse(
  date: string, status: ScheduleOccurrenceResponse["status"] = "skipped",
): ScheduleOccurrenceResponse {
  return { occurrence_date: date, status, rows_created: 0 };
}

export function scheduleEndResponse(overrides: Partial<ScheduleEndResponse> = {}): ScheduleEndResponse {
  return {
    status: "ended", end_date: "2026-10-12", occurrences_cancelled: 27, effective_from: "2026-10-13",
    effective_from_clamped_to: null, ...overrides,
  };
}

export function conflictFixture(overrides: Partial<ScheduleConflict> = {}): ScheduleConflict {
  return {
    occurrence_date: "2026-10-13",
    court_id: COURT_IDS.two,
    court_name: "Court 2",
    starts_at: "2026-10-13T16:00:00.000Z",
    ends_at: "2026-10-13T16:30:00.000Z",
    booking_id: "b0000000-0000-0000-0000-000000000001",
    status: "booked",
    kind: "booking",
    member_name: "Thandi Mokoena",
    amount_minutes: 36,
    would_refund_minutes: 36,
    cancellable: true,
    ...overrides,
  };
}

export function previewFixture(overrides: Partial<SchedulePreview> = {}): SchedulePreview {
  return {
    occurrences: 11,
    first: "2026-10-06",
    last: "2026-12-15",
    rows_to_create: 33,
    conflicts: [],
    left_out: [],
    ...overrides,
  };
}

export function occurrenceFixture(
  date: string, overrides: Partial<ScheduleOccurrence> = {},
): ScheduleOccurrence {
  return {
    date,
    starts_at: `${date}T16:00:00.000Z`,
    ends_at: `${date}T19:00:00.000Z`,
    status: "scheduled",
    courts: [
      { court_id: COURT_IDS.one, court_name: "Court 1", booking_id: `bk-${date}-1` },
      { court_id: COURT_IDS.two, court_name: "Court 2", booking_id: `bk-${date}-2` },
      { court_id: COURT_IDS.three, court_name: "Court 3", booking_id: `bk-${date}-3` },
    ],
    ...overrides,
  };
}

export function changeRowFixture(overrides: Partial<AdminChangeRow> = {}): AdminChangeRow {
  return {
    id: "ch-1",
    occurred_at: "2026-09-21T18:31:00.000Z",
    actor: { user_id: "44444444-4444-4444-4444-444444444444", name: "Review Admin" },
    area: "schedule",
    action: "schedule.created",
    headline: "Created Tuesday league",
    subject: { kind: "schedule", id: SCHEDULE_ID, label: "Tuesday league" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// Route builders — so both page tests stub the same wire
// ---------------------------------------------------------------------------------------

/** What every signed-in admin render needs before the page's own reads are reached. */
export function sessionRoutes(): StubRoute[] {
  return [
    { path: "/api/v1/whoami", body: { tenant_slug: "crusaders", tenant_id: "00000000-0000-0000-0000-0000000000cc", user_id: "44444444-4444-4444-4444-444444444444", is_authenticated: true, is_admin: true } },
    { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [] } },
  ];
}

/** The two reads the editor needs before it will let anything be typed into the sentence. */
export function editorPrerequisiteRoutes(settings: Record<string, unknown> = {}): StubRoute[] {
  return [
    { path: "/api/v1/admin/courts/", body: courtsFixture() },
    { path: "/api/v1/admin/settings/", body: { ...SCHEDULE_SETTINGS, ...settings } },
  ];
}
