import type { AdminSettings } from "./api";
import { GATE_ACCESS_POLICIES } from "./api";
import {
  ACTION_GLYPHS_HINT, ACTION_GLYPH_CHOICES, ACTION_GLYPH_LABEL, CAP_RULES, CURRENCY_SYMBOL_HINT,
  CURRENCY_SYMBOL_LABEL, DEVICE_TIMING_RULES, MAX_CURRENCY_SYMBOL_LENGTH, MEMBER_TRACE_HINT,
  MEMBER_TRACE_LABEL, MONITORING_RULES, REALTIME_RULES, SCHEDULE_RULES, type NumericSettingRule,
} from "./ecoSettings";
import {
  CLUB_CONTACT_EMAIL_MAX_LENGTH, CLUB_CONTACT_PHONE_MAX_LENGTH, DEVICE_ALERT_COOLDOWN_MAX_MINUTES,
  DEVICE_ALERT_COOLDOWN_MIN_MINUTES, DOOR_LOG_RETENTION_MAX_DAYS, DOOR_LOG_RETENTION_MIN_DAYS,
  DOOR_REFUSAL_SPIKE_MAX_COUNT, DOOR_REFUSAL_SPIKE_MAX_MINUTES, DOOR_REFUSAL_SPIKE_MIN_COUNT,
  DOOR_REFUSAL_SPIKE_MIN_MINUTES, GATE_EARLY_ENTRY_MAX_MINUTES, GATE_EARLY_ENTRY_MIN_MINUTES,
  GATE_UNLOCK_MAX_SECONDS, GATE_UNLOCK_MIN_SECONDS, OFFLINE_FLOOR_SECONDS, describeOfflineAfter,
  type SettingComplaint,
} from "./tenantSettings";
import {
  GATE_POLICY_LABELS, describeCourtSettingDoorReach, describeEarlyEntry, describeGatePolicy,
  gateOfflineFallbackNotice,
} from "./gateCopy";

/**
 * The settings registry — every setting the Settings page shows, in ONE table (plan R13).
 *
 * <p>
 * <b>Why a registry.</b> The page used to be ~70 hand-written fields in nine cards, each with its
 * label written at the call site, its bound on the input, a second copy of the bound in a
 * validator and a third in a hint. The search box, the section summaries, the "unsaved" dot, the
 * change count, the error summary's jump links and the deep link all need to know the same
 * facts about a setting — which section it lives in, what it is called, what it means — and four
 * readers of four copies is how a jump link names a field by a caption the screen does not show.
 * So each fact is written here once and every surface reads it.
 * </p>
 *
 * <p>
 * <b>Labels are the ones the page has always used</b>, because tests, the door signals' deep
 * links (`#setting-gate-unlock-seconds`) and the door-horizon sentences quote them. The newer eco
 * settings take their label, bound and hint from `ecoSettings.ts`, which the backend-bounds test
 * walks — never restated here.
 * </p>
 *
 * <p>
 * <b>Two kinds of words per setting.</b> `description` is the one line under the field that says
 * what it IS; `help` is the full story — what the bound is, what it reaches, what changing it
 * costs — and lives behind the field's (i) and on its `aria-describedby`, so a screen reader still
 * hears everything and a sighted admin is not handed a paragraph per field.
 * </p>
 */

export type SettingsSectionId =
  | "bookings" | "hours" | "cancellations" | "credits" | "schedules"
  | "boxes" | "screens" | "doors" | "records" | "monitoring";

/** What a help, a bound or a lede may depend on: the working copy and the club's money symbol. */
export type SettingContext = { settings: AdminSettings; currency: string };

type Dynamic<T> = T | ((context: SettingContext) => T);

export type SettingKind =
  | "number" | "text" | "tel" | "email" | "select" | "switch" | "minuteOfDay" | "peakHours" | "timezone";

export type SettingOption = { value: string; label: string };

