import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Every action the club's change record can carry, as the server actually sends it — review
 * round 4, A4-6: "nothing raw for ANY action".
 *
 * <p>
 * <b>Stored, then rendered — never a guessed `changes` list.</b> Each fixture states what the
 * action's writer(s) store (`before` / `after`, the anonymous objects passed to
 * `AdminChangeRecorder.StageAsync`), and {@link serverDiff} turns that into the `changes` array
 * exactly as `AdminChangeDiff.Of` does after a round-trip through the `jsonb` column: keys come
 * back in jsonb order (shorter first, then bytewise), an object comes back as jsonb's text
 * (`{"a": 11, "b": 9}`), a decimal keeps its scale (`200.00`), an array of scalars is joined with
 * ", ", `true`/`false` read "yes"/"no", and the server's own label is the key with `_minute`
 * dropped. A fixture that restated the rendered strings by hand would drift the moment the
 * writer or the renderer did; this one only drifts when the writer's stored shape does.
 * </p>
 *
 * <p>
 * Every action has a writer since review round 4 wave B (courts, devices, the club key, the
 * doors, blocks and fault resolves wrote `audit_log` only until then). A new action without a
 * fixture here fails the catalogue test.
 * </p>
 */

const BACKEND = resolve(__dirname, "..", "..", "..", "backend", "Crusaders.Mainframe.Api");

/*
 * Patterns with a quote or a bracket class are built from strings: lizard's .tsx lexer reads a
 * quote inside a regex literal as a string and scores the rest of the file as one function.
 */
const QUOTE = String.fromCharCode(34);
const ACTION_CONST = new RegExp(`public const string (\\w+) = ${QUOTE}([^${QUOTE}]+)${QUOTE};`, "g");
const JSON_MARK = new Set(Array.from("{}" + "[]"));

