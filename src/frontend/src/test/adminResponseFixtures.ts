import type {
  AdminBulkResult, AdminChangePage, AdminChangeRow, AdminItemResult, AdminPerson, ControlBoardBooking,
  ControlBoardBox, ControlBoardCourt, ControlBoardDevice, ControlBoardLights, ControlBoardView, DeviceErrorCounts, DeviceErrorPage,
  DeviceErrorRow, MemberBookingRules, MemberCodeResetResult, MemberGroup, MemberGroupChip, MemberGroupPreview,
  MemberGroupSaved, MemberGroupsSetResult, MemberTariff, MonitoringSummary, StreamTicket, TraceActor, TraceEvent,
  TraceView, AdminAdjustResult, AdminPackage, AdminSellResult, adminEndpoints,
} from "../lib/adminApi";
import { shelfPackage } from "./minutesFixtures";
import type {
  AdminRoleResult, FingerprintEnrolment, MemberBookingRow, MemberBookingsPage, MemberDetail, MemberDoorRow,
  MemberDoorsPage,
} from "../lib/memberDetailApi";
import type {
  AdminBookingQuote, AdminBulkQuote, AdminBulkQuoteItem, AdminCourt, AdminDevice, AdminDoorDevice,
  BiometricEnrollmentRow, BulkBookResponse, BulkCancelResponse, DailyAdminPoint, DeviceActivityEntry,
  DeviceActivityPage, DeviceApiKey, DoorEventEntry, DoorLogDoor, DoorLogEntry, DoorLogPage, DoorRow, DoorSignal,
  DoorsView, FleetDoorResult, FleetResult, MemberSpendMonth, MemberSpendReport, RevenueReport, UtilisationRow,
  WebhookDeliveryDto, WebhookEndpointDto, endpoints, MemberShelf,
} from "../lib/api";
import type { AdminMemberPlay, AdminResult, AdminResultsPage } from "../lib/playApi";
import type { AddPlayersAnswer, AddedParticipant, CollectAnswer, ReturnAnswer, SeatAnswer } from "../lib/playersApi";
import type { AdminNotice, AdminNoticeKind, AdminNoticePage } from "../lib/notificationsApi";

/**
 * Every admin REPLY the console reads, as a fixture typed by the console's own declaration (A4-2).
 *
 * <p>
 * <b>Why each builder is typed and spells out every key.</b> The type is what the screens read; a
 * fixture annotated with it cannot carry a key the type does not declare (tsc's excess-property
 * check) and a renamed key breaks the build. `adminResponses.contract.test.ts` then compares each
 * fixture's keys with what the C# handler actually writes, so the chain type → fixture → server is
 * closed in both directions. The values are placeholders; only the KEYS are the contract.
 * </p>
 *
 * <p>
 * <b>Why a builder may cover fewer keys than its type.</b> A few types serve two replies (the control
 * board's `current` and `next` share `ControlBoardBooking`; `AdminPerson` names a person with or
 * without a photo). There the builder spells out the keys of the ONE reply it stands for, and the
 * test says which. Types declared inline at the call site are reached through the endpoint's own
 * return type, so there is still no second spelling.
 * </p>
 */

type Reply<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

const AT = "2026-09-30T18:00:00Z";
const ID = "00000000-0000-0000-0000-000000000001";

/* ─────────────────────────────── control board ─────────────────────────────── */

export function controlBoardView(): ControlBoardView {
  return {
    generated_at: AT, timezone: "Africa/Johannesburg", slice_minutes: 20, club_day: "2026-09-30", courts: [], boxes: [],
    realtime: { poll_seconds: 15, resync_seconds: 60, fallback_after_failures: 3, fallback_window_seconds: 60 },
  };
}

export function controlBoardRealtime(): NonNullable<ControlBoardView["realtime"]> {
  return controlBoardView().realtime!;
}