export type SettingDef = {
  key: string;
  section: SettingsSectionId;
  /** The caption. `{currency}` is replaced with the club's own symbol. */
  label: string;
  /** One line, visible under the control: what this setting is. */
  description: string;
  /** The full guidance, behind the (i) and on `aria-describedby`. */
  help?: Dynamic<string>;
  kind: SettingKind;
  /** Shown inside the control's edge: "min", "s", "%", "cr". `{currency}` allowed. */
  unit?: string;
  /** The unit reads before the number (money: "R 100"). */
  unitBefore?: boolean;
  min?: number;
  max?: Dynamic<number>;
  step?: number;
  /** Whole numbers only — the range message says so. */
  integer?: boolean;
  /** The lower bound is exclusive (a conversion rate must be MORE than zero). */
  minExclusive?: boolean;
  /** Checked here against min/max. False where a module of its own already validates the key. */
  range?: boolean;
  /** The shipping default, for the (i) and for a reset. */
  defaultValue?: number | string | boolean;
  /** Collapsed behind the section's "Advanced" disclosure. */
  advanced?: boolean;
  /** Rendered only when the API serves the key (an older API omits it; omitted = unchanged). */
  optional?: boolean;
  options?: readonly SettingOption[];
  maxLength?: number;
  placeholder?: string;
};

export type SettingsSectionDef = {
  id: SettingsSectionId;
  title: string;
  /** The lede at the top of the open section. */
  lede: Dynamic<string>;
  /**
   * Words the search finds this section's non-field content by — the weekday rows, which are not
   * settings of their own. A section found this way shows whole.
   */
  searchTerms?: readonly string[];
};

/** The ten sections, in page order. Court boxes before Door gates: the door copy says "above". */
export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  {
    id: "bookings",
    title: "Bookings",
    lede: "How court time is sold: the slice, how far ahead members can book, and how much one member may hold.",
  },
  {
    id: "hours",
    title: "Opening hours",
    lede: ({ settings }) => `When members can book. A day left on the club default uses Day starts and Day ends`
      + ` (${minuteLabel(settings.day_start_minute)}–${minuteLabel(settings.day_end_minute)}). These are the hours`
      + " the booking grid draws and the booking rules enforce — a slot outside them is refused, and a walk-up at"
      + " the box is cut short at closing.",
    searchTerms: ["open", "close", "weekday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
  },
  {
    id: "cancellations",
    title: "Cancellations & no-shows",
    lede: "What cancelling late and not turning up cost a member.",
  },
  {
    id: "credits",
    title: "Credits & top-ups",
    lede: ({ currency }) => `Credits are the unit of account. A member pays in ${currency} and receives credits at the`
      + " rate for their class — so the two are different sizes, and the currency symbol below never appears on a"
      + " credit figure.",
  },
  {
    id: "schedules",
    title: "Repeating bookings",
    lede: "Leagues, coaching and other standing bookings — how far ahead they are written into the diary.",
  },
  {
    id: "boxes",
    title: "Court boxes & identification",
    lede: "How the boxes at the courts behave. A box picks a change up the next time it calls in.",
  },
  {
    id: "screens",
    title: "Box screens & scanning",
    lede: "What the court box's screen does, and how long it waits. A box picks these up the next time it calls in,"
      + " so a change reaches the courts within a minute rather than the moment you save it.",
  },
  {
    id: "doors",
    title: "Door gates",
    // The offline sentence comes FIRST, before the policy picker: it is the one thing on this
    // section an admin would not predict from the controls — whichever policy is chosen, a door
    // that loses the network falls back to a roster built from bookings.
    lede: () => `How the doors behave. A door picks a change up the next time it calls in. ${gateOfflineFallbackNotice()}`,
  },
  {
    id: "records",
    title: "Records & privacy",
    lede: "What the club keeps, for how long, and who may look at one member's night.",
  },
  {
    id: "monitoring",
    title: "Monitoring & live updates",
    lede: "How long the club keeps what its boards report, and how screens that show it stay current.",
  },
];

// ---------------------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------------------

/** An eco rule, as a row: its label, bound and hint come from `ecoSettings.ts`, never restated. */
function fromRule(rule: NumericSettingRule, section: SettingsSectionId, description: string, extra: Partial<SettingDef> = {}): SettingDef {
  return {
    key: rule.key, section, label: rule.label, description, help: rule.hint, kind: "number",
    min: rule.min, max: rule.max, integer: true, range: false, optional: true, ...extra,
  };
}

