import type { SettingComplaint } from "./tenantSettings";

/**
 * Every number this release made configurable, with the bound that makes it safe to type.
 *
 * <p>
 * <b>Ruling 13 is the whole reason this file exists:</b> every configurable number is a
 * `tenant_settings` key with validation and an admin settings row. Before this release, the
 * LCD's revert timeout, the rapid-scan window and the per-day slot ceiling were either
 * hardcoded in firmware or did not exist at all, and the one number that WAS a key —
 * `gate_unlock_seconds` — had a default of 3 seconds, which is not long enough to get a door
 * open while holding a bag.
 * </p>
 *
 * <p>
 * <b>The bounds are the API's, mirrored — never invented here.</b> The reason is the defect
 * `DoorSettings` already carries a paragraph about: a screen that bounds a field more loosely
 * than the server refuses it produces a save that fails with a message nobody on the screen
 * can act on, and one that bounds it more tightly silently forbids a club a value the product
 * supports. Every pair below is D2 §14's, and a test walks the table.
 * </p>
 *
 * <p>
 * <b>Every one of these keys is OPTIONAL on `AdminSettings`.</b> Three backend lanes are
 * building them in parallel with this screen; an API that does not serve a key gets no row
 * for it and no complaint about it, because omitted-means-unchanged on the way back and a
 * console that refused to save against an older API would take the whole settings page down
 * for one field.
 * </p>
 */

export type NumericSettingRule = {
  key: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  /** Whole numbers only. Every one of these is; the flag is here so the message can say so. */
  integer: true;
  /** What the value means when it is this. Only where a magic value exists — 0 = unlimited. */
  zeroMeans?: string;
};

/**
 * The device-facing timings — GOAL items 1, 2 and 18.
 *
 * <p>
 * These three reach the box through the heartbeat response with compile-time fallbacks in
 * the firmware, which is the only shape available: the court box is pull-only and is never
 * told anything except in the answer to a beat it made itself. A club that changes one of
 * these sees it take effect within one heartbeat, and the hints say so rather than implying
 * the change is instant.
 * </p>
 */
export const DEVICE_TIMING_RULES: readonly NumericSettingRule[] = [
  {
    key: "lcd_revert_seconds",
    label: "Screen returns to the start after (seconds)",
    hint: "5–120. GOAL item 1. How long the box's screen stays on a result — a scan, a refusal, "
      + "a court chosen — before it goes back to “Scan code to get started”. Every screen on "
      + "the box has this timeout, which is what stops one getting stuck with no way out.",
    min: 5, max: 120, integer: true,
  },
  {
    key: "rapid_scan_window_seconds",
    label: "Next person may scan within (seconds)",
    hint: "0–60. GOAL item 18. After somebody scans, the box stays ready for the next person "
      + "for this long and shows the time left. 0 turns rapid scanning off, and the box goes "
      + "straight back to the start after each scan.",
    min: 0, max: 60, integer: true, zeroMeans: "one person at a time",
  },
] as const;

/**
 * The per-day ceiling — GOAL item 19, and ruling 3 settles what it counts.
 *
 * <p>
 * Dean asked for a number of SLOTS, and the number already on disk is
 * `member_per_day_max_minutes`. Both stay: the most restrictive of the two applies, a group
 * may lower either and may never raise one, and admins are exempt. The two rows sit beside
 * each other under one sentence saying so, because a club that sets 4 slots and leaves 60
 * minutes has set an hour, and no single field would have told them.
 * </p>
 */
export const CAP_RULES: readonly NumericSettingRule[] = [
  {
    key: "member_max_slots_per_day",
    label: "Slots per member per day",
    hint: "0–96. GOAL item 19. The most slots any one member may hold on one day. 0 means no "
      + "limit. Admins are never limited.",
    min: 0, max: 96, integer: true, zeroMeans: "no limit",
  },
  {
    key: "admin_bulk_max_items",
    label: "Most bookings in one bulk action",
    hint: "1–500. How many slots an admin may book or cancel in one press. A league night on "
      + "4 courts × 3 hours at 15 minutes a slot is 48.",
    min: 1, max: 500, integer: true,
  },
] as const;