/** Every key the tile READS, `door` included. */
export function controlBoardCourt(): ControlBoardCourt {
  return {
    court_id: ID, court_number: 1, name: "Court 1", is_active: true, lights: null, current: null, next: null,
    device: null, door: null, boxes_on_court: 1, other_boxes: [],
  };
}

export function controlBoardLights(): ControlBoardLights {
  return {
    state: "on", since: AT, until: AT, seconds_remaining: 60, stale: false, as_of: AT, confirmed_at: null,
    confirmed_state: null, turned_on_by: null, from_booking_id: null,
  };
}

export function controlBoardTurnedOnBy(): NonNullable<ControlBoardLights["turned_on_by"]> {
  return { kind: "member", user_id: ID, name: "Priya Naidoo", photo_url: null };
}

/** The booking ON court now. */
export function controlBoardCurrent(): ControlBoardBooking {
  return {
    booking_id: ID, starts_at: AT, ends_at: AT, status: "booked", kind: "booking", label: null, booked_by: null,
    checked_in_at: null, amount_minutes: 8, minutes_remaining: 20,
  };
}

/** The booking NEXT on court. */
export function controlBoardNext(): ControlBoardBooking {
  return { booking_id: ID, starts_at: AT, minutes_until: 40, kind: "booking", label: null, booked_by: null };
}

/** A person on the board — with the photo the wall shows. */
export function controlBoardPerson(): AdminPerson {
  return { user_id: ID, name: "Priya Naidoo", photo_url: null };
}

export function controlBoardDevice(): ControlBoardDevice {
  return {
    device_id: ID, device_code: "box-1", name: "Court box", relay: "A", link: "online", last_seen_at: AT,
    silent_seconds: 3, offline_after_seconds: 90, firmware: "1.0", mega_version: "1.0", open_errors: null,
    mac_address: "5c:cf:7f:00:00:01",
  };
}

export function openErrorCounts(): DeviceErrorCounts {
  return { critical: 0, error: 0, warning: 0, info: 0 };
}

export function controlBoardOtherBox(): NonNullable<ControlBoardCourt["other_boxes"]>[number] {
  return { device_id: ID, device_code: "box-2", name: null, mac_address: null, last_seen_at: null };
}

/** One entry of the board's `boxes` list (R4 A4-5). */
export function controlBoardBox(): ControlBoardBox {
  return {
    device_id: ID, device_code: "box-1", name: "Court box", mac_address: null, enabled: true, link: "online",
    last_seen_at: AT, court_numbers: [1, 2],
  };
}

export function streamTicket(): StreamTicket {
  return { ticket: "t", expires_in_seconds: 60 };
}

/* ─────────────────────────────── monitoring ─────────────────────────────── */

export function deviceErrorPage(): DeviceErrorPage {
  return {
    rows: [], total: 0, cursor: null, retention_days: 90, timezone: "Africa/Johannesburg",
    range: { from: AT, to: AT }, counts: openErrorCounts(),
  };
}

export function deviceErrorRow(): DeviceErrorRow {
  return {
    id: ID, device_id: ID, device_code: "box-1", device_name: "Court box", device_kind: "court_box", claimed_mac: null,
    source: "device", code: "relay_cmd_dropped", severity: "warning", detail: null, court: 1, first_seen_at: AT,
    last_seen_at: AT, count: 1, resolved_at: null, resolved_by_name: null, resolution_note: null, headline: "…",
  };
}

export function bulkResult(): AdminBulkResult {
  return { requested: 1, succeeded: 1, failed: 0, results: [bulkItem()] };
}

export function bulkItem(): AdminItemResult {
  return { id: ID, status: "resolved", error: null };
}

export function monitoringSummary(): MonitoringSummary {
  return {
    open: openErrorCounts(), by_device: [summaryByDevice()], last_24h: { opened: 0, resolved: 0 },
    worst_offender: { device_code: "box-1", open: 1 }, retention_days: 90, timezone: "Africa/Johannesburg",
    generated_at: AT,
  };
}