const rule = (rules: readonly NumericSettingRule[], key: string): NumericSettingRule => {
  const found = rules.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no eco rule for ${key}`);
  return found;
};

/** A number, or a floor while the box is empty — for a bound or a hint that quotes a neighbour. */
export const orElse = (value: number | undefined, fallback: number): number =>
  (Number.isFinite(value) ? (value as number) : fallback);

const BOOKINGS: SettingDef[] = [
  {
    key: "slice_minutes", section: "bookings", label: "Slice length (minutes)", kind: "number", unit: "min",
    description: "The smallest piece of court time a member can book.",
    help: "5–240. Each booking is one or more slices, e.g. 30 min. Court prices are per slice.",
    min: 5, max: 240, step: 5, integer: true, range: true, defaultValue: 15,
  },
  {
    key: "advance_booking_days", section: "bookings", label: "Reserve window (days ahead)", kind: "number", unit: "days",
    description: "How far ahead members can book.",
    help: "0–365. Members can only book up to this many days in advance.",
    min: 0, max: 365, integer: true, range: true, defaultValue: 14,
  },
  {
    key: "member_per_day_max_minutes", section: "bookings", label: "Court time per member per day (minutes)",
    kind: "number", unit: "min",
    description: "The most court time one member can hold on a day. 0 turns the cap off.",
    help: "0 turns the cap off. A slot starting today is allowed over the cap if the court is otherwise free.",
    min: 0, max: 1440, step: 15, integer: true, range: true, defaultValue: 60,
  },
  fromRule(rule(CAP_RULES, "member_max_slots_per_day"), "bookings",
    "The most slots one member can hold on a day. 0 means no limit.", { unit: "slots" }),
  {
    key: "peak_hours", section: "bookings", label: "Peak hours", kind: "peakHours",
    description: "The busy stretch of the day kept for league and over-65 members.",
    help: "Reserved for league and over-65 members. An empty peak slot opens to everyone a set number of hours"
      + " before it starts — the next setting.",
    defaultValue: "16:00-19:00",
  },
  {
    key: "peak_advance_hours_for_regular", section: "bookings", label: "Peak opens to everyone (hours before start)",
    kind: "number", unit: "h",
    description: "When an unbooked peak slot opens to every member.",
    help: "0–336. An empty peak slot opens to all members this many hours before it begins.",
    min: 0, max: 336, integer: true, range: true, defaultValue: 1,
  },
  {
    key: "timezone", section: "bookings", label: "Timezone", kind: "timezone", advanced: true,
    description: "The zone the club's day is read in.",
    help: "The zone the club's day is read in. Day start and end, the booking grid and every time a member sees"
      + " are all in this zone.",
    defaultValue: "Africa/Johannesburg",
  },
  fromRule(rule(CAP_RULES, "admin_bulk_max_items"), "bookings",
    "How many slots an admin may book or cancel in one press.", { advanced: true, unit: "slots" }),
  {
    key: "action_glyphs", section: "bookings", label: "Yes and no icons", kind: "select", advanced: true, optional: true,
    description: "What yes and no look like on a confirm.",
    help: ACTION_GLYPHS_HINT,
    options: ACTION_GLYPH_CHOICES.map((choice) => ({ value: choice, label: ACTION_GLYPH_LABEL[choice] })),
    defaultValue: "thumbs",
  },
];

const HOURS: SettingDef[] = [
  {
    key: "day_start_minute", section: "hours", label: "Day starts", kind: "minuteOfDay",
    description: "When the club opens on a day with no hours of its own.",
    help: "The club default. A weekday below that has its own hours ignores it.",
    defaultValue: 360,
  },
  {
    key: "day_end_minute", section: "hours", label: "Day ends", kind: "minuteOfDay",
    description: "When the club closes on those days.",
    help: "The club default. It has to be after Day starts — the club has no overnight hours.",
    defaultValue: 1320,
  },
];

const CANCELLATIONS: SettingDef[] = [
  {
    key: "penalty_pct", section: "cancellations", label: "Penalty (% of slice price)", kind: "number", unit: "%",
    description: "What cancelling late costs, as a share of the booking's price.",
    help: "0–100. Kept from the refund when a member cancels inside the late-cancel window. Cancelling earlier"
      + " is refunded in full.",
    min: 0, max: 100, integer: true, range: true, defaultValue: 30,
  },
  {
    key: "penalty_window_minutes", section: "cancellations", label: "Late-cancel window (minutes)", kind: "number", unit: "min",
    description: "Cancelling this close to the start costs the penalty.",
    help: "0–1440. Cancellations within this many minutes of start incur the penalty.",
    min: 0, max: 1440, integer: true, range: true, defaultValue: 15,
  },
  {
    key: "grace_window_minutes", section: "cancellations", label: "Grace window (minutes)", kind: "number", unit: "min",
    description: "How late a member can arrive before it counts as a no-show.",
    help: "0–60. After slot start, before a no-show triggers.",
    min: 0, max: 60, integer: true, range: true, defaultValue: 5,
  },
  {
    key: "no_show_lookback_days", section: "cancellations", label: "No-show sweep looks back (days)", kind: "number",
    unit: "days", advanced: true,
    description: "How far back the no-show sweep reaches.",
    help: "1–365. Bounds how far back the sweep reaches, so switching it on cannot post a backlog of historical"
      + " no-shows at once.",
    min: 1, max: 365, integer: true, range: true, defaultValue: 7,
  },
];

// step 0.01, not 0.1. A number input's valid values step from `min`, not from zero, so min=0.01
// with step=0.1 made the valid set 0.01, 0.11, … 1.61 — and the club's own shipped rates, 1.6
// and 2.4, were both stepMismatch while the arrows quietly moved the conversion rate by a
// hundredth. Cents are the smallest unit anyone expresses a rate in (settings-rates.test.tsx).
const RATE = { kind: "number", unit: "cr", min: 0.01, max: 1000, step: 0.01, minExclusive: true, range: true } as const;

const CREDITS: SettingDef[] = [
  {
    key: "currency_symbol", section: "credits", label: CURRENCY_SYMBOL_LABEL, kind: "text", optional: true,
    description: "Goes in front of every money figure — never in front of credits.",
    help: CURRENCY_SYMBOL_HINT, maxLength: MAX_CURRENCY_SYMBOL_LENGTH, placeholder: "R", defaultValue: "R",
  },
  {
    ...RATE, key: "credits_per_zar_regular", section: "credits", label: "Credits per {currency}1 — members",
    description: "Credits a member receives for every {currency}1 they top up.",
    help: ({ currency }) => `More than 0, at most 1000. ${currency}100 at 1.6 gives 160 credits.`,
    defaultValue: 1.6,
  },
  {
    ...RATE, key: "credits_per_zar_league", section: "credits", label: "Credits per {currency}1 — league / over-65",
    description: "The same, for league and over-65 members.",
    help: ({ currency }) => `More than 0, at most 1000. ${currency}100 at 2.4 gives 240 credits.`,
    defaultValue: 2.4,
  },
  {
    key: "topup_block_zar", section: "credits", label: "Top-up block ({currency})", kind: "number",
    unit: "{currency}", unitBefore: true,
    description: "Members top up in multiples of this.",
    help: "1–100000. Members top up in multiples of this.",
    min: 1, max: 100_000, integer: true, range: true, defaultValue: 100,
  },
  {
    key: "topup_max_zar_per_member", section: "credits", label: "Top-up cap per member ({currency})", kind: "number",
    unit: "{currency}", unitBefore: true,
    description: "The most one member can top up.",
    help: "1–100000. Must be at least one block, or no top-up is ever legal.",
    min: 1, max: 100_000, integer: true, range: true, defaultValue: 1000,
  },
];

const SCHEDULES: SettingDef[] = [
  fromRule(rule(SCHEDULE_RULES, "schedule_materialisation_days"), "schedules",
    "How far ahead repeating bookings are written into the diary.", { unit: "days" }),
  fromRule(rule(SCHEDULE_RULES, "schedule_max_rows_per_change"), "schedules",
    "A safety limit on one repeating booking's size.", { advanced: true, unit: "slots" }),
];

const BOXES: SettingDef[] = [
  {
    key: "walk_up_max_minutes", section: "boxes", label: "Walk-up maximum (minutes)", kind: "number", unit: "min",
    description: "The most court time a walk-up can buy at the box in one go.",
    help: "1–90. The most court time a walk-up can buy at the box in one go; 90 is the relay's hard cap.",
    min: 1, max: 90, integer: true, range: true, defaultValue: 90,
  },
  {
    // These two were once described the wrong way round: the cue is the one that switches the
    // lights (measured against a real box); the lookahead only decides recognition.
    key: "activation_cue_window_minutes", section: "boxes", label: "Lights on this early (minutes before a booking)",
    kind: "number", unit: "min",
    description: "How early a member's scan switches their court's lights on.",
    help: ({ settings }) => `0–${orElse(settings.activation_forward_window_minutes, 1440)}. This is the one that decides`
      + " how early a scan actually switches a booking's lights on. Must not exceed the booking lookahead."
      + ` ${describeCourtSettingDoorReach(settings.gate_access_policy)}`,
    min: 0, max: ({ settings }) => orElse(settings.activation_forward_window_minutes, 1440),
    integer: true, range: true, defaultValue: 10,
  },
  {
    key: "qr_lifetime_seconds", section: "boxes", label: "Court code lifetime (seconds)", kind: "number", unit: "s",
    description: "How long a member's walk-up code stays valid.",
    help: "15–3600. How long a member's walk-up code stays valid; the app fetches a new one as it runs out.",
    min: 15, max: 3600, integer: true, range: true, defaultValue: 60,
  },
  {
    key: "activation_forward_window_minutes", section: "boxes", label: "Booking lookahead at the box (minutes)",
    kind: "number", unit: "min", advanced: true,
    description: "How far ahead a box recognises a booking at all.",
    help: "1–1440. How far ahead the box recognises a booking at all. Outside this the box answers “no booking behind"
      + " this code”; inside it, but before the lights cue, it answers “too early” and says when to come back. This"
      + " does NOT decide when the lights come on.",
    min: 1, max: 1440, integer: true, range: true, defaultValue: 120,
  },
  {
    key: "roster_window_minutes", section: "boxes", label: "Offline roster reach (minutes)", kind: "number", unit: "min",
    advanced: true,
    description: "How far ahead a box can admit booked members while it is offline.",
    help: ({ settings }) => "5–1440. How far ahead a box's cached roster lets it admit booked members when it cannot"
      + ` reach the club's system. ${describeCourtSettingDoorReach(settings.gate_access_policy)}`,
    min: 5, max: 1440, integer: true, range: true, defaultValue: 120,
  },
  {
    // The "three missed beats" half was true only above 60 s; below it the 180-second floor takes
    // over, so the help says what THIS value actually buys.
    key: "heartbeat_seconds", section: "boxes", label: "Heartbeat interval (seconds)", kind: "number", unit: "s",
    advanced: true,
    description: "How often a box calls in for its roster and button map.",
    help: ({ settings }) => "15–300. How often a box calls in for its roster and button map. A box clamps anything"
      + " outside 15–300 to that range, so a larger number here is not what it would run. The Devices page calls a"
      + ` box offline after three missed beats or ${OFFLINE_FLOOR_SECONDS / 60} minutes, whichever is longer — at`
      + ` ${orElse(settings.heartbeat_seconds, 15)}s that is ${describeOfflineAfter(settings.heartbeat_seconds)}.`,
    min: 15, max: 300, integer: true, range: true, defaultValue: 60,
  },
  {
    key: "device_alert_cooldown_minutes", section: "boxes", label: "Alert cooldown (minutes)", kind: "number", unit: "min",
    advanced: true,
    description: "The least time between two “not reporting” emails about one board.",
    help: `${DEVICE_ALERT_COOLDOWN_MIN_MINUTES}–${DEVICE_ALERT_COOLDOWN_MAX_MINUTES}. At most one “not reporting” email`
      + " per board in this many minutes; a door nobody has named never alerts.",
    min: DEVICE_ALERT_COOLDOWN_MIN_MINUTES, max: DEVICE_ALERT_COOLDOWN_MAX_MINUTES, integer: true, range: false,
    defaultValue: 60,
  },
];