/** Repeating bookings — GOAL item 14's horizon and its two safety bounds. */
export const SCHEDULE_RULES: readonly NumericSettingRule[] = [
  {
    key: "schedule_materialisation_days",
    label: "Write repeating bookings this far ahead (days)",
    hint: "7–365. How far ahead a repeating booking is actually written into the diary. It "
      + "must be at least as far as members can book, or somebody books into a league night "
      + "that has not been written yet.",
    min: 7, max: 365, integer: true,
  },
  {
    key: "schedule_max_rows_per_change",
    label: "Most slots one repeating booking may hold",
    hint: "100–20000. A refusal rather than a limit anybody should reach: it stops one "
      + "mistyped end date holding out the whole club for two years.",
    min: 100, max: 20_000, integer: true,
  },
] as const;

/** Monitoring — how long a fault is kept, and how many one board may open. */
export const MONITORING_RULES: readonly NumericSettingRule[] = [
  {
    key: "device_error_retention_days",
    label: "Keep board faults for (days)",
    hint: "7–730. A fault that has been marked resolved is deleted after this. One still open "
      + "is closed by itself and KEPT, so the club's own count of open faults stays honest.",
    min: 7, max: 730, integer: true,
  },
  {
    key: "device_error_max_open_rows",
    label: "Most open faults from one board",
    hint: "20–2000. Past this, a board's new faults are counted rather than kept, and the page "
      + "says how many were suppressed. A board in that state is in trouble, and an unbounded "
      + "list is a way of taking the club's own monitoring screen down.",
    min: 20, max: 2000, integer: true,
  },
] as const;

/**
 * Real-time — how the control board and the credits badge stay current.
 *
 * <p>
 * `sse_keepalive_seconds` has the tightest reason of the four and the message says it: nginx
 * closes an idle proxied response after 60 seconds by default, so a keep-alive above that is
 * a live connection that drops every minute and reconnects, for ever.
 * </p>
 */
export const REALTIME_RULES: readonly NumericSettingRule[] = [
  {
    key: "sse_keepalive_seconds",
    label: "Live connection keep-alive (seconds)",
    hint: "5–55. How often the club's system sends a tick down a live connection to prove it "
      + "is still there. It has to stay under 60: the gateway in front of the club closes a "
      + "quiet connection at 60 seconds, so anything higher drops and reconnects for ever.",
    min: 5, max: 55, integer: true,
  },
  {
    key: "realtime_fallback_after_failures",
    label: "Give up on the live connection after (failures)",
    hint: "1–10. After this many failures in a row, a screen stops trying to stay live and "
      + "re-reads on a timer instead — and says on screen that it is doing so.",
    min: 1, max: 10, integer: true,
  },
  {
    key: "realtime_poll_seconds_control_board",
    label: "Control board re-reads every (seconds)",
    hint: "5–120. Only used once the live connection has been given up on.",
    min: 5, max: 120, integer: true,
  },
  {
    key: "control_board_resync_seconds",
    label: "Control board re-reads everything every (seconds)",
    hint: "30–3600. A full re-read, so a wall screen that missed one update is wrong for at "
      + "most this long rather than for the rest of the evening.",
    min: 30, max: 3600, integer: true,
  },
] as const;

/** Every numeric key this release adds, in the order the page shows them. */
export const ECO_NUMERIC_RULES: readonly NumericSettingRule[] = [
  ...DEVICE_TIMING_RULES, ...CAP_RULES, ...SCHEDULE_RULES, ...MONITORING_RULES, ...REALTIME_RULES,
];

// ---------------------------------------------------------------------------------------
// The two that are not numbers
// ---------------------------------------------------------------------------------------

/**
 * Which glyphs a confirm/decline pair wears — ruling 4.
 *
 * <p>
 * Thumbs by default, and that is a decision about this club rather than a default anybody
 * inherited: Dean asked for thumbs, and the club is South African, where a thumbs-up is
 * unambiguously positive. A club whose members read it otherwise flips one key.
 * </p>
 *
 * <p>
 * <b>Destructive confirms are exempt and the hint says so.</b> A thumbs-up on "Delete" is
 * wrong whatever the setting is: those keep the action's own icon — a bin, a lock — and the
 * danger treatment.
 * </p>
 */
export const ACTION_GLYPH_CHOICES = ["thumbs", "marks"] as const;
export type ActionGlyphs = typeof ACTION_GLYPH_CHOICES[number];

export const ACTION_GLYPH_LABEL: Record<ActionGlyphs, string> = {
  thumbs: "Thumbs up and down",
  marks: "Tick and cross",
};