export function summaryByDevice(): NonNullable<MonitoringSummary["by_device"]>[number] {
  return { device_id: ID, device_code: "box-1", device_name: null, open: 1, worst: "warning", last_seen_at: AT, link: "online" };
}

/* ─────────────────────────────── the night trace ─────────────────────────────── */

export function traceView(): TraceView {
  return {
    member: traceMember(), club_day: "2026-09-30", range: { from: AT, to: AT }, timezone: "Africa/Johannesburg",
    retention: traceRetention(), summary: traceSummary(), events: [], total: 0, cursor: null,
  };
}

export function traceMember(): TraceView["member"] {
  return { user_id: ID, name: "Priya Naidoo", membership_number: "C-1", photo_url: null };
}

export function traceRetention(): NonNullable<TraceView["retention"]> {
  return { audit_days: 2555, door_days: 90, door_horizon: "2026-07-02", door_rows_may_be_incomplete: false };
}

export function traceSummary(): NonNullable<TraceView["summary"]> {
  return {
    first_seen_at: AT, last_seen_at: AT, minutes_on_court: 40, courts: ["Court 1"], minutes_spent: 8,
    minutes_received: 0, doors_entered: 1, doors_refused: 0, bookings_made: 1, bookings_cancelled: 0,
  };
}

/** Every key the night READS off an event, the three the rail and the burst key use included. */
export function traceEvent(): TraceEvent {
  return {
    at: AT, strand: "door", kind: "door.released", headline: "…", detail: null, actor: traceActor(), subject: null,
    court: null, amount_minutes: null, balance_after_minutes: null, approximate: false, device_code: "gate-1",
    outage_id: null, source: "audit", source_id: ID,
  };
}

export function traceActor(): TraceActor {
  return { user_id: ID, name: "Priya Naidoo", kind: "member", is_self: true, is_admin: false };
}

/** The event's subject: a person, named, with no photo on this surface. */
export function traceSubject(): AdminPerson {
  return { user_id: ID, name: "Priya Naidoo" };
}

export function traceCourt(): NonNullable<TraceEvent["court"]> {
  return { id: ID, number: 1, name: "Court 1" };
}

/* ─────────────────────────────── the change record ─────────────────────────────── */

export function adminChangePage(): AdminChangePage {
  return { rows: [], total: 0, cursor: null, timezone: "Africa/Johannesburg", retention: "…", range: { from: AT, to: AT } };
}

export function adminChangeRow(): AdminChangeRow {
  return {
    id: ID, occurred_at: AT, actor: adminChangeActor(), area: "group", action: "group.updated", headline: "…",
    subject: adminChangeSubject(), reason: null, changes: [adminChangeField()],
  };
}

export function adminChangeActor(): NonNullable<AdminChangeRow["actor"]> {
  return { user_id: ID, name: "Desk", email: "desk@example.test" };
}

export function adminChangeSubject(): NonNullable<AdminChangeRow["subject"]> {
  return { kind: "group", id: ID, label: "Regular" };
}

export function adminChangeField(): NonNullable<AdminChangeRow["changes"]>[number] {
  return { field: "name", label: "Name", before: "A", after: "B" };
}

/* ─────────────────────────────── member groups ─────────────────────────────── */

export function memberGroupsList(): Reply<typeof adminEndpoints.memberGroups> {
  return { groups: [] };
}

export function memberGroupWire(): MemberGroup {
  return {
    id: ID, name: "Regular", description: null, status: "active", sort_order: 0, is_system_default: true,
    system_key: null, package_discount_bps: null, peak_priority: null, caps: memberGroupCaps(),
    windows: [{ day: "mon", start: "06:00", end: "22:00" }], member_count: 0,
  };
}

export function memberGroupCaps(): NonNullable<MemberGroup["caps"]> {
  return { max_slots_per_day: null, max_minutes_per_day: null, advance_booking_days: null };
}

export function memberGroupSaved(): MemberGroupSaved {
  return { id: ID, name: "Regular" };
}