const SCREENS: SettingDef[] = [
  fromRule(rule(DEVICE_TIMING_RULES, "lcd_revert_seconds"), "screens",
    "How long the box's screen shows a result before going back to the start.", { unit: "s" }),
  fromRule(rule(DEVICE_TIMING_RULES, "rapid_scan_window_seconds"), "screens",
    "How long the box stays ready for the next person. 0 turns it off.", { unit: "s" }),
];

const DOORS: SettingDef[] = [
  {
    key: "gate_access_policy", section: "doors", label: "Who may open a door", kind: "select",
    description: "Every member in good standing, or only members with a booking.",
    help: ({ settings }) => describeGatePolicy(
      settings.gate_access_policy, orElse(settings.gate_early_entry_minutes, GATE_EARLY_ENTRY_MIN_MINUTES)),
    options: GATE_ACCESS_POLICIES.map((policy) => ({ value: policy, label: GATE_POLICY_LABELS[policy] })),
    defaultValue: "active_member",
  },
  {
    key: "gate_early_entry_minutes", section: "doors", label: "Early entry (minutes before a booking)",
    kind: "number", unit: "min",
    description: "How long before a booking its holder may come in.",
    help: ({ settings }) => `${GATE_EARLY_ENTRY_MIN_MINUTES}–${GATE_EARLY_ENTRY_MAX_MINUTES}.`
      + ` ${describeEarlyEntry(settings.gate_access_policy)}`,
    min: GATE_EARLY_ENTRY_MIN_MINUTES, max: GATE_EARLY_ENTRY_MAX_MINUTES, integer: true, range: false, defaultValue: 30,
  },
  {
    key: "gate_unlock_seconds", section: "doors", label: "Unlock time (seconds)", kind: "number", unit: "s",
    description: "How long the lock is released each time a door opens.",
    help: `${GATE_UNLOCK_MIN_SECONDS}–${GATE_UNLOCK_MAX_SECONDS}. How long the lock is released each time a door opens.`
      + ` A door never holds it open longer than ${GATE_UNLOCK_MAX_SECONDS} seconds, whatever is set here.`,
    min: GATE_UNLOCK_MIN_SECONDS, max: GATE_UNLOCK_MAX_SECONDS, integer: true, range: false, defaultValue: 15,
  },
  {
    key: "club_contact_phone", section: "doors", label: "Club contact number", kind: "tel", optional: true,
    description: "Shown to a member a door turns away, and printed on door cards.",
    help: `Digits, spaces and + - ( ) , — at most ${CLUB_CONTACT_PHONE_MAX_LENGTH} characters. What a member sees when a`
      + " door turns them away, and what goes on a printed door card. Leave it empty if the club has none — the"
      + " screens say so rather than showing a blank.",
    maxLength: CLUB_CONTACT_PHONE_MAX_LENGTH, placeholder: "076 226 1390",
  },
  {
    key: "club_contact_email", section: "doors", label: "Club contact email", kind: "email", optional: true,
    description: "The same, by email. Optional.",
    help: `At most ${CLUB_CONTACT_EMAIL_MAX_LENGTH} characters. The same, by mail. Also optional — and printed on the`
      + " same card, so it has to be an address that works.",
    maxLength: CLUB_CONTACT_EMAIL_MAX_LENGTH, placeholder: "squash@example.co.za",
  },
  {
    key: "door_refusal_spike_count", section: "doors", label: "Refusal spike (scans)", kind: "number", unit: "scans",
    advanced: true, optional: true,
    description: "Refusals at one door before Doors flags it.",
    help: `${DOOR_REFUSAL_SPIKE_MIN_COUNT}–${DOOR_REFUSAL_SPIKE_MAX_COUNT}. How many refusals at one door, inside the window`
      + " beside this, before Doors says the door is refusing a lot. It counts SCANS: one person trying four times is four.",
    min: DOOR_REFUSAL_SPIKE_MIN_COUNT, max: DOOR_REFUSAL_SPIKE_MAX_COUNT, integer: true, range: false, defaultValue: 8,
  },
  {
    key: "door_refusal_spike_minutes", section: "doors", label: "Refusal spike window (minutes)", kind: "number",
    unit: "min", advanced: true, optional: true,
    description: "The rolling window that count is measured over.",
    help: `${DOOR_REFUSAL_SPIKE_MIN_MINUTES}–${DOOR_REFUSAL_SPIKE_MAX_MINUTES}. The window that count is measured over. It`
      + " rolls, so the flag clears itself when the window empties and there is nothing to acknowledge.",
    min: DOOR_REFUSAL_SPIKE_MIN_MINUTES, max: DOOR_REFUSAL_SPIKE_MAX_MINUTES, integer: true, range: false, defaultValue: 20,
  },
];

