import { api } from "./api";

/**
 * The ecosystem admin wire — Monitoring, schedules, member groups, the change record.
 *
 * <p>
 * <b>Why a second module rather than more of `lib/api.ts`.</b> That file is 2 400 lines and
 * four lanes are editing it at once; appending eight surfaces to the middle of it is eight
 * conflicts instead of one file. The doors lane made the same call and appended one block —
 * this goes one step further and takes a file, because these surfaces share nothing with the
 * member app and everything with each other.
 * </p>
 *
 * <p>
 * <b>The shapes are D2's consolidated WIRE, exactly, and where D3 disagreed D2 wins.</b> Three
 * places that matters, because a reader coming from the UX design will look for the other
 * spelling: groups are <code>/admin/member-groups</code>, not <code>/admin/groups</code>;
 * schedules are <code>/admin/schedules</code>, not <code>/admin/schedule/plans</code>; and a
 * fault is <b>resolved</b>, with a note — there is no acknowledge endpoint, so there is no
 * acknowledge control.
 * </p>
 *
 * <p>
 * <b>Every field the backend has not built yet is optional, and absent never means false.</b>
 * Three backend lanes are writing these endpoints in parallel with this screen. A page that
 * reads <code>row.stale</code> as a boolean gets <code>false</code> from an API that has not
 * shipped the field — which is the screen asserting freshness it cannot know, on a wall, in a
 * club. So the unknowns are typed `| undefined` and the copy layer takes three arms.
 * </p>
 *
 * <p>
 * <b>Requests bind camelCase; responses are snake_case.</b> That asymmetry is this repo's
 * existing contract (`AdminConfigEndpoints` GET versus PUT) and D2 §13 restates it rather
 * than changing it. Getting it backwards is silent: the server binds what it recognises and
 * ignores the rest, so a mis-cased key is a field that never arrives and a save that reports
 * success.
 * </p>
 *
 * <p>
 * <b>D2 contradicts itself about this and the merged backend settles it.</b> §13 states the
 * camelCase-in / snake_case-out convention; §4.5 then illustrates the group bodies in
 * snake_case (<code>user_ids</code>, <code>multiplier_bps</code>, <code>max_slots_per_day</code>),
 * which reads as a second convention and is not one. `MemberGroupEndpoints.cs` binds
 * `MemberGroupRequest(Name, Description, Status, Pricing, Caps, Windows)`,
 * `GroupMembersRequest(UserIds)` and `PreviewRequest(UserId, Day, ProposedGroupIds)` as
 * ordinary records with no naming policy and no `[JsonPropertyName]`, so ASP.NET binds them
 * from camelCase. §13 is right, §4.5's illustration is loose, and this file follows §13 —
 * checked against the endpoint rather than argued from the document.
 * </p>
 */