/** Every key the group's member list is READ for — the paging cursor and "added by" included. */
export function memberGroupMembers(): Reply<typeof adminEndpoints.memberGroupMembers> {
  return { members: [memberGroupMember()], total: 1, cursor: null };
}

export function memberGroupMember(): Reply<typeof adminEndpoints.memberGroupMembers>["members"][number] {
  return { user_id: ID, name: "Priya Naidoo", photo_url: null, membership_number: "C-1", added_at: AT, added_by_name: "Desk" };
}

export function memberGroupPreview(): MemberGroupPreview {
  return { current: memberBookingRules(), would_be: memberBookingRules() };
}

/** Every key the preview READS, `club_hours` and `empty_window_reason` included. */
export function memberBookingRules(): MemberBookingRules {
  return {
    day: "2026-09-30", groups: [{ id: ID, name: "Regular", description: null }], allowed_windows: [{ start: "06:00", end: "22:00" }],
    club_hours: { start: "06:00", end: "22:00" }, max_slots_per_day: null, max_minutes_per_day: null, advance_booking_days: null,
    empty_window_reason: null, empty_window_groups: null, tariff: memberTariff(),
  };
}

export function memberTariff(): MemberTariff {
  return {
    package_discount_bps: null, discount_group_id: null, peak_priority: false, peak_withheld_by: [],
  };
}

export function memberGroupsSet(): MemberGroupsSetResult {
  return { user_id: ID, groups: [memberGroupChip()], added: [], removed: [], tariff: memberTariff() };
}

export function memberGroupChip(): MemberGroupChip {
  return { id: ID, name: "Regular", system_key: null, package_discount_bps: null, peak_priority: null };
}

/* ─────────────────────────────── credit and the member's code ─────────────────────────────── */

export function adminAdjustResult(): AdminAdjustResult {
  return {
    entry_id: ID, type: "AdminAdjustment", reason_code: "goodwill", amount_minutes: 10, zar_received: null,
    balance_before_minutes: 0, balance_after_minutes: 10, member: { user_id: ID, email: "priya@example.test" },
  };
}

/** P13 §3.7 — the desk sold a package: the adjust answer plus the package. */
export function adminSellResult(): AdminSellResult {
  return {
    entry_id: ID, type: "AdminTopUp", reason_code: "top_up_cash", amount_minutes: 300, zar_received: 550,
    balance_before_minutes: 0, balance_after_minutes: 300, member: { user_id: ID, email: "priya@example.test" },
    package: { id: ID, name: "5 hours", minutes: 300, price_zar: 550 },
  };
}

/** P13 §3.7 — the shelf as one member sees it, from the desk (no checkouts). */
export function memberShelf(): MemberShelf {
  return { discount: null, packages: [shelfPackage()] };
}

/* ─────────────────────────────── P13: the club's packages (§3.5) ─────────────────────────────── */

export function adminPackage(over: Partial<AdminPackage> = {}): AdminPackage {
  return {
    id: ID, name: "5 hours", minutes: 300, price_zar: 550, group: null, sort_order: 1, status: "active",
    created_at: AT, updated_at: AT, ...over,
  };
}

export function adminPackages(): Reply<typeof adminEndpoints.packages> {
  return { packages: [adminPackage()] };
}

export function memberCodeReset(): MemberCodeResetResult {
  return { rotated: true, generation: 2, passkeys_revoked: true, passkeys_removed: 1, member_notified: true };
}

/* ─────────────────────────────── one member ─────────────────────────────── */

export function memberDetail(): MemberDetail {
  return {
    user_id: ID, membership_id: ID, full_name: "Priya Naidoo", email: "priya@example.test", membership_number: "C-1",
    status: "Active", rejection_reason: null, review: null, account_status: "Active", email_verified: true,
    created_at: AT, last_login_at: null, photo_url: null, is_admin: false, admin_source: null, groups: [], tariff: memberTariff(),
    balance_minutes: 0, held_minutes: 0, owed_back_minutes: 0, held_until: null, held_parts: [], passkey_count: 0,
    fingerprints: { count: 0, enrolments: [] }, next_bookings: [], counts_30d: memberCounts(),
  };
}