const RECORDS: SettingDef[] = [
  {
    key: "retention_years", section: "records", label: "Keep usage history for (years)", kind: "number", unit: "years",
    description: "Records older than this are anonymised overnight.",
    help: "1–50. Each night the club's records older than this are anonymised. This is the longer rule money"
      + " records follow; door scans have their own, shorter one below.",
    min: 1, max: 50, integer: true, range: true, defaultValue: 2,
  },
  {
    key: "door_log_retention_days", section: "records", label: "Keep door scans for (days)", kind: "number", unit: "days",
    optional: true,
    description: "Door scans older than this are deleted.",
    help: `${DOOR_LOG_RETENTION_MIN_DAYS}–${DOOR_LOG_RETENTION_MAX_DAYS}. Past this a door scan is DELETED, receipts and all,`
      + " rather than anonymised. Money records follow the separate, longer rule above.",
    min: DOOR_LOG_RETENTION_MIN_DAYS, max: DOOR_LOG_RETENTION_MAX_DAYS, integer: true, range: false, defaultValue: 90,
  },
  {
    key: "member_trace_enabled", section: "records", label: MEMBER_TRACE_LABEL, kind: "switch", optional: true,
    description: "When it is on, every look is recorded in the change record.",
    help: MEMBER_TRACE_HINT, defaultValue: true,
  },
];