export const ACTION_GLYPHS_HINT
  = "What yes and no look like on a confirm. Deleting and shutting keep their own icon and "
  + "their own colour whichever is chosen — a thumbs-up on “Delete” would be wrong.";

/**
 * Whether the per-person night trace exists at all — a kill switch, and it answers 404.
 *
 * Not 403: a 403 confirms the surface exists and that this member has one, which is a leak
 * about the very thing the switch is there to turn off.
 */
export const MEMBER_TRACE_LABEL = "Allow an admin to look at one member's night";
export const MEMBER_TRACE_HINT
  = "GOAL item 6. When this is off, the page is not there at all — not greyed out, not "
  + "refused, simply absent. When it is on, every look is recorded in the change record with "
  + "the admin's name, the member's name and the night, and the member may ask to see it.";

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

/**
 * What is wrong with the new keys, in the shape the settings page already renders.
 *
 * <p>
 * <b>An absent key is never a complaint.</b> That is `deviceNumbersComplaint`'s own rule and
 * it matters more here than it did there: these keys are being written by three parallel
 * backend lanes, and a console that refused to save because the API had not shipped
 * `sse_keepalive_seconds` yet would take the entire settings page down for a field nobody had
 * touched.
 * </p>
 *
 * <p>
 * An EMPTIED box is a different thing from an absent key and is caught by the page's own
 * empty-number check, which wins over this one — being told "Slots per member per day has to
 * be a whole number between 0 and 96" about a box you have just cleared is confusing, and two
 * messages on one input is worse than one.
 * </p>
 */
export function ecoSettingComplaints(settings: Record<string, unknown>): SettingComplaint[] {
  return [
    ...numericComplaints(settings),
    ...bookingHorizonComplaint(settings),
    ...glyphChoiceComplaint(settings),
  ];
}

/** Every declared numeric range, checked one rule at a time. */
function numericComplaints(settings: Record<string, unknown>): SettingComplaint[] {
  const out: SettingComplaint[] = [];
  for (const rule of ECO_NUMERIC_RULES) {
    const value = settings[rule.key];
    if (typeof value !== "number") continue; // absent, null or not a number: nothing to judge
    if (!Number.isFinite(value)) continue; // the page's emptied-field check owns this one
    if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
      out.push({
        key: rule.key,
        message: `${rule.label} has to be a whole number between ${rule.min} and ${rule.max}.`,
      });
    }
  }
  return out;
}

/*
 * The one cross-field rule, and it is the one whose failure appears weeks later: a member
 * can book `advance_booking_days` ahead, and a repeating booking is only WRITTEN
 * `schedule_materialisation_days` ahead. Set the first higher than the second and somebody
 * books into a league night that has not been written yet — and nothing goes wrong until
 * the week it does.
 */
function bookingHorizonComplaint(settings: Record<string, unknown>): SettingComplaint[] {
  const horizon = settings.schedule_materialisation_days;
  const advance = settings.advance_booking_days;
  const comparable = typeof horizon === "number" && typeof advance === "number"
    && Number.isFinite(horizon) && Number.isFinite(advance);
  if (!comparable || advance <= horizon) return [];
  return [{
    key: "schedule_materialisation_days",
    message: `Members can book ${advance} days ahead but repeating bookings are only written `
      + `${horizon} days ahead, so somebody could book into a league night that has not been `
      + "written yet. Write them at least as far ahead as members can book.",
  }];
}

/** The one enum: a glyph set this build does not know how to draw. */
function glyphChoiceComplaint(settings: Record<string, unknown>): SettingComplaint[] {
  const glyphs = settings.action_glyphs;
  if (typeof glyphs !== "string" || (ACTION_GLYPH_CHOICES as readonly string[]).includes(glyphs)) return [];
  return [{ key: "action_glyphs", message: "Choose either thumbs or a tick and cross." }];
}

/** The labels, for the page's own emptied-field message and its jump-to-field links. */
export const ECO_SETTING_LABELS: Record<string, string> = Object.fromEntries([
  ...ECO_NUMERIC_RULES.map((rule) => [rule.key, rule.label] as const),
  ["action_glyphs", "Yes and no icons"] as const,
  ["member_trace_enabled", MEMBER_TRACE_LABEL] as const,
]);