export function memberReview(): NonNullable<MemberDetail["review"]> {
  return { reviewed_at: AT, reviewed_by_user_id: ID, reviewed_by_name: "Desk" };
}

export function memberCounts(): MemberDetail["counts_30d"] {
  return { bookings: 0, no_shows: 0, sessions_played: 0 };
}

export function memberFingerprints(): MemberDetail["fingerprints"] {
  return { count: 0, enrolments: [] };
}

export function fingerprintEnrolment(): FingerprintEnrolment {
  return { template_id: "t", finger_label: null, enrolled_at: AT };
}

export function memberBookingRow(): MemberBookingRow {
  return {
    booking_id: ID, court_id: ID, court_name: "Court 1", starts_at: AT, ends_at: AT, sold_ends_at: AT, status: "booked",
    charged_minutes: 8, cost_minutes: 8,
    checked_in_at: null, cancelled_at: null, booked_by: memberBookingActor(), role: "organiser", organiser: memberBookingActor(),
  };
}

export function memberBookingActor(): MemberBookingRow["booked_by"] {
  return { user_id: ID, name: "Priya Naidoo", is_self: true };
}

export function memberBookingsPage(): MemberBookingsPage {
  return { when: "upcoming", items: [], next_cursor: null };
}

export function memberDoorsPage(): MemberDoorsPage {
  return {
    member: { user_id: ID, name: "Priya Naidoo" }, items: [], next_cursor: null, total: 0, range: { from: AT, to: AT },
    timezone: "Africa/Johannesburg", retention_days: 90,
  };
}

export function memberDoorRow(): MemberDoorRow {
  return {
    at: AT, delivered_at: null, time_uncertain: false, action: "gate.released", outcome: "released", reason: null,
    reason_text: "…", offline: false, method: null, fingerprint: null, door: { id: ID, name: "Front door", gate_key: "front", device_code: "gate-44c103", removed: false },
  };
}

export function adminRoleResult(): AdminRoleResult {
  return { user_id: ID, is_admin: true, admin_source: "granted", changed: true };
}

/* ─────────────────────────────── bookings at the desk (lib/api.ts) ─────────────────────────────── */

export function adminBookAnswer(): Reply<typeof endpoints.adminBook> {
  return { booking_id: ID, balance_after_minutes: 0 };
}

export function adminCancelAnswer(): Reply<typeof endpoints.adminCancelBooking> {
  return { refunded_minutes: 8, penalty_minutes: 0 };
}

export function adminBlockAnswer(): Reply<typeof endpoints.adminBlock> {
  return { booking_id: ID };
}

export function adminBookingQuote(): AdminBookingQuote {
  return {
    user_id: ID, court_id: ID, court_name: "Court 1", starts_at: AT, ends_at: AT, slices: 1, price_minutes: 8,
    balance_minutes: 10, balance_after_minutes: 2, overdraws: false, held_minutes: 0, owed_back_minutes: 0,
  };
}

export function adminBulkQuote(): AdminBulkQuote {
  return {
    user_id: ID, total_minutes: 8, balance_minutes: 10, balance_after_minutes: 2, overdraws: false, held_minutes: 0,
    owed_back_minutes: 0, items: [adminBulkQuoteItem()],
  };
}

export function adminBulkQuoteItem(): AdminBulkQuoteItem {
  return { index: 0, court_id: ID, court_name: "Court 1", starts_at: AT, slices: 1, price_minutes: 8, bookable: true, reason: null };
}

/** The declared keys; the rows are read loosely, so their read keys are listed in the test. */
export function bulkCancelResponse(): BulkCancelResponse {
  return { requested: 1, succeeded: 1, failed: 0, total_refunded_minutes: 8, total_penalty_minutes: 0, results: [] };
}