const MONITORING: SettingDef[] = [
  fromRule(rule(MONITORING_RULES, "device_error_retention_days"), "monitoring",
    "How long a resolved board fault is kept.", { unit: "days" }),
  fromRule(rule(REALTIME_RULES, "realtime_fallback_after_failures"), "monitoring",
    "Failures in a row before a screen re-reads on a timer instead of live.", { unit: "tries" }),
  fromRule(rule(MONITORING_RULES, "device_error_max_open_rows"), "monitoring",
    "Past this, one board's new faults are counted rather than kept.", { advanced: true, unit: "faults" }),
  fromRule(rule(REALTIME_RULES, "sse_keepalive_seconds"), "monitoring",
    "How often a live connection is proven alive. Keep it under 60.", { advanced: true, unit: "s" }),
  fromRule(rule(REALTIME_RULES, "realtime_poll_seconds_control_board"), "monitoring",
    "The control board's timer once live updates are given up on.", { advanced: true, unit: "s" }),
  fromRule(rule(REALTIME_RULES, "control_board_resync_seconds"), "monitoring",
    "A full re-read, so a wall screen that missed an update catches up.", { advanced: true, unit: "s" }),
];

/** Every setting on the page, in page order. */
export const SETTINGS: readonly SettingDef[] = [
  ...BOOKINGS, ...HOURS, ...CANCELLATIONS, ...CREDITS, ...SCHEDULES, ...BOXES, ...SCREENS, ...DOORS, ...RECORDS,
  ...MONITORING,
];