/** Query string from the fields that are actually set. `?` only when there is something to say. */
function qs(o: Record<string, string | number | boolean | undefined | null>): string {
  const parts = Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

// ---------------------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------------------

/**
 * The one weekday spelling in the product — `OperatingHours`' own, in `DayOfWeek` order so
 * the index IS the enum value. D2 §4.5 is explicit that there is one, and a second spelling
 * is how a group window lands on the wrong day.
 */
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = typeof WEEKDAYS[number];

/**
 * How a ranged read is asked for: one spelling, never two. The server refuses
 * `range_conflict` for a request that names a range twice, which is `DoorLogQuery`'s rule
 * reused across every new endpoint here (D2 §13).
 */
export type AdminRange = { period?: string; day?: string; from?: string; to?: string };

/**
 * A person, as every one of these payloads names one.
 *
 * `name` is what the server resolved at read time; `photo_url` is absent on the surfaces
 * that do not carry it. Never an email — the grid's own invariant, and the reason photo
 * upload is mandatory at registration.
 */
export type AdminPerson = {
  user_id: string;
  name: string;
  photo_url?: string | null;
};

/**
 * What a bulk write answers per item. D2 §5.1: these endpoints are partial by nature and
 * never all-or-nothing, so the answer is one row per item and the screen shows all of them.
 */
export type AdminItemResult = {
  id: string;
  status: string;
  error?: string | null;
};

export type AdminBulkResult = {
  requested: number;
  succeeded: number;
  failed: number;
  results: AdminItemResult[];
};

// ---------------------------------------------------------------------------------------
// Control board — GOAL item 10 (D2 §10.2)
// ---------------------------------------------------------------------------------------

/**
 * What the server BELIEVES a court's lights are doing.
 *
 * <p>
 * Three values and the third is not a defensive default. `IRelayClient` is not registered in
 * the container — the court box is pull-only and does its own switching — so `unknown` is the
 * honest answer whenever the box has not told the server anything it can still stand behind.
 * The tiles are worded from this, never around it (ruling 7).
 * </p>
 */
export type LightState = "on" | "off" | "unknown";

/** Why the lights are on. `restore_after_power_dip` is item 17's, and nothing emits it yet. */
export type LightCause = "member" | "walk_up" | "admin" | "restore_after_power_dip" | "unknown";

/**
 * A board's link, as five states rather than two.
 *
 * `silent` is the one with no name on any screen today and the one an admin most wants: past
 * one heartbeat, short of the offline threshold. Derived once on the server so the wall and
 * the Devices page cannot disagree.
 */
export type DeviceLink = "online" | "silent" | "offline" | "out_of_service" | "unlinked";

export type ControlBoardLights = {
  state: LightState;
  since?: string | null;
  until?: string | null;
  seconds_remaining?: number | null;
  /**
   * The box has been dark for longer than twice its effective heartbeat.
   *
   * <p>
   * <b>Optional, and `undefined` is a third answer.</b> An API that has not shipped the field
   * cannot be read as "not stale" — that is the screen asserting freshness out of a gap. The
   * tile says "the box last spoke at HH:MM" and makes no claim either way.
   * </p>
   */
  stale?: boolean;
  as_of?: string | null;
  /**
   * <b>What the BOX said, kept apart from what the server believes.</b>
   *
   * <p>
   * These two are the ones that license the word "confirmed", and nothing else does.
   * `stale: false` means only that the SERVER's own record is recent — it is a fact about the
   * activation the API granted, not about a relay. A tile that read `stale === false` as
   * confirmation would print "confirmed by the box" over a court no box has ever spoken
   * about, which is the exact failure this whole surface is built against.
   * </p>
   *
   * <p>
   * `null` rather than `"off"` for a board whose firmware does not report relay state, which
   * is every board in the field until the new image ships. Three states, not two.
   * </p>
   *
   * <p>
   * And when `confirmed_state` disagrees with `state`, BOTH are shown: a box reporting a
   * relay open while the server believes it granted nothing is a contradiction an admin must
   * see, not one the screen should resolve by picking a side and losing the evidence that
   * they ever disagreed.
   * </p>
   */
  confirmed_at?: string | null;
  confirmed_state?: LightState | null;
  turned_on_by?: (AdminPerson & { kind: LightCause }) | null;
  /** The booking the grant belongs to, for the tile's "open this booking" link. */
  from_booking_id?: string | null;
};

export type ControlBoardBooking = {
  booking_id?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  status?: string | null;
  /** `booking` | `walk_up` | `block` | `schedule` — a hold's kind, for the label below. */
  kind?: string | null;
  /** A block's or schedule's own name. A hold with no name is a hold nobody can ask about. */
  label?: string | null;
  booked_by?: AdminPerson | null;
  checked_in_at?: string | null;
  amount_credits?: number | null;
  minutes_until?: number | null;
};

export type ControlBoardDevice = {
  device_id?: string | null;
  device_code?: string | null;
  name?: string | null;
  relay?: string | null;
  link?: DeviceLink;
  last_seen_at?: string | null;
  silent_seconds?: number | null;
  offline_after_seconds?: number | null;
  firmware?: string | null;
  mega_version?: string | null;
  open_errors?: { critical?: number; error?: number; warning?: number; info?: number } | null;
};

export type ControlBoardCourt = {
  court_id: string;
  court_number: number;
  name: string;
  is_active?: boolean;
  lights?: ControlBoardLights | null;
  current?: ControlBoardBooking | null;
  next?: ControlBoardBooking | null;
  device?: ControlBoardDevice | null;
  /** The court's door, where one is mapped. Absent on a club that maps none. */
  door?: ControlBoardDevice | null;
};

export type ControlBoardView = {
  /** When the SERVER read this. Every payload carries it, and the wall shows it (D2 §8.3). */
  generated_at: string;
  timezone?: string;
  slice_minutes?: number;
  club_day?: string;
  courts: ControlBoardCourt[];
};

// ---------------------------------------------------------------------------------------
// IoT errors — GOAL item 7 (D2 §7)
// ---------------------------------------------------------------------------------------

/**
 * Severity, assigned server-side from the code and never taken from the device.
 *
 * A board cannot be trusted to grade its own faults, and a table where half the severities
 * are the firmware's opinion is not sortable. D2 §7.3.
 */
export const DEVICE_ERROR_SEVERITIES = ["critical", "error", "warning", "info"] as const;
export type DeviceErrorSeverity = typeof DEVICE_ERROR_SEVERITIES[number];

export type DeviceErrorState = "open" | "resolved" | "all";

export type DeviceErrorRow = {
  id: string;
  device_id?: string | null;
  device_code?: string | null;
  device_name?: string | null;
  device_kind?: string | null;
  /** `device` when a board reported it, `server` when the API detected it. */
  source?: string | null;
  code: string;
  severity: DeviceErrorSeverity;
  detail?: string | null;
  /** The relay index as the board reported it, for diagnosis only. */
  court?: number | null;
  first_seen_at: string;
  last_seen_at: string;
  count: number;
  resolved_at?: string | null;
  resolved_by_name?: string | null;
  resolution_note?: string | null;
  /**
   * The server's own plain sentence for this code.
   *
   * <p>
   * Read FIRST and the local dictionary second. The door console painted `device.updated` as
   * a green "Refused" scan because it held its own dictionary and the server's vocabulary
   * moved; a firmware release that adds a code must not go dark on this page.
   * </p>
   */
  headline?: string | null;
};

export type DeviceErrorCounts = { critical?: number; error?: number; warning?: number; info?: number };

export type DeviceErrorPage = {
  rows: DeviceErrorRow[];
  total?: number;
  cursor?: string | null;
  retention_days?: number;
  timezone?: string;
  counts?: DeviceErrorCounts;
};

export type MonitoringSummary = {
  open?: DeviceErrorCounts;
  by_device?: Array<{
    device_id: string;
    device_code?: string | null;
    device_name?: string | null;
    open?: number;
    worst?: DeviceErrorSeverity | null;
    last_seen_at?: string | null;
    link?: DeviceLink;
  }>;
  last_24h?: { opened?: number; resolved?: number };
  worst_offender?: { device_code?: string | null; open?: number } | null;
};

export type DeviceErrorFilters = AdminRange & {
  device?: string;
  severity?: DeviceErrorSeverity;
  code?: string;
  state?: DeviceErrorState;
  cursor?: string;
  limit?: number;
};

// ---------------------------------------------------------------------------------------
// The night trace — GOAL item 6 (D2 §6)
// ---------------------------------------------------------------------------------------

/**
 * Which half of the club an event came from. Four strands, unioned in the server's memory
 * and returned as one chronological list — oldest first, because a night reads forwards.
 */
export type TraceStrand = "door" | "booking" | "court" | "lights" | "wallet" | "unknown";

/**
 * Who did it — and `is_admin` is NOT "the actor is not the subject".
 *
 * <p>
 * That conflation is D2-B41: it makes every automatic no-show sweep claim an admin did it.
 * `system` is a real state — `Guid.Empty` is what the no-show worker actually writes — and a
 * system row's headline says so in words, which is the sentence a member disputing a penalty
 * is entitled to.
 * </p>
 */
export type TraceActor = {
  user_id?: string | null;
  name?: string | null;
  kind?: "system" | "device" | "admin" | "member";
  is_self?: boolean;
  is_admin?: boolean;
};

export type TraceEvent = {
  at: string;
  strand?: TraceStrand;
  /** A closed vocabulary. An action the server has no word for arrives as `unrecognised`. */
  kind: string;
  /** Composed on the SERVER, for the reason the door console's own dictionary is a warning. */
  headline?: string | null;
  detail?: Record<string, unknown> | null;
  actor?: TraceActor | null;
  subject?: AdminPerson | null;
  court?: { id?: string; number?: number; name?: string } | null;
  amount_credits?: number | null;
  balance_after_credits?: number | null;
  /** The instant came from a board's own clock after an outage, so it may be minutes out. */
  approximate?: boolean;
  device_code?: string | null;
  outage_id?: string | null;
  source?: string | null;
  source_id?: string | null;
};

export type TraceView = {
  member: AdminPerson & { membership_number?: string | null };
  club_day?: string;
  range?: { from: string; to: string };
  timezone?: string;
  /**
   * The two different horizons, both stated.
   *
   * Audit rows live to `retention_years`; door rows are DELETED at `door_log_retention_days`.
   * An empty door strand 120 days back must not read as "she was not here", so the flag says
   * "may be incomplete" — which is the only claim the data supports.
   */
  retention?: {
    audit_days?: number;
    door_days?: number;
    door_horizon?: string | null;
    door_rows_may_be_incomplete?: boolean;
  };
  summary?: {
    first_seen_at?: string | null;
    last_seen_at?: string | null;
    minutes_on_court?: number;
    courts?: string[];
    credits_spent?: number;
    credits_received?: number;
    doors_entered?: number;
    doors_refused?: number;
    bookings_made?: number;
    bookings_cancelled?: number;
  };
  events: TraceEvent[];
  total?: number;
  cursor?: string | null;
};

// ---------------------------------------------------------------------------------------
// The admin change record — GOAL item 14 (D2 §11.6-11.7)
// ---------------------------------------------------------------------------------------

export const ADMIN_CHANGE_AREAS = [
  "schedule", "booking", "credit", "group", "member", "setting", "device",
  // P12 — `AdminChangeAreas.Play`: a match result voided or upheld (play.md §6.3).
  "play",
] as const;

export type AdminChangeRow = {
  id: string;
  occurred_at: string;
  /**
   * DENORMALISED on the server, on purpose: a renamed, anonymised or deleted member must not
   * change what the history says happened.
   */
  actor?: { user_id?: string | null; name?: string | null; email?: string | null } | null;
  area?: string;
  action?: string;
  headline?: string | null;
  subject?: { kind?: string | null; id?: string | null; label?: string | null } | null;
  reason?: string | null;
  /**
   * A field-level diff, with the values already RENDERED — "18:00", not 1080; a court's name,
   * not its id. A volunteer reading their own audit trail cannot be handed minutes past
   * midnight.
   */
  changes?: Array<{ field: string; label?: string | null; before?: string | null; after?: string | null }> | null;
};

export type AdminChangePage = {
  rows: AdminChangeRow[];
  total?: number;
  cursor?: string | null;
  timezone?: string;
  /** The server's own sentence about how long these are kept. Never composed here. */
  retention?: string | null;
};

export type AdminChangeFilters = AdminRange & {
  area?: string;
  action?: string;
  actor?: string;
  subject_kind?: string;
  subject_id?: string;
  cursor?: string;
  limit?: number;
};

// ---------------------------------------------------------------------------------------
// Schedules — GOAL item 14 (D2 §11)
// ---------------------------------------------------------------------------------------

/**
 * The recurrence, as D2 chose it: a bounded weekly rule, not RFC 5545.
 *
 * <p>
 * The stored form has to be readable by a volunteer inside a refusal message. "Tuesdays
 * 18:00–21:00 until 15 December" is; `FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T000000Z` is not,
 * and a refusal quoting it is one nobody can act on. The columns map one-to-one onto an
 * RRULE if an export is ever wanted, so the choice is reversible.
 * </p>
 */
export type ScheduleBody = {
  name: string;
  label: string;
  days: Weekday[];
  /** `HH:mm`, club-local. No midnight crossing — the server refuses `end <= start`. */
  start: string;
  end: string;
  startDate: string;
  endDate?: string | null;
  intervalWeeks?: number;
  /**
   * The court ids, under the name the server's `ScheduleRequest` binds — `courts`, NOT
   * `courtIds`. Review round 1 found the screen sending `courtIds` and every create refused;
   * `AdminSchedules.test.tsx` now reads the C# record so the two cannot drift apart again.
   */
  courts: string[];
};

/**
 * A this-and-future edit. The server parses it as a WHOLE rule (`ScheduleUpdateRequest` →
 * `ScheduleRequest`), so every field travels, not just the one that changed — a body with only
 * new hours is a rule with no name, and was refused as one.
 */
export type ScheduleUpdateBody = ScheduleBody & { effectiveFrom?: string; reason?: string };

/** The rule a stored row describes, in the request's shape, for an edit to start from. */
export function scheduleBodyOf(row: ScheduleRow): ScheduleBody {
  return {
    name: row.name,
    label: row.label,
    days: row.days ?? [],
    start: row.start ?? "",
    end: row.end ?? "",
    startDate: row.start_date ?? "",
    endDate: row.end_date ?? null,
    intervalWeeks: row.interval_weeks ?? 1,
    courts: (row.courts ?? []).map((c) => c.id),
  };
}

export type ScheduleConflict = {
  occurrence_date: string;
  court_id: string;
  court_name?: string | null;
  starts_at: string;
  ends_at?: string | null;
  booking_id?: string | null;
  status?: string | null;
  kind?: string | null;
  label?: string | null;
  member_name?: string | null;
  amount_credits?: number | null;
  /**
   * From the server's own cancellation quote, so the figure an admin reads before deciding is
   * the figure the cancellation will actually pay.
   */
  would_refund_credits?: number | null;
};

export type SchedulePreview = {
  occurrences: number;
  first?: string | null;
  last?: string | null;
  rows_to_create?: number;
  conflicts: ScheduleConflict[];
};

export type ScheduleRow = {
  id: string;
  name: string;
  label: string;
  days?: Weekday[];
  start?: string;
  end?: string;
  start_date?: string;
  end_date?: string | null;
  interval_weeks?: number;
  status?: "active" | "ended";
  courts?: Array<{ id: string; name: string }>;
  next_occurrence?: string | null;
  occurrences_ahead?: number;
  materialised_through?: string | null;
  created_by_name?: string | null;
  created_at?: string;
};

export type ScheduleOccurrence = {
  date: string;
  starts_at?: string;
  ends_at?: string;
  status?: "scheduled" | "skipped" | "overridden" | "past";
  courts?: Array<{ court_id: string; court_name?: string | null; booking_id?: string | null }>;
};

// ---------------------------------------------------------------------------------------
// Member groups — GOAL items 3 + 19 (D2 §4)
// ---------------------------------------------------------------------------------------

export const GROUP_PRICING_MODES = ["inherit_court", "multiplier", "flat_per_slice"] as const;
export type GroupPricingMode = typeof GROUP_PRICING_MODES[number];

export type GroupWindow = { day: Weekday; start: string; end: string };

export type MemberGroup = {
  id: string;
  name: string;
  description?: string | null;
  status?: "active" | "archived";
  sort_order?: number;
  /** The two seeded groups: renameable and editable, never deletable. */
  is_system_default?: boolean;
  pricing?: {
    mode?: GroupPricingMode;
    multiplier_bps?: number | null;
    flat_slice_price_credits?: number | null;
    /** What one slice would actually cost on this club's courts, computed by the server. */
    effective_example_credits?: number | null;
  };
  caps?: {
    max_slots_per_day?: number | null;
    max_minutes_per_day?: number | null;
    advance_booking_days?: number | null;
  };
  windows?: GroupWindow[];
  member_count?: number;
  /**
   * D2: `"league"` on the group that replaced the league / over-65 class, null on every group an
   * admin made. A group with a key is one the product relies on, so it can be renamed and edited
   * and never archived or deleted (409 `group_is_system_default`) — the screen hides both.
   */
  system_key?: string | null;
  /**
   * D2: the top-up rate this group carries, credits per one unit of the club's money — or null,
   * which INHERITS the club's `credits_per_zar_regular` and has no say in a member's rate.
   */
  credits_per_zar?: number | null;
  /**
   * D2, tri-state: `true` grants peak priority, `false` withholds it (and wins over any grant),
   * `null` has no say. Absent (an API that predates it) is none of the three.
   */
  peak_priority?: boolean | null;
};

/** A group's say on the peak window: grants, withholds, or none. */
export type PeakSay = boolean | null;

export type MemberGroupBody = {
  name: string;
  description?: string | null;
  pricing: { mode: GroupPricingMode; multiplierBps?: number; flatSlicePriceCredits?: number };
  caps: { maxSlotsPerDay?: number | null; maxMinutesPerDay?: number | null; advanceBookingDays?: number | null };
  windows: GroupWindow[];
  /** Absent = unchanged; null = inherit the club's rate; else (0, 1000], at most 4 decimals. */
  creditsPerZar?: number | null;
  /** Absent = unchanged; true grants, false withholds, null has no say. */
  peakPriority?: PeakSay;
};

/**
 * What a member's groups add up to for money and the peak window — the server's resolution
 * (`MemberTariffs.Resolve`), never re-derived on a screen that then disagrees with the top-up.
 */
export type MemberTariff = {
  top_up_credits_per_zar: number;
  /** The group the rate comes from; null when it is the club's default rate. */
  rate_group_id: string | null;
  peak_priority: boolean;
  /** The groups explicitly withholding peak priority, by name. Empty when nothing withholds it. */
  peak_withheld_by: string[];
};

/** A group as a member row or the member detail names it (D2). */
export type MemberGroupChip = {
  id: string;
  name: string;
  system_key?: string | null;
  credits_per_zar?: number | null;
  peak_priority?: boolean | null;
};

/** `PUT /admin/members/{userId}/groups` — the WHOLE set, replaced, and what it resolved to. */
export type MemberGroupsSetResult = {
  user_id: string;
  groups: MemberGroupChip[];
  added: string[];
  removed: string[];
  tariff: MemberTariff;
};

/** `POST /admin/member-groups/preview` — nothing saved; what applies now, and what would. */
export type MemberGroupPreview = {
  current: MemberBookingRules;
  would_be: MemberBookingRules;
};

/**
 * What a named member may actually book — the intersection of every rule that applies.
 *
 * <p>
 * `empty_window_reason` present means the member is in two groups whose times do not overlap
 * and there is nothing at all they can book that day. It is a real, reachable state of the
 * intersection semantics and it is named rather than rendered as an empty grid, which reads
 * as "the club is shut".
 * </p>
 */
export type MemberBookingRules = {
  groups?: Array<{ id: string; name: string; description?: string | null }>;
  allowed_windows?: Array<{ start: string; end: string }>;
  club_hours?: { start: string; end: string } | null;
  slice_price_credits?: number | null;
  max_slots_per_day?: number | null;
  max_minutes_per_day?: number | null;
  advance_booking_days?: number | null;
  empty_window_reason?: { groups?: string[]; day?: string } | null;
  /** The server's spelling of the same fact: the groups whose times leave nothing, or null. */
  empty_window_groups?: string[] | null;
  changes_from_current?: Record<string, unknown> | null;
  /** D2: the top-up rate and peak standing these groups add up to. */
  tariff?: MemberTariff;
};

// ---------------------------------------------------------------------------------------
// Admin credit — GOAL item 8's admin half (D2 §9.3)
// ---------------------------------------------------------------------------------------

/**
 * What KIND of hand movement this is — required, and the three top-up codes post a different
 * ledger type from the four adjustment ones.
 *
 * <p>
 * The reason this exists at all is a reporting defect, not tidiness: revenue is `top_up` net
 * of reversals, so an admin taking R200 in cash at the desk and adjusting the member up posts
 * an `AdminAdjustment`, which is not counted — the club's own revenue figure is wrong by every
 * cash top-up it takes. The free-text reason stays required as well: the code says what kind,
 * the reason says why this one, and month-end needs both.
 * </p>
 */
export const TOP_UP_REASON_CODES = ["top_up_cash", "top_up_eft", "top_up_card_offline"] as const;
export const ADJUSTMENT_REASON_CODES = ["goodwill", "correction", "refund_outside_system", "other"] as const;
export const ADJUST_REASON_CODES = [...TOP_UP_REASON_CODES, ...ADJUSTMENT_REASON_CODES] as const;
export type AdjustReasonCode = typeof ADJUST_REASON_CODES[number];

export type AdminAdjustResult = {
  entry_id: string;
  /** `AdminTopUp` or `AdminAdjustment`, decided by the reason code. */
  type?: string;
  amount_credits: number;
  /**
   * Where the member was BEFORE, from the server.
   *
   * <p>
   * On the response rather than composed here from a balance the console fetched separately:
   * an adjustment is only reviewable if the row says where it took the member from and to,
   * and two numbers read at two different instants are not a movement.
   * </p>
   */
  balance_before_credits?: number | null;
  balance_after_credits: number;
  member?: AdminPerson | null;
};

// ---------------------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------------------

export const adminEndpoints = {
  // --- Control board (item 10) -----------------------------------------------------------
  controlBoard: () => api.get<ControlBoardView>("/api/v1/admin/control-board"),
  /**
   * A one-minute, purpose-scoped ticket for the stream.
   *
   * `EventSource` cannot set an Authorization header, and the alternative — a real access
   * token in the query string — was found in nginx's `$request` log once already. A control
   * board ticket must not open a wallet stream, which is why each stream mints its own.
   */
  controlBoardTicket: () => api.post<{ ticket: string }>("/api/v1/admin/control-board/stream-ticket", {}),
  controlBoardStreamUrl: (ticket: string) =>
    `/api/v1/admin/control-board/stream?ticket=${encodeURIComponent(ticket)}`,

  // --- IoT errors (item 7) ---------------------------------------------------------------
  monitoringErrors: (filters: DeviceErrorFilters = {}) =>
    api.get<DeviceErrorPage>(`/api/v1/admin/monitoring/errors${qs({ ...filters })}`),
  monitoringSummary: () => api.get<MonitoringSummary>("/api/v1/admin/monitoring/summary"),
  monitoringErrorsCsvUrl: (filters: DeviceErrorFilters = {}) =>
    `/api/v1/admin/monitoring/errors.csv${qs({ ...filters })}`,
  /** One fault, with the note that says what was actually done about it. */
  resolveError: (id: string, note: string) =>
    api.post<DeviceErrorRow>(`/api/v1/admin/monitoring/errors/${id}/resolve`, { note }),
  /** Several. Partial by design — the answer is one row per id, and the screen shows them. */
  resolveErrors: (ids: string[], note: string) =>
    api.post<AdminBulkResult>("/api/v1/admin/monitoring/errors/resolve-bulk", { ids, note }),
  monitoringTicket: () => api.post<{ ticket: string }>("/api/v1/admin/monitoring/stream-ticket", {}),
  monitoringStreamUrl: (ticket: string) =>
    `/api/v1/admin/monitoring/stream?ticket=${encodeURIComponent(ticket)}`,

  // --- The night trace (item 6) ----------------------------------------------------------
  /**
   * <b>The member is a PATH segment, and that is the structural rule.</b>
   *
   * <p>
   * The doors contract forbids a per-member filter on the door log, and `DoorLogQuery` makes
   * that real by having no field to put a member in. A query parameter here would eventually
   * be made optional by somebody, and an optional member filter on a log IS the thing the
   * contract exists to prevent. You cannot discover a person from the door log; you can only
   * ask about a person you already named.
   * </p>
   *
   * <p>
   * A 200 writes an `admin_change_log` row naming the admin, the member and the night. The
   * page says so before the read, and the failure copy says the row was not written — because
   * otherwise the notice is a lie.
   * </p>
   */
  memberTrace: (userId: string, range: AdminRange & { cursor?: string; limit?: number } = {}) =>
    api.get<TraceView>(`/api/v1/admin/members/${userId}/trace${qs({ ...range })}`),
  memberTraceCsvUrl: (userId: string, range: AdminRange = {}) =>
    `/api/v1/admin/members/${userId}/trace.csv${qs({ ...range })}`,

  // --- The change record (item 14) -------------------------------------------------------
  adminChanges: (filters: AdminChangeFilters = {}) =>
    api.get<AdminChangePage>(`/api/v1/admin/changes${qs({ ...filters })}`),
  adminChangesCsvUrl: (filters: AdminChangeFilters = {}) =>
    `/api/v1/admin/changes.csv${qs({ ...filters })}`,

  // --- Schedules (item 14) ---------------------------------------------------------------
  schedules: (status: "active" | "ended" | "all" = "active") =>
    api.get<{ schedules: ScheduleRow[] }>(`/api/v1/admin/schedules${qs({ status })}`),
  schedule: (id: string) => api.get<ScheduleRow>(`/api/v1/admin/schedules/${id}`),
  scheduleOccurrences: (id: string, range: { from?: string; to?: string } = {}) =>
    api.get<{ occurrences: ScheduleOccurrence[] }>(`/api/v1/admin/schedules/${id}/occurrences${qs({ ...range })}`),
  scheduleChanges: (id: string) =>
    api.get<AdminChangePage>(`/api/v1/admin/schedules/${id}/changes`),
  /**
   * The dry run. `POST /schedules` runs the same check and answers 409 `schedule_conflicts`
   * if there are any — there is no force flag, by decision: a member who paid must be
   * refunded deliberately, through a cancellation.
   */
  schedulePreview: (body: ScheduleBody) =>
    api.post<SchedulePreview>("/api/v1/admin/schedules/preview", body),
  scheduleCreate: (body: ScheduleBody) => api.post<ScheduleRow>("/api/v1/admin/schedules", body),
  /**
   * This and future. `effectiveFrom` is clamped to never be earlier than the club's today —
   * an admin typing last Tuesday means "from now on" — and the response says it was clamped.
   */
  scheduleUpdate: (id: string, body: ScheduleUpdateBody) =>
    api.patch<ScheduleRow & { effective_from_clamped_to?: string }>(`/api/v1/admin/schedules/${id}`, body),
  /** Only this occurrence: skip it, or move its hours. A past date is refused, never rewritten. */
  scheduleOccurrenceUpdate: (
    id: string,
    date: string,
    body: { skip?: boolean; start?: string; end?: string; reason?: string },
  ) => api.patch<ScheduleOccurrence>(`/api/v1/admin/schedules/${id}/occurrences/${date}`, body),
  /** There is no delete. A schedule that ran is history; ending it is the operation. */
  scheduleEnd: (id: string, body: { effectiveFrom?: string; reason?: string }) =>
    api.post<ScheduleRow>(`/api/v1/admin/schedules/${id}/end`, body),

  // --- Member groups (items 3 + 19) ------------------------------------------------------
  memberGroups: () => api.get<{ groups: MemberGroup[] }>("/api/v1/admin/member-groups"),
  memberGroupCreate: (body: MemberGroupBody) =>
    api.post<MemberGroup>("/api/v1/admin/member-groups", body),
  /**
   * `reason` is the admin's own words for the change record — the screen requires one to archive
   * (D2: an archive changes what every member of the group pays and may book).
   */
  memberGroupUpdate: (
    id: string,
    body: Partial<MemberGroupBody> & { status?: "active" | "archived"; reason?: string },
  ) => api.patch<MemberGroup>(`/api/v1/admin/member-groups/${id}`, body),
  /** Refused, never cascaded, while the group has members — archiving is the escape. */
  memberGroupDelete: (id: string) => api.del<void>(`/api/v1/admin/member-groups/${id}`),
  memberGroupMembers: (id: string, page: { cursor?: string; limit?: number } = {}) =>
    api.get<{
      members: Array<AdminPerson & { membership_number?: string | null; added_at?: string; added_by_name?: string | null }>;
      total?: number;
      cursor?: string | null;
    }>(`/api/v1/admin/member-groups/${id}/members${qs({ ...page })}`),
  memberGroupAddMembers: (id: string, userIds: string[]) =>
    api.post<AdminBulkResult>(`/api/v1/admin/member-groups/${id}/members`, { userIds }),
  memberGroupRemoveMember: (id: string, userId: string) =>
    api.del<void>(`/api/v1/admin/member-groups/${id}/members/${userId}`),
  /** What WOULD apply, nothing saved — so a membership change states its consequence first. */
  memberGroupPreview: (body: { userId: string; day?: string; proposedGroupIds: string[] }) =>
    api.post<MemberGroupPreview>("/api/v1/admin/member-groups/preview", body),
  /**
   * One member's groups, set whole (D2 — replaces the deleted `POST /admin/members/{id}/class`).
   * Replace, not patch: "which groups is this person in" is the question the screen answers, and
   * N add/remove calls would be N chances to leave them half-moved.
   */
  memberGroupsSet: (userId: string, body: { groupIds: string[]; reason?: string }) =>
    api.put<MemberGroupsSetResult>(`/api/v1/admin/members/${userId}/groups`, {
      groupIds: body.groupIds,
      ...(body.reason && body.reason.trim() ? { reason: body.reason.trim() } : {}),
    }),
  memberBookingRules: (userId: string, day?: string) =>
    api.get<MemberBookingRules>(`/api/v1/admin/members/${userId}/booking-rules${qs({ day })}`),

  // --- Admin credit (item 8's admin half) ------------------------------------------------
  /**
   * One hand movement of credit, with the KIND of movement it is.
   *
   * <p>
   * `amountCredits` is signed on the wire, exactly as it always was — the screen is what
   * refuses to offer one signed field (D3-B08), not the API. `reasonCode` is new and required;
   * a request without it is accepted for one release as `other`, and the console ships in the
   * same wave.
   * </p>
   */
  /**
   * Reset a member's code (the desk's "I lost my phone"). Round-1 contract §7: the request
   * carries the desk's REASON, which the change record keeps and the member's email quotes.
   * Takes the MEMBERSHIP id.
   */
  memberCodeReset: (membershipId: string, body: { revokePasskeys: boolean; reason: string }) =>
    api.post<{ rotated: boolean; generation: number; passkeys_revoked: boolean; passkeys_removed: number }>(
      `/api/v1/admin/members/${membershipId}/code/reset`, { revoke_passkeys: body.revokePasskeys, reason: body.reason }),
  adjustCredit: (
    userId: string,
    body: {
      amountCredits: number;
      reasonCode: AdjustReasonCode;
      reason: string;
      relatedBookingId?: string;
      /** Rand the desk received, for a top-up that counts as revenue (round-1 contract §5). */
      zarReceived?: number;
      idempotencyKey?: string;
    },
  ) => api.post<AdminAdjustResult>(`/api/v1/admin/credit/${userId}/adjust`, {
    amountCredits: body.amountCredits,
    reasonCode: body.reasonCode,
    reason: body.reason,
    ...(body.relatedBookingId ? { relatedBookingId: body.relatedBookingId } : {}),
    ...(body.zarReceived !== undefined ? { zarReceived: body.zarReceived } : {}),
    // Names THIS movement, so every retry of one intended adjustment is the same movement.
    // A changed payload under a reused key is a 409, not a silent replay of the old figure:
    // the admin corrected the amount and pressed Apply, and discarding the correction is the
    // worse of the two failures.
    ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
  }),
};