export function bulkBookResponse(): BulkBookResponse {
  return {
    requested: 1, succeeded: 1, failed: 0, total_charged_minutes: 8, payer: bulkBookPayer(), results: [],
    halted_at: 0, halted_reason: "",
  };
}

export function bulkBookPayer(): NonNullable<BulkBookResponse["payer"]> {
  return { user_id: ID, name: "Priya Naidoo", balance_before_minutes: 10, balance_after_minutes: 2 };
}

/* ─────────────────────────────── members (lib/api.ts) ─────────────────────────────── */

export function approveAnswer(): Reply<typeof endpoints.adminApprove> {
  return { approved: true, member_notified: true };
}

export function rejectAnswer(): Reply<typeof endpoints.adminReject> {
  return { rejected: true, member_notified: true };
}

export function suspendAnswer(): Reply<typeof endpoints.adminSuspend> {
  return { suspended: true, member_notified: true };
}

export function reactivateAnswer(): Reply<typeof endpoints.adminReactivate> {
  return { reactivated: true, member_notified: true };
}

export function resetPasswordAnswer(): Reply<typeof endpoints.adminResetMemberPassword> {
  return { temp_password: "x", email_sent_to: null, member_notified: false, advice: "…" };
}

export function pinAnswer(): Reply<typeof endpoints.adminSetMemberPin> {
  return { pin_set: true };
}

export function memberSpendReport(): MemberSpendReport {
  return { from: AT, to: AT, member: memberSpendMember(), totals: memberSpendTotals(), monthly: [] };
}

export function memberSpendMember(): MemberSpendReport["member"] {
  return { membership_id: ID, user_id: ID, full_name: "Priya Naidoo", membership_number: "C-1", groups: [] };
}

export function memberSpendTotals(): MemberSpendReport["totals"] {
  return {
    top_ups_minutes: 0, top_ups_zar: 0, spent_minutes: 0, refunds_minutes: 0, penalties_minutes: 0, net_minutes: 0,
    movement_count: 0,
  };
}

export function memberSpendMonth(): MemberSpendMonth {
  return {
    month: "2026-09", top_ups_minutes: 0, top_ups_zar: 0, spent_minutes: 0, refunds_minutes: 0, penalties_minutes: 0,
    adjustments_minutes: 0, net_minutes: 0, movement_count: 0,
  };
}

/* ─────────────────────────────── webhooks, biometrics, reports ─────────────────────────────── */

export function webhookEndpoint(): WebhookEndpointDto {
  return {
    id: ID, owner_kind: "Tenant", url_template: "https://example.test/hook", event_filter: "*", enabled: true,
    description: null, failure_count: 0, last_success_at: null, last_failure_at: null, secret: null,
  };
}

export function webhookDelivery(): WebhookDeliveryDto {
  return {
    id: ID, event_type: "booking.created", url: "https://example.test/hook", response_status: 200, latency_ms: 10,
    attempt: 1, final_state: "delivered", created_at: AT, response_body_excerpt: null,
  };
}

export function biometricEnrollAnswer(): Reply<typeof endpoints.adminBiometricEnroll> {
  return { template_id: "t" };
}

export function biometricEnrollment(): BiometricEnrollmentRow {
  return { user_id: ID, full_name: "Priya Naidoo", email: "priya@example.test", photo_url: null, membership_number: "C-1", templates: [biometricTemplate()] };
}

export function biometricTemplate(): BiometricEnrollmentRow["templates"][number] {
  return { template_id: "t", finger_label: null, created_at: AT };
}

export function revenueReport(): RevenueReport {
  return {
    from: AT, to: AT, gross_topups_zar: 0, reversals_zar: 0, net_zar: 0, gross_topups_minutes: 0, reversals_minutes: 0,
    net_minutes: 0,
  };
}

export function utilisationReport(): Reply<typeof endpoints.reportUtilisation> {
  return { from: AT, to: AT, by_court: [utilisationRow()] };
}