const BY_KEY = new Map(SETTINGS.map((def) => [def.key, def]));

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

export function sectionDef(id: SettingsSectionId): SettingsSectionDef {
  return SETTINGS_SECTIONS.find((section) => section.id === id)!;
}

export function settingsIn(section: SettingsSectionId): SettingDef[] {
  return SETTINGS.filter((def) => def.section === section);
}

/**
 * The section a settings key — or a weekday row's pseudo-key (`operating_hours_sat`) — lives in.
 */
export function sectionOfKey(key: string): SettingsSectionId | undefined {
  if (key.startsWith("operating_hours")) return "hours";
  return BY_KEY.get(key)?.section;
}

/** A field's caption in the club's own currency — the one reader, so a jump link and a label agree. */
export function settingLabel(key: string, currency: string): string {
  return (BY_KEY.get(key)?.label ?? key).replaceAll("{currency}", currency);
}

/** Every key's raw caption — for the sentences that quote a field by the words it wears. */
export const SETTING_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  SETTINGS.map((def) => [def.key, def.label]),
);

export function resolve<T>(value: Dynamic<T> | undefined, context: SettingContext): T | undefined {
  return typeof value === "function" ? (value as (c: SettingContext) => T)(context) : value;
}

/** A setting's unit in the club's currency. */
export function unitOf(def: SettingDef, currency: string): string | undefined {
  return def.unit?.replaceAll("{currency}", currency);
}

/** Whether the API serves this key — an optional row for an absent key is not rendered at all. */
export function isServed(def: SettingDef, settings: AdminSettings): boolean {
  if (!def.optional) return true;
  return (settings as unknown as Record<string, unknown>)[def.key] !== undefined;
}

/** The numeric keys — the ones an emptied box (NaN) is a complaint about. */
export const NUMERIC_KEYS: readonly string[] = SETTINGS.filter((def) => def.kind === "number").map((def) => def.key);