/** The value of every `public const string X = "…";` in `AdminChangeActions.cs`, `Unrecognised` excepted. */
export function serverChangeActions(): string[] {
  const source = readFileSync(resolve(BACKEND, "Services", "AdminChangeActions.cs"), "utf8");
  const out: string[] = [];
  for (const m of source.matchAll(ACTION_CONST)) {
    if (m[1] !== "Unrecognised") out.push(m[2]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The server's renderer, reproduced — AdminChangeDiff.Of over a jsonb round-trip
// ---------------------------------------------------------------------------------------

/** A number as jsonb prints it — a C# decimal keeps its scale (`80.00`, `-30.00`, `1.2`). */
export class Dec {
  constructor(readonly text: string) {}
}
export const dec = (text: string) => new Dec(text);

type Json = string | number | boolean | null | Dec | Json[] | { [key: string]: Json };
export type Stored = { [key: string]: Json };

/** jsonb's key order: shorter keys first, then bytewise. */
function jsonbKeys(o: Stored): string[] {
  return Object.keys(o).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

/** A value as Postgres prints a jsonb value back — what `GetRawText` then returns. */
export function jsonbText(v: Json): string {
  if (v === null) return "null";
  if (v instanceof Dec) return v.text;
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(", ")}]`;
  if (typeof v === "object") return `{${jsonbKeys(v).map((k) => `${JSON.stringify(k)}: ${jsonbText(v[k])}`).join(", ")}}`;
  return JSON.stringify(v);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `AdminChangeDiff.Number`. */
function renderNumber(field: string, text: string): string {
  const int = /^-?\d+$/.test(text) ? Number(text) : null;
  if (field.endsWith("_minute") && int !== null && int >= 0 && int <= 1440) {
    if (int === 1440) return "24:00";
    return `${String(Math.floor(int / 60)).padStart(2, "0")}:${String(int % 60).padStart(2, "0")}`;
  }
  if (field.endsWith("_minutes") && int !== null) return int === 1 ? "1 minute" : `${int} minutes`;
  if (field === "days_of_week" && int !== null && int > 0 && int < 128) {
    return WEEKDAYS.filter((_, d) => (int & (1 << d)) !== 0).join(", ");
  }
  return text;
}

/** `AdminChangeDiff.Render`. */
function render(field: string, v: Json | undefined): string | null {
  if (v === undefined || v === null) return null;
  if (v === true) return "yes";
  if (v === false) return "no";
  if (typeof v === "string") return v;
  if (v instanceof Dec) return renderNumber(field, v.text);
  if (typeof v === "number") return renderNumber(field, String(v));
  if (Array.isArray(v)) return v.map((e) => render(field, e) ?? "—").join(", ");
  return jsonbText(v);
}

/** `AdminChangeDiff.Label`. */
export function serverLabel(field: string): string {
  const name = field.endsWith("_minute") ? field.slice(0, -"_minute".length) : field;
  const words = name.replaceAll("_", " ").trim();
  return words.length === 0 ? field : words[0].toUpperCase() + words.slice(1);
}

export type ServerChange = { field: string; label: string; before: string | null; after: string | null };

/** `AdminChangeDiff.Of(before, after)` — after's keys first, then before-only keys. */
export function serverDiff(before: Stored | null, after: Stored | null): ServerChange[] {
  const b = before ?? {};
  const a = after ?? {};
  const out: ServerChange[] = [];
  for (const key of jsonbKeys(a)) {
    const was = render(key, b[key]);
    const is = render(key, a[key]);
    if (was !== is) out.push({ field: key, label: serverLabel(key), before: was, after: is });
  }
  for (const key of jsonbKeys(b)) {
    if (key in a) continue;
    const was = render(key, b[key]);
    if (was !== null) out.push({ field: key, label: serverLabel(key), before: was, after: null });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------

export type ChangeRecordFixture = {
  /** A short name when an action has more than one realistic shape. */
  variant?: string;
  action: string;
  area: string;
  /** `AdminChangeActions.Headline(action, subjectLabel)`, as the server composes it. */
  headline: string;
  /** Where the stored shape was read from, or null when nothing writes this action to the change record. */
  writer: string | null;
  before: Stored | null;
  after: Stored | null;
  changes: ServerChange[];
};

const ID = {
  booking: "a5604dd3-1204-4b67-bc6b-cfca1804fa4f",
  booking2: "0b8e3c61-7f4d-4a1e-9d52-3c1f0e6a9b27",
  booking3: "d2f7a4e9-58c0-4b3a-a1e6-7c9d2b40f815",
  participant: "1efc8f32-2aae-46d5-87a4-808a5818e8de",
  entry: "ce45e706-b3ee-458e-abe2-8b69d932be6f",
  user: "5c2b9e14-83d7-4f0a-b6e1-2a9c7d3f8e05",
  user2: "8f1d0a37-c46b-4e92-8a5f-e0b3c7d21964",
  user3: "3a7e5c90-1d2f-4b68-9e0a-6f4b8c1d2e73",
  user4: "e9c4b2a1-6d5f-4870-b3e2-1f0a9d8c7b56",
  result: "7d3e9f12-4a6b-4c80-9e1d-2b5f7a0c3e48",
};

const GROUP_ROW = {
  name: "Juniors",
  description: "Under-18 members",
  status: "active",
  pricing_mode: "InheritCourt",
  multiplier_bps: 10000,
  flat_slice_price_credits: null,
  max_slots_per_day: 2,
  max_minutes_per_day: 120,
  advance_booking_days: 14,
  credits_per_zar: dec("1.2"),
  peak_priority: true,
} satisfies Stored;

const SCHEDULE = {
  name: "Tuesday league",
  label: "League",
  days_of_week: 4,
  start_minute: 1080,
  end_minute: 1260,
  start_date: "2026-10-06",
  end_date: "2026-12-15",
  interval_weeks: 1,
  courts: 2,
} satisfies Stored;

const BOOKING_FACTS = {
  booking_id: ID.booking,
  court: "Court 2",
  starts_at: "2026-10-01T16:00:00+00:00",
  minutes: 60,
  amount_credits: dec("80.00"),
} satisfies Stored;

const BLOCK = {
  label: "Coaching", ends_at: "2026-10-03T11:00:00+00:00", starts_at: "2026-10-03T10:00:00+00:00",
} satisfies Stored;

const COURT = {
  name: "Court 2", court_number: 2, court_type: "Squash", slice_price_credits: dec("9"), is_active: true,
} satisfies Stored;

const SEAT = { booking_id: ID.booking, participant_id: ID.participant, seat: 2 } satisfies Stored;

const RANGE = { from: "2026-09-28T22:00:00+00:00", to: "2026-09-29T22:00:00+00:00" } satisfies Stored;

type Draft = Omit<ChangeRecordFixture, "changes">;
const row = (d: Draft): ChangeRecordFixture => ({ ...d, changes: serverDiff(d.before, d.after) });

export const CHANGE_RECORD_CATALOGUE: ChangeRecordFixture[] = [
  // ---- schedule ---- AdminScheduleEndpoints.Snapshot / WithEffectiveFrom
  row({
    action: "schedule.created", area: "schedule", headline: "Created a repeating schedule — Tuesday league",
    writer: "AdminScheduleEndpoints.CreateAsync", before: null, after: SCHEDULE,
  }),
  row({
    action: "schedule.updated_future", area: "schedule",
    headline: "Changed a repeating schedule and its future dates — Tuesday league",
    writer: "AdminScheduleEndpoints.UpdateAsync", before: SCHEDULE,
    after: { ...SCHEDULE, days_of_week: 20, end_minute: 1290, effective_from: "2026-10-13" },
  }),
  row({
    action: "schedule.occurrence_skipped", area: "schedule",
    headline: "Skipped one date of a repeating schedule — Tuesday league",
    writer: "AdminScheduleEndpoints.OccurrenceAsync", before: null, after: { occurrence_date: "2026-10-13" },
  }),
  row({
    action: "schedule.occurrence_overridden", area: "schedule",
    headline: "Changed the times of one date of a repeating schedule — Tuesday league",
    writer: "AdminScheduleEndpoints.OccurrenceAsync", before: null,
    after: { occurrence_date: "2026-10-13", start_minute: 1140, end_minute: 1260 },
  }),
  row({
    action: "schedule.ended", area: "schedule", headline: "Ended a repeating schedule — Tuesday league",
    writer: "AdminScheduleEndpoints.EndAsync", before: null, after: { end_date: "2026-11-30", occurrences_cancelled: 3 },
  }),

  // ---- booking ----
  row({
    action: "bookings.bulk_cancelled", area: "booking", headline: "Cancelled several bookings at once",
    writer: "AdminBulkBookingEndpoints.CancelAsync", before: null,
    after: {
      requested: 3, succeeded: 3, failed: 0,
      total_refunded_credits: dec("240.00"), total_penalty_credits: dec("0.00"),
      booking_ids: [ID.booking, ID.booking2, ID.booking3],
    },
  }),
  row({
    action: "bookings.bulk_booked", area: "booking", headline: "Made several bookings at once",
    writer: "AdminBulkBookingEndpoints.BookAsync", before: null,
    after: { requested: 2, succeeded: 2, failed: 0, total_charged_credits: dec("160.00"), booking_ids: [ID.booking, ID.booking2] },
  }),
  row({
    action: "booking.cancelled_by_admin", area: "booking", headline: "Cancelled a booking — Thandi Mokoena",
    writer: "AdminCancelRecord.StageAsync", before: { ...BOOKING_FACTS, status: "booked" }, after: { status: "cancelled" },
  }),
  row({
    action: "booking.blocked", area: "booking", headline: "Blocked a court — Court 2",
    writer: "AdminBlockService.CreateAsync (R4 wave B)", before: null, after: BLOCK,
  }),
  row({
    action: "booking.block_lifted", area: "booking", headline: "Lifted a court block — Court 2",
    writer: "AdminBlockService.RemoveAsync (R4 wave B)", before: BLOCK, after: null,
  }),
  row({
    action: "booking.booked_on_behalf", area: "booking", headline: "Booked a court for a member — Thandi Mokoena",
    writer: "BookingService (RecordOnBehalf)", before: null, after: { ...BOOKING_FACTS, part_of_batch: false },
  }),
  row({
    action: "booking.overdraft_authorised", area: "booking",
    headline: "Let a booking take a balance below zero — Thandi Mokoena",
    writer: "BookingService (overdrawn)",
    before: { balance_credits: dec("50.00"), spendable_credits: dec("20.00") },
    after: {
      balance_credits: dec("-30.00"), spendable_credits: dec("-60.00"),
      booking_id: ID.booking, court: "Court 2", starts_at: "2026-10-01T16:00:00+00:00", amount_credits: dec("80.00"),
      self: false,
    },
  }),
  row({
    action: "booking.player_added", area: "booking", headline: "Added a player to a booking — Sipho Dlamini",
    writer: "PlayersAdminService.AddAsync", before: SEAT, after: { status: "invited", guest: null },
  }),
  row({
    variant: "guest", action: "booking.player_added", area: "booking", headline: "Added a player to a booking — Sam (guest)",
    writer: "PlayersAdminService.AddAsync", before: SEAT, after: { status: "accepted", guest: "Sam (guest)" },
  }),
  row({
    action: "booking.player_removed", area: "booking", headline: "Took a player off a booking — Sipho Dlamini",
    writer: "PlayersAdminService.RemoveAsync", before: SEAT, after: { status: "removed", overdraft_authorised: false },
  }),
  row({
    action: "booking.player_accepted_on_behalf", area: "booking",
    headline: "Accepted a game on a member's behalf — Sipho Dlamini",
    writer: "PlayersAdminService.AcceptOnBehalfAsync", before: SEAT,
    after: { status: "accepted", consented_credits: dec("40.00") },
  }),
  row({
    action: "booking.share_settled_outside", area: "booking",
    headline: "Recorded a share as paid outside the app — Sipho Dlamini",
    writer: "PlayersAdminService.SettleOutsideAsync", before: SEAT,
    after: { share_credits: dec("40.00"), paid_in_app_credits: dec("0.00"), overdraft_authorised: false },
  }),
  row({
    action: "booking.share_collected", area: "booking", headline: "Collected a member's share of a booking — Sipho Dlamini",
    writer: "PlayersAdminService.CollectAsync", before: SEAT,
    after: { collected_credits: dec("40.00"), balance_before_credits: dec("10.00"), balance_after_credits: dec("-30.00") },
  }),

  // ---- credit ---- WalletEndpoints (adjust)
  row({
    action: "credit.adjusted", area: "credit", headline: "Adjusted a member's credits — Thandi Mokoena",
    writer: "WalletEndpoints.AdjustAsync", before: { balance_credits: dec("120.00") },
    after: {
      balance_credits: dec("100.00"), amount_credits: dec("-20.00"), reason_code: "correction",
      zar_received: null, entry_id: ID.entry, related_booking_id: ID.booking,
    },
  }),
  row({
    action: "credit.topped_up", area: "credit", headline: "Topped up a member's credits — Thandi Mokoena",
    writer: "WalletEndpoints.AdjustAsync", before: { balance_credits: dec("0.00") },
    after: {
      balance_credits: dec("200.00"), amount_credits: dec("200.00"), reason_code: "top_up_cash",
      zar_received: dec("125.50"), entry_id: ID.entry, related_booking_id: null,
    },
  }),

  // ---- group ---- MemberGroupChanges.Snapshot / Diff
  row({
    action: "group.created", area: "group", headline: "Created a member group — Juniors",
    writer: "MemberGroupEndpoints.CreateAsync (no windows sent)", before: null, after: { ...GROUP_ROW, windows: "" },
  }),
  row({
    action: "group.updated", area: "group", headline: "Changed a member group — Juniors",
    writer: "MemberGroupEndpoints.PatchAsync → MemberGroupChanges.Diff",
    before: { pricing_mode: "InheritCourt", multiplier_bps: 10000, windows: "" },
    after: { pricing_mode: "Multiplier", multiplier_bps: 8000, windows: "tue 18:00-21:00, thu 18:00-21:00" },
  }),
  row({
    variant: "flat price, caps and rate", action: "group.updated", area: "group", headline: "Changed a member group — Juniors",
    writer: "MemberGroupEndpoints.PatchAsync → MemberGroupChanges.Diff",
    before: { pricing_mode: "Multiplier", multiplier_bps: 8000, flat_slice_price_credits: null, max_slots_per_day: 2, credits_per_zar: dec("1.2"), peak_priority: true },
    after: { pricing_mode: "FlatPerSlice", multiplier_bps: 10000, flat_slice_price_credits: dec("15.00"), max_slots_per_day: null, credits_per_zar: null, peak_priority: false },
  }),
  row({
    action: "group.archived", area: "group", headline: "Archived a member group — Juniors",
    writer: "MemberGroupEndpoints.PatchAsync", before: { status: "active" }, after: { status: "archived" },
  }),
  row({
    action: "group.members_changed", area: "group", headline: "Changed who is in a member group — Juniors",
    writer: "MemberGroupEndpoints.StageMembersChangedAsync / AdminMemberGroupsEndpoint.StageAsync", before: null,
    after: { added: [{ user_id: ID.user, name: "Thandi Mokoena" }], removed: [] },
  }),
  row({
    variant: "several removed", action: "group.members_changed", area: "group",
    headline: "Changed who is in a member group — Juniors",
    writer: "MemberGroupEndpoints.StageMembersChangedAsync", before: null,
    after: { added: [], removed: [{ user_id: ID.user2, name: "Sipho Dlamini" }, { user_id: ID.user3, name: "Anele Khumalo" }] },
  }),
  row({
    action: "group.deleted", area: "group", headline: "Deleted a member group — Juniors",
    writer: "MemberGroupEndpoints.DeleteAsync", before: { ...GROUP_ROW, windows: "" }, after: null,
  }),

  // ---- member ----
  row({
    action: "member.approved", area: "member", headline: "Approved a member — Thandi Mokoena",
    writer: "MemberApprovalService.StageChangeAsync", before: { status: "pending_approval" }, after: { status: "active" },
  }),
  row({
    action: "member.rejected", area: "member", headline: "Rejected an applicant — Thandi Mokoena",
    writer: "MemberApprovalService.StageChangeAsync", before: { status: "pending_approval" }, after: { status: "rejected" },
  }),
  row({
    action: "member.suspended", area: "member", headline: "Suspended a member — Thandi Mokoena",
    writer: "MemberApprovalService.StageChangeAsync", before: { status: "active" }, after: { status: "suspended" },
  }),
  row({
    action: "member.reactivated", area: "member", headline: "Reactivated a member — Thandi Mokoena",
    writer: "MemberApprovalService.StageChangeAsync", before: { status: "suspended" }, after: { status: "active" },
  }),
  row({
    action: "member.password_reset", area: "member", headline: "Gave a member a temporary password — Thandi Mokoena",
    writer: "AdminMemberEndpoints (reset password)", before: null, after: { must_change_password: true },
  }),
  row({
    action: "member.code_reset", area: "member",
    headline: "Reset a member's code and signed them out everywhere — Thandi Mokoena",
    writer: "AdminMemberEndpoints.ResetCodeAsync", before: null, after: { passkeys_removed: 2 },
  }),
  row({
    action: "member.trace_viewed", area: "member", headline: "Looked at one member's activity — Thandi Mokoena",
    writer: "AdminMemberTraceEndpoints.RecordAsync", before: null,
    after: {
      day: "2026-09-29", range: RANGE, strands_returned: ["booking", "door", "other"],
      event_count: 12, total: 12, exported: false,
    },
  }),
  row({
    variant: "rolling window, one strand", action: "member.trace_viewed", area: "member",
    headline: "Looked at one member's activity — Thandi Mokoena",
    writer: "AdminMemberTraceEndpoints.RecordAsync", before: null,
    after: { day: null, range: RANGE, strands_returned: ["other"], event_count: 3, total: 3, exported: true },
  }),
  row({
    action: "member.door_history_viewed", area: "member", headline: "Looked at one member's door history — Thandi Mokoena",
    writer: "AdminMemberDoorEndpoints.RecordAsync", before: null,
    after: { range: RANGE, door: null, outcome: "refused", reason: null, rows: 25, total: 25, exported: false },
  }),
  row({
    action: "member.admin_granted", area: "member", headline: "Made a member an administrator — Thandi Mokoena",
    writer: "AdminRoleService.StageRecordsAsync", before: { is_admin: false }, after: { is_admin: true },
  }),
  row({
    action: "member.admin_revoked", area: "member", headline: "Removed a member's administrator rights — Thandi Mokoena",
    writer: "AdminRoleService.StageRecordsAsync", before: { is_admin: true }, after: { is_admin: false },
  }),

  // ---- setting ----
  row({
    action: "settings.updated", area: "setting", headline: "Changed the club's settings",
    writer: "AdminConfigEndpoints (PUT settings) → ChangedKeys",
    before: {
      slice_minutes: 15, day_start_minute: 360, gate_access_policy: "active_member",
      credits_per_zar_regular: dec("1.0"), member_trace_enabled: false, peak_hours: "16:00-19:00",
    },
    after: {
      slice_minutes: 30, day_start_minute: 300, gate_access_policy: "booking_window",
      credits_per_zar_regular: dec("1.2"), member_trace_enabled: true, peak_hours: "17:00-20:00",
    },
  }),
  // AdminCourtEndpoints (R4 wave B): only what changed, each side.
  row({
    action: "court.created", area: "setting", headline: "Added a court — Court 2",
    writer: "AdminCourtEndpoints.CreateAsync", before: null, after: COURT,
  }),
  row({
    action: "court.updated", area: "setting", headline: "Changed a court — Glass court",
    writer: "AdminCourtEndpoints.UpdateAsync", before: { name: "Court 2" }, after: { name: "Glass court" },
  }),
  row({
    variant: "price", action: "court.updated", area: "setting", headline: "Changed a court — Court 2",
    writer: "AdminCourtEndpoints.UpdateAsync",
    before: { slice_price_credits: dec("8.00") }, after: { slice_price_credits: dec("9.50") },
  }),
  row({
    action: "court.deactivated", area: "setting", headline: "Deactivated a court — Court 2",
    writer: "AdminCourtEndpoints.DeactivateAsync / UpdateAsync", before: { is_active: true }, after: { is_active: false },
  }),
  row({
    action: "changes.exported", area: "setting", headline: "Downloaded the club's change record",
    writer: "AdminChangeEndpoints.CsvAsync", before: null,
    after: {
      from: "2026-08-31T22:00:00+00:00", to: "2026-09-30T22:00:00+00:00", area: "booking", action: null,
      rows: 57, truncated: false,
    },
  }),
  row({
    action: "webhook.created", area: "setting", headline: "Added a webhook — Court lights",
    writer: "WebhookEndpoints.StageChangeAsync", before: null,
    after: { destination: "https://hooks.example.org", event_filter: "*", description: "Court lights" },
  }),
  row({
    variant: "filtered events", action: "webhook.created", area: "setting", headline: "Added a webhook — Court lights",
    writer: "WebhookEndpoints.StageChangeAsync", before: null,
    after: { destination: "https://hooks.example.org", event_filter: "booking.created,booking.cancelled", description: "Court lights" },
  }),
  row({
    action: "webhook.deleted", area: "setting", headline: "Removed a webhook — hooks.example.org",
    writer: "WebhookEndpoints.StageChangeAsync",
    before: { destination: "https://hooks.example.org:8443", event_filter: "*", description: null }, after: null,
  }),

  // ---- device ---- (R4 wave B) DeviceChanges.Snapshot / Removed, AdminDoorFleetEndpoint, AdminMonitoringEndpoints.CloseAsync
  row({
    action: "device.updated", area: "device", headline: "Changed a device — Court 1 box (box-0a1b2c)",
    writer: "DeviceRegistryService.UpdateAsync", before: { name: "Court box", in_service: true },
    after: { name: "Court 1 box", in_service: false },
  }),
  row({
    variant: "card and wiring", action: "device.updated", area: "device", headline: "Changed a device — Front door (gate-0a1b2c)",
    writer: "DeviceRegistryService.UpdateAsync",
    before: { gate_key: null, acknowledged: false, location_note: null, power_loss_behaviour: "not_established" },
    after: { gate_key: "front", acknowledged: true, location_note: "Reception, left of the desk", power_loss_behaviour: "released" },
  }),
  row({
    variant: "court box", action: "device.updated", area: "device", headline: "Changed a device — Court box (box-0a1b2c)",
    writer: "DeviceRegistryService.UpdateAsync",
    before: { court_numbers: "1, 2", own_button_map: false }, after: { court_numbers: "1, 2, 3", own_button_map: true },
  }),
  row({
    action: "device.deleted", area: "device", headline: "Removed a device — Court box (box-0a1b2c)",
    writer: "DeviceRegistryService.DeleteAsync",
    before: { name: "Court box", kind: "court_box", device_code: "box-0a1b2c", court_numbers: "1, 2" }, after: null,
  }),
  row({
    action: "device.api_key_regenerated", area: "device", headline: "Regenerated the club's device key",
    writer: "DeviceRegistryService.IssueApiKeyAsync (never the key)", before: null, after: null,
  }),
  row({
    action: "doors.shut_all", area: "device", headline: "Shut every door at once",
    writer: "AdminDoorFleetEndpoint.ApplyAsync", before: null, after: { doors: 2, door_names: ["Front door", "Side door"] },
  }),
  row({
    action: "doors.reopened_all", area: "device", headline: "Reopened the doors",
    writer: "AdminDoorFleetEndpoint.ApplyAsync", before: null, after: { doors: 1, door_names: ["Front door"] },
  }),
  row({
    action: "monitoring.error_resolved", area: "device", headline: "Marked a device fault as resolved — Court box (box-0a1b2c)",
    writer: "AdminMonitoringEndpoints.CloseAsync", before: null, after: { code: "relay_stuck", count: 3, severity: "error" },
  }),

  // ---- play ---- ResultService.RecordChangeAsync
  row({
    action: "play.result_voided", area: "play", headline: "Removed a match result — Court 2, Tue 29 Sep 18:00",
    writer: "ResultService.RecordChangeAsync", before: { status: "confirmed" },
    after: {
      status: "voided", result_id: ID.result, booking_id: ID.booking, reason: "Entered on the wrong booking",
      games: [{ a: 11, b: 9 }, { a: 11, b: 7 }, { a: 9, b: 11 }, { a: 11, b: 5 }], format: "best_of_5",
      subject_user_id: ID.user, lineup_user_ids: [ID.user, ID.user2, ID.user3, ID.user4],
    },
  }),
  row({
    action: "play.result_upheld", area: "play", headline: "Kept a disputed match result — Court 2, Tue 29 Sep 18:00",
    writer: "ResultService.RecordChangeAsync", before: { status: "disputed" },
    after: {
      status: "confirmed", result_id: ID.result, booking_id: ID.booking, reason: "Both captains confirmed the score",
      games: [{ a: 11, b: 9 }, { a: 8, b: 11 }, { a: 11, b: 6 }], format: "best_of_3",
      subject_user_id: ID.user, lineup_user_ids: [ID.user, ID.user2],
    },
  }),
];

// ---------------------------------------------------------------------------------------
// What "raw" means
// ---------------------------------------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const AREA_CODE = /\b(?:bookings?|schedule|credit|group|member|settings|court|device|doors|monitoring|play|webhook|changes)\.[a-z_]+\b/;

/**
 * Why `text` is not something a volunteer should read, or null when it is fine. `field` narrows
 * the check where a rule is about one kind of value (a state, say) rather than any text.
 */
export function rawIn(text: string | null | undefined, field?: string): string | null {
  if (text === null || text === undefined) return null;
  if (text.trim() === "") return "an empty value on a row that is shown";
  if (Array.from(text).some((ch) => JSON_MARK.has(ch))) return "JSON (a brace or bracket)";
  if (/\\u[0-9a-f]{4}/i.test(text)) return "a JSON escape sequence";
  if (/\d{4}-\d{2}-\d{2}/.test(text)) return "an ISO date or instant";
  if (UUID.test(text)) return "an id (UUID)";
  const pascal = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/.exec(text);
  if (pascal) return `a PascalCase enum token (${pascal[0]})`;
  const snake = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/i.exec(text);
  if (snake) return `a snake_case code (${snake[0]})`;
  const dotted = AREA_CODE.exec(text);
  if (dotted) return `a dotted event/action code (${dotted[0]})`;
  if (/\bbps\b/i.test(text)) return "a unit abbreviation (bps)";
  const day = /\b(?:mon|tue|wed|thu|fri|sat|sun)\b/.exec(text);
  if (day) return `a lowercase weekday code (${day[0]})`;
  if (/^[a-z]+(?:, [a-z]+)+$/.test(text)) return "a list of lowercase codes";
  if (field && (field === "status" || field.endsWith("_status")) && /^[a-z]+$/.test(text)) {
    return `a lowercase state token (${text})`;
  }
  if (/\s(?:per|of|for)$/.test(text)) return "a caption that stops mid-phrase";
  return null;
}