export function utilisationRow(): UtilisationRow {
  return { court_id: ID, court_number: 1, court_name: "Court 1", slices: 1, booked_minutes: 20, bookings: 1, kept_minutes: 8, sold_minutes: 8 };
}

export function noShowReport(): Reply<typeof endpoints.reportNoShows> {
  return { from: AT, to: AT, total: 0, no_show: 0, no_show_pct: 0 };
}

export function dailyAdminPoint(): DailyAdminPoint {
  return {
    date: "2026-09-30", top_ups_minutes: 0, booking_charges_minutes: 0, refunds_minutes: 0, penalties_minutes: 0,
    adjustments_minutes: 0, reversals_minutes: 0, share_transfers_minutes: 0, net_movement_minutes: 0, bookings: 0, no_shows: 0,
  };
}

/* ─────────────────────────────── devices, courts, doors ─────────────────────────────── */

export function adminDevice(): AdminDevice {
  return {
    id: ID, device_code: "box-1", name: "Court box", kind: "CourtBox", hardware: "Esp32", court_numbers: [1], gate_key: null,
    mac_address: null, enabled: true, last_seen_at: AT, last_ip_address: null, running_version: null, mega_version: null,
    created_at: AT, auto_registered: true, button_map: null, effective_heartbeat_seconds: 30, offline_after_seconds: 90,
  };
}

/** A door row as the Doors page READS it, `shut_by_shut_all_at` included. */
export function adminDoorDevice(): AdminDoorDevice {
  return {
    ...adminDevice(), location_note: null, power_loss_behaviour: "not_established", out_of_service_since: null,
    shut_by_shut_all_at: null, shut_by_name: null, shut_heard_at: null, events_lost: 0, events_lost_reported_at: null,
  };
}

export function deviceDeleteAnswer(): Reply<typeof endpoints.adminDeviceDelete> {
  return { deleted: true };
}

export function deviceActivityPage(): DeviceActivityPage {
  return { items: [], events: [] };
}

export function deviceActivityEntry(): DeviceActivityEntry {
  return { at: AT, action: "gate.released", reason: null, offline: false, delivered_at: null, member: null, fingerprint: null, time_uncertain: false };
}

export function deviceActivityMember(): NonNullable<DeviceActivityEntry["member"]> {
  return { id: ID, name: "Priya Naidoo" };
}

export function doorEventEntry(): DoorEventEntry {
  return { at: AT, action: "device.updated", kind: "renamed", change: "renamed", actor_name: null, count: 1 };
}

export function deviceApiKey(): DeviceApiKey {
  return { api_key: "k", regenerated_at: AT };
}

export function adminCourt(): AdminCourt {
  return { id: ID, court_number: 1, name: "Court 1", court_type: "Squash", is_active: true };
}

export function courtCreateAnswer(): Reply<typeof endpoints.adminCourtsCreate> {
  return { id: ID, court_number: 1 };
}

export function courtUpdateAnswer(): Reply<typeof endpoints.adminCourtsUpdate> {
  return { saved: true };
}

export function courtDeleteAnswer(): Reply<typeof endpoints.adminCourtsDelete> {
  return { deactivated: true };
}

export function doorsView(): DoorsView {
  return {
    day_started_at: AT, timezone: "Africa/Johannesburg", shut_all_active: false, shut_together: [doorName()],
    shut_individually: [doorName()], doors: [],
  };
}

export function doorName(): NonNullable<DoorsView["shut_together"]>[number] {
  return { id: ID, name: "Front door", gate_key: "front" };
}

export function doorRow(): DoorRow {
  return { device: adminDoorDevice(), today: { released: 0, refused: 0 }, signals: [] };
}

export function doorSignal(): DoorSignal {
  return { kind: "refusal_spike", since: AT, until: AT, scans: 5 };
}