// ---------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------

/** Lower-cased, with `_` read as a space so "grace window" finds `grace_window_minutes`. */
export function normaliseQuery(raw: string): string {
  return raw.trim().toLowerCase().replaceAll("_", " ");
}

/** Whether a setting answers a search: its caption, its line, its guidance or its key. */
export function settingMatches(def: SettingDef, query: string, context: SettingContext): boolean {
  if (!query) return true;
  const haystack = [
    settingLabel(def.key, context.currency), def.description.replaceAll("{currency}", context.currency),
    resolve(def.help, context) ?? "", def.key.replaceAll("_", " "),
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

/**
 * Whether a whole section answers a search — by its title or its extra terms — and so shows every
 * row it has. A search for "door" shows all of Door gates; one for "unlock" shows one field.
 */
export function sectionMatches(section: SettingsSectionDef, query: string): boolean {
  if (!query) return true;
  return [section.title, ...(section.searchTerms ?? [])].some((term) => term.toLowerCase().includes(query));
}

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

/**
 * The bound, for the rows no module of their own validates (booking, cancellation, money and
 * court-box numbers). Mirrors `AdminConfigEndpoints`' own ranges — never a bound invented here,
 * because a screen stricter than the server forbids a value the product supports and one looser
 * produces a save refused with a code nobody on the screen can act on.
 */
export function rangeComplaints(settings: AdminSettings, context: SettingContext): SettingComplaint[] {
  const held = settings as unknown as Record<string, unknown>;
  const out: SettingComplaint[] = [];
  for (const def of SETTINGS) {
    if (!def.range) continue;
    const value = held[def.key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue; // empty: the page's own check
    const message = outOfRange(def, value, context);
    if (message) out.push({ key: def.key, message });
  }
  return out;
}

function outOfRange(def: SettingDef, value: number, context: SettingContext): string | null {
  const min = def.min ?? Number.NEGATIVE_INFINITY;
  const max = resolve(def.max, context) ?? Number.POSITIVE_INFINITY;
  const label = settingLabel(def.key, context.currency);
  const low = def.minExclusive ? value <= 0 : value < min;
  const bad = low || value > max || (def.integer === true && !Number.isInteger(value));
  if (!bad) return null;
  if (def.minExclusive) return `${label} has to be more than 0 and at most ${max}.`;
  return `${label} has to be ${def.integer ? "a whole number " : ""}from ${min} to ${max}.`;
}

/** Peak hours: one `HH:MM-HH:MM` range whose end is after its start — the API's own parse. */
export function peakHoursComplaint(value: string | undefined): SettingComplaint[] {
  if (value === undefined) return [];
  const parsed = parsePeakHours(value);
  if (parsed && minuteOf(parsed.start) < minuteOf(parsed.end)) return [];
  return [{ key: "peak_hours", message: "Peak hours have to end after they start." }];
}

export function parsePeakHours(value: string): { start: string; end: string } | null {
  const parts = value.split("-").map((part) => part.trim());
  if (parts.length !== 2 || !isClock(parts[0]) || !isClock(parts[1])) return null;
  return { start: pad(parts[0]), end: pad(parts[1]) };
}

/** The club default's own rule: the API refuses a default day that closes at or before it opens. */
export function defaultDayComplaint(settings: AdminSettings): SettingComplaint[] {
  const { day_start_minute: start, day_end_minute: end } = settings;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < end) return [];
  return [{ key: "day_end_minute", message: "Day ends has to be after Day starts." }];
}

function isClock(text: string): boolean {
  const [h, m, extra] = text.split(":");
  if (extra !== undefined || h === undefined || m === undefined) return false;
  const hours = Number(h);
  const minutes = Number(m);
  return /^\d{1,2}$/.test(h) && /^\d{2}$/.test(m) && hours <= 23 && minutes <= 59;
}

function pad(clock: string): string {
  const [h, m] = clock.split(":");
  return `${h.padStart(2, "0")}:${m}`;
}

function minuteOf(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + m;
}

/** `360` → `"06:00"`. */
export function minuteLabel(minutes: number): string {
  if (!Number.isFinite(minutes)) return "--:--";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** `"06:00"` → `360`; `"24:00"` → `1440`. */
export function minuteOfLabel(label: string): number {
  return minuteOf(label);
}