export function doorLogPage(): DoorLogPage {
  return {
    items: [], next_cursor: null, retention_days: 90, total: 0, timezone: "Africa/Johannesburg", range: { from: AT, to: AT },
    removed_doors: [],
  };
}

export function doorLogEntry(): DoorLogEntry {
  return { ...deviceActivityEntry(), door: doorLogDoor() };
}

export function doorLogDoor(): DoorLogDoor {
  return { id: ID, name: "Front door", gate_key: "front", removed: false };
}

export function removedDoor(): NonNullable<DoorLogPage["removed_doors"]>[number] {
  return { key: ID, name: "Old door", gate_key: null };
}

export function fleetResult(): FleetResult {
  return { doors: [fleetDoor()], left_shut: [doorName()] };
}

export function fleetDoor(): FleetDoorResult {
  return {
    id: ID, name: "Front door", gate_key: "front", enabled: false, last_seen_at: AT, offline_after_seconds: 90,
    power_loss_behaviour: "not_established",
  };
}

/* ─────────────────────────────── play (lib/playApi.ts) ─────────────────────────────── */

export function adminResultsPage(): AdminResultsPage {
  return { items: [], next_cursor: null, count: 0 };
}

export function adminResult(): AdminResult {
  return {
    result_id: ID, booking_id: ID, status: "disputed", format: "best_of_3", games: [], games_won: { a: 2, b: 1 }, winner: "a",
    sides: { a: [], b: [] }, submitted_by: { user_id: ID, name: "Priya Naidoo" }, submitted_at: AT, edited_at: null,
    version: 1, confirm_due_at: null, confirmed_at: null, auto_confirmed: false, confirmed_by: null, disputed_at: AT,
    disputed_by: null, dispute_note: null, closed_at: null, closed_by_admin: false, court_name: "Court 1", starts_at: AT,
    organiser: { user_id: ID, name: "Priya Naidoo" },
  };
}

export function disputedCount(): { count: number } {
  return { count: 0 };
}

export function adminMemberPlay(): AdminMemberPlay {
  return {
    sessions_attended: 0, minutes_this_month: 0, minutes_all_time: 0, current_streak_weeks: 0, matches_played: 0,
    matches_won: 0, matches_lost: 0, open_disputes: 0, badges_earned: 0,
  };
}

/* ─────────────────────────────── players at the desk (lib/playersApi.ts) ─────────────────────────────── */

export function addPlayersAnswer(): AddPlayersAnswer {
  return { booking_id: ID, participants: [addedParticipant()] };
}

export function addedParticipant(): AddedParticipant {
  return {
    participant_id: ID, seat: 2, user_id: ID, guest_name: null, status: "invited", share_minutes: 4, invite_token: null,
    invite_path: null,
  };
}

export function seatAnswer(): SeatAnswer {
  return { participant_id: ID, status: "accepted" };
}

export function returnAnswer(): ReturnAnswer {
  return { participant_id: ID, status: "removed", return_waiting: false, return_minutes: null };
}

export function collectAnswer(): CollectAnswer {
  return { participant_id: ID, collected_minutes: 4, balance_after_minutes: -4 };
}

/* ─────────────────────────────── notifications (lib/notificationsApi.ts) ─────────────────────────────── */

export function adminNoticePage(): AdminNoticePage {
  return { items: [], next_cursor: null };
}

export function adminNotice(): AdminNotice {
  return {
    id: ID, kind: "member.registered", title: "…", headline: "…", link: null, subject_user_id: null, created_at: AT,
    delivery: adminNoticeDelivery(),
  };
}

export function adminNoticeDelivery(): AdminNotice["delivery"] {
  return { state: "sent", sent_at: AT, finished_at: AT, recipients: 1 };
}

export function adminNoticeKinds(): { kinds: AdminNoticeKind[] } {
  return { kinds: [adminNoticeKind()] };
}

export function adminNoticeKind(): AdminNoticeKind {
  return { kind: "member.registered", title: "…", description: "…", optional: true, opted_out: false, others_receiving: 0 };
}
