import type { AdminSettings } from "./api";
import { GATE_ACCESS_POLICIES } from "./api";
import {
  CAP_RULES, CURRENCY_SYMBOL_HINT,
  CURRENCY_SYMBOL_LABEL, MAX_CURRENCY_SYMBOL_LENGTH, MEMBER_TRACE_HINT,
  MEMBER_TRACE_LABEL, MONITORING_RULES, REALTIME_RULES, SCHEDULE_RULES, servedBound, servedValues, type NumericSettingRule,
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
  | "bookings" | "hours" | "cancellations" | "money" | "schedules"
  | "boxes" | "screens" | "doors" | "records" | "monitoring" | "alerts" | "play";

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
  /** Shown inside the control's edge: "min", "s", "%". `{currency}` allowed. */
  unit?: string;
  /** The unit reads before the number (money: "R 100"). */
  unitBefore?: boolean;
  min?: number;
  max?: Dynamic<number>;
  step?: number;
  /** Whole numbers only — the range message says so. */
  integer?: boolean;
  /** The lower bound is exclusive (the value must be MORE than `min`). */
  minExclusive?: boolean;
  /** Checked here against min/max. False where a module of its own already validates the key. */
  range?: boolean;
  /**
   * The range is the API's alone (device-api §10): the row carries no `min`/`max` of its own and
   * takes the settings GET's `bounds` for this key. A test fails if such a row grows a client range.
   */
  serverBounds?: true;
  /** The shipping default, for the (i) and for a reset. */
  defaultValue?: number | string | boolean;
  /** Collapsed behind the section's "Advanced" disclosure. */
  advanced?: boolean;
  /** Rendered only when the API serves the key (an older API omits it; omitted = unchanged). */
  optional?: boolean;
  options?: readonly SettingOption[];
  /** A select whose values are numbers on the wire (the served `values` are numbers). */
  numericChoice?: true;
  maxLength?: number;
  placeholder?: string;
  /**
   * The spelling(s) the save sends this key under. The settings PUT binds the older keys
   * camelCase only, the newest snake_case only, and the ones in between under both — and a key
   * sent under a spelling the server does not bind is not refused, it is IGNORED: `{"saved":
   * true}` and no change. So each row says which it needs. Default `camel`.
   */
  wire?: "camel" | "snake" | "both";
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

/** The sections, in page order. Court boxes before Door gates: the door copy says "above". */
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
    // P13: minutes are the unit. A booking costs the minutes it is played for; members buy minutes
    // in packages priced in rand, which are set on Packages, and a group's discount on Groups.
    id: "money",
    title: "Money & packages",
    lede: ({ currency }) => `A booking costs the minutes it is played for. Members buy minutes in packages, paid in`
      + ` ${currency} — the packages and each group's package discount are set on their own pages.`,
    searchTerms: ["package", "price", "discount", "buy", "minutes", "rand", "currency"],
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
  {
    // R23. The club's thresholds ride the save bar like every other setting; which alerts reach
    // ONE admin's inbox is that admin's own preference and saves on the switch (below the rows).
    id: "alerts",
    title: "Admin alerts",
    lede: "When every admin is emailed, and how long alerts stay on the Overview. Which of them reach your own"
      + " inbox is your choice, below — it saves as you switch and changes nothing for other admins.",
    searchTerms: ["email", "alert", "notification", "inbox", "remind", "application", "cooldown", "quiet"],
  },
  {
    // P12 (play.md §6.4). Every number is the club's; changing a streak one re-reads every
    // member's streak next time they look — it can move a streak, never a badge already earned.
    id: "play",
    title: "Match results & streaks",
    lede: "How long players have to record and confirm a result, how weekly streaks rest and pause, and when the"
      + " early-bird and night-owl badges start. A streak change shows on each member's next look; a badge already"
      + " earned is never taken back.",
    searchTerms: ["result", "score", "match", "streak", "badge", "pause", "injury", "play", "dispute"],
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
    // FC-8: the heartbeat carries this to the boxes, and no box does anything with it.
    help: "5–240. Each booking is one or more slices, e.g. 30 minutes, and costs the minutes it covers. A rule of the"
      + " club's system, not of the court boxes: a box never uses it, so changing it changes nothing at the courts.",
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
    description: "The most court time one member can hold on a day. 0 means no limit.",
    help: "0 means no limit. A slot starting today is allowed over the limit if the court is otherwise free.",
    min: 0, max: 1440, step: 15, integer: true, range: true, defaultValue: 60,
  },
  fromRule(rule(CAP_RULES, "member_max_slots_per_day"), "bookings",
    "The most slots one member can hold on a day. 0 means no limit.", { unit: "slots" }),
  {
    key: "peak_hours", section: "bookings", label: "Peak hours", kind: "peakHours",
    description: "The busy stretch of the day kept for groups with peak priority.",
    help: "Reserved for members of a group with peak priority (set on Groups). An empty peak slot opens to everyone"
      + " a set number of hours before it starts — the next setting.",
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
    key: "penalty_pct", section: "cancellations", label: "Penalty (% of the booking's minutes)", kind: "number", unit: "%",
    description: "What cancelling late costs, as a share of the booking's minutes.",
    help: "0–100. Kept from the minutes refunded when a member cancels inside the late-cancel window, rounded"
      + " down to a whole minute. Cancelling earlier is refunded in full.",
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
    help: "0–60. After slot start, before a no-show triggers. The club's system judges it from the check-ins it receives;"
      + " the court boxes do nothing with it.",
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

// The money section is the currency symbol alone (P13, contract §3.6 / §3.9): the conversion rate,
// the slice price and the purchase block and cap are gone from the settings GET and the console
// never sends them. Packages and each group's package discount are set on their own pages.
const MONEY: SettingDef[] = [
  {
    key: "currency_symbol", section: "money", label: CURRENCY_SYMBOL_LABEL, kind: "text", optional: true,
    description: "Goes in front of every rand figure — package prices, takings. Never in front of minutes.",
    help: CURRENCY_SYMBOL_HINT, maxLength: MAX_CURRENCY_SYMBOL_LENGTH, placeholder: "R", defaultValue: "R",
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
    description: "The most court time a walk-up can buy at the box in one go — and the most any time button gives.",
    help: "1–90. The most court time a walk-up can buy at the box in one go; 90 is the relay's hard cap. Saving it also caps"
      + " every time button above it — the club's button map and each box's own — so a button can never offer more.",
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
      + " per board in this many minutes; a door nobody has named never alerts. The same quiet time spaces out the"
      + " “many device faults at once” emails (Admin alerts).",
    min: DEVICE_ALERT_COOLDOWN_MIN_MINUTES, max: DEVICE_ALERT_COOLDOWN_MAX_MINUTES, integer: true, range: false,
    defaultValue: 60,
  },
];

/*
 * Every box and device setting below carries NO client range (`serverBounds`): its bounds are
 * the ones the settings GET serves in `bounds` (device-api §10), applied by `settingsFor`. A copy
 * here is how the console once offered 5–120 s for a revert the API bounded 3–60 (FA-2/BA-05).
 * An API that serves no bound for a key gets no client check either — its refusal names the
 * range (`<key>_out_of_range` with `min`/`max`), which the save banner quotes.
 *
 * The keys are snake_case only on the settings PUT (AdminConfigEndpoints' JsonPropertyName
 * block); `lcd_revert_seconds` binds both spellings.
 */
const BOX_KEY = { optional: true, wire: "snake", serverBounds: true } as const;
const BOX_NUMBER = { ...BOX_KEY, kind: "number", integer: true, range: true } as const;

/** Said on every box row: the box is pull-only and learns a change in the answer to its next beat. */
const ONE_HEARTBEAT = "A box picks a change up the next time it calls in.";

export const LCD_LAYOUT_LABELS: Readonly<Record<string, string>> = {
  compact: "Compact — 2 lines of 16 (16×2)",
  expanded: "Expanded — 4 lines of 20 (20×4)",
};

const SCREENS: SettingDef[] = [
  {
    ...BOX_KEY, key: "lcd_layout", section: "screens", kind: "select", label: "Screen layout",
    description: "Which size of screen the boxes draw for. A board can be set on its own on Boards.",
    help: "Compact draws two lines of sixteen characters, which every fitted screen can show. Expanded draws four"
      + " lines of twenty and needs a 20×4 panel. A box that cannot reach the club, or is sent a value it does not"
      + ` know, draws compact. ${ONE_HEARTBEAT} If expanded looks wrong on a box, set that board back to compact on`
      + " Boards — one press, and it is compact again on its next heartbeat.",
    options: [
      { value: "compact", label: LCD_LAYOUT_LABELS.compact },
      { value: "expanded", label: LCD_LAYOUT_LABELS.expanded },
    ],
    defaultValue: "compact",
  },
  {
    ...BOX_KEY, key: "lcd_marquee_enabled", section: "screens", kind: "switch", label: "Scroll long lines",
    description: "A line longer than the screen scrolls across it. Off, it is cut and the start screen pages instead.",
    help: "On, a line wider than the screen scrolls one character at a time, smoothly, on the box itself. Off, a long"
      + ` line is cut at the edge and the compact start screen shows one court per page instead. ${ONE_HEARTBEAT}`,
    defaultValue: true,
  },
  {
    ...BOX_NUMBER, key: "lcd_revert_seconds", section: "screens", label: "Screen returns to the start after a result (seconds)",
    unit: "s", wire: "both",
    description: "How long a scan's result — a welcome, a refusal, lights on — stays before the start screen.",
    help: "How long the box shows the result of a decided scan before it goes back to the start screen (“SCAN YOUR QR”)."
      + " It is also how long the next person has to scan straight after: a new scan replaces the result at once."
      + " It governs results only — a court or time choice waits for “Court choice waits”, and the name card for"
      + ` “Name card shows”. Whatever these say, no screen lasts past “Longest any screen lasts”. ${ONE_HEARTBEAT}`,
    defaultValue: 10,
  },
  {
    ...BOX_NUMBER, key: "lcd_choice_seconds", section: "screens", label: "Court choice waits (seconds)", unit: "s",
    description: "How long the box waits for a court or time button after a scan, then goes back to the start.",
    help: "After a scan that needs a choice — which court, how long — the box waits this long for a button, then gives"
      + " up and goes back to the start screen. A press does not restart the wait. This is the screen a member who"
      + ` walks away leaves behind. ${ONE_HEARTBEAT}`,
    defaultValue: 20,
  },
  {
    ...BOX_NUMBER, key: "lcd_card_seconds", section: "screens", label: "Name card shows (seconds)", unit: "s",
    description: "How long the member's first name shows after a recognised scan.",
    help: `How long the greeting with the member's first name stays before the box moves on. ${ONE_HEARTBEAT}`,
    defaultValue: 2,
  },
  {
    ...BOX_NUMBER, key: "lcd_hint_seconds", section: "screens", label: "Short messages stay on the bottom line (seconds)",
    unit: "s", advanced: true,
    description: "How long a one-off message holds the bottom line of the screen.",
    help: "How long a short one-off message holds the bottom line of the box's screen before that line goes back to"
      + ` what it was showing. ${ONE_HEARTBEAT}`,
    defaultValue: 3,
  },
  {
    ...BOX_NUMBER, key: "scan_memory_seconds", section: "screens", label: "Box remembers a scan for (seconds)", unit: "s",
    advanced: true,
    description: "How long the buttons still belong to the member who last scanned.",
    help: "How long the box remembers who scanned, so a court button pressed after a scan is that member's. The box"
      + " never remembers a scan for less than “Court choice waits”, whatever this says — otherwise a choice could be"
      + ` left on the screen for nobody. ${ONE_HEARTBEAT}`,
    defaultValue: 30,
  },
  {
    ...BOX_NUMBER, key: "lcd_screen_ceiling_seconds", section: "screens", label: "Longest any screen lasts (seconds)", unit: "s",
    description: "The absolute limit on every screen that is not the start screen. The box enforces it itself.",
    help: "No screen other than the start screen lasts longer than this — whatever a bridge sends, whatever button is"
      + " held. The box's own controller enforces it, so a screen cannot get stuck. When it fires, the start screen"
      + ` holds for “Start screen holds after a timeout” before anything else may show. ${ONE_HEARTBEAT}`,
    defaultValue: 60,
  },
  {
    ...BOX_NUMBER, key: "lcd_after_lights_on_seconds", section: "screens", label: "Back to the start after lights on (seconds)",
    unit: "s",
    description: "How soon the box returns to the start screen once a court's lights come on.",
    help: `Once a court lights, the box goes back to the start screen this soon, so the next person sees every court. ${ONE_HEARTBEAT}`,
    defaultValue: 15,
  },
  {
    ...BOX_NUMBER, key: "lcd_landing_page_seconds", section: "screens", label: "Start screen turns its page every (seconds)",
    unit: "s",
    description: "When the start screen has more courts than lines, how long each page shows.",
    help: `When there are more courts than the screen has lines, the start screen pages through them this often. ${ONE_HEARTBEAT}`,
    defaultValue: 4,
  },
  {
    ...BOX_NUMBER, key: "lcd_marquee_step_ms", section: "screens", label: "Scrolling speed (milliseconds a character)", unit: "ms",
    advanced: true,
    description: "How long a scrolling line waits before moving one character. Larger is slower.",
    help: `A scrolling line moves one character every this many milliseconds. ${ONE_HEARTBEAT}`,
    defaultValue: 400,
  },
  {
    ...BOX_NUMBER, key: "lcd_landing_dwell_seconds", section: "screens", label: "Start screen holds after a timeout (seconds)",
    unit: "s", advanced: true,
    description: "After the longest-screen limit fires, the start screen holds this long before anything else shows.",
    help: "After “Longest any screen lasts” forces the start screen, it stays at least this long, so a stuck button"
      + ` cannot bounce the screen straight back. 0 means no hold. ${ONE_HEARTBEAT}`,
    defaultValue: 3,
  },
  {
    ...BOX_NUMBER, key: "lcd_reinit_seconds", section: "screens", label: "Screen refreshes itself every (seconds)", unit: "s",
    advanced: true,
    description: "How often the box resets its screen and redraws the start screen, to clear any garbled text.",
    help: "Electrical noise can garble a character screen. While it shows the start screen, the box re-initialises it"
      + ` and redraws everything this often, so a garbled screen heals by itself. ${ONE_HEARTBEAT}`,
    defaultValue: 60,
  },
];

/** The v3 box rows that belong with the lights and the network rather than the screen. */
const BOX_V3: SettingDef[] = [
  {
    ...BOX_KEY, key: "relay_restore_enabled", section: "boxes", kind: "switch", label: "Put paid lights back on by themselves",
    description: "A box re-lights a court the club says is paid for and in play — after a power cut, or a reset.",
    help: "On, a box turns a court's lights back on when the club's system says a checked-in booking is still in play"
      + " there — after a power cut or a box reset — for the paid time left, extensions included. The club's word"
      + " never switches a court off. Off, a box never re-lights by itself, and a member scans again."
      + ` ${ONE_HEARTBEAT}`,
    defaultValue: true,
  },
  {
    ...BOX_NUMBER, key: "relay_reconcile_min_seconds", section: "boxes", label: "Re-light only with at least (seconds) paid",
    unit: "s", advanced: true,
    description: "A box does not re-light a court with less paid time left than this — no ten-second flashes.",
    help: `Below this much paid time left, a box does not switch a court back on by itself. ${ONE_HEARTBEAT}`,
    defaultValue: 60,
  },
  {
    ...BOX_NUMBER, key: "relay_authorisation_cap_minutes", section: "boxes", label: "Lights a box put back on stay on at most (minutes)",
    unit: "min", advanced: true,
    description: "A court a box re-lit by itself switches off this long after the club last confirmed it.",
    help: "A safety limit for lights the box turned back on by itself: if the club's system has not confirmed that"
      + ` court for this long, the box switches it off. ${ONE_HEARTBEAT}`,
    defaultValue: 240,
  },
  {
    ...BOX_NUMBER, key: "device_power_restore_trust_minutes", section: "boxes",
    label: "After a power cut with no network, trust the box's memory for (minutes)", unit: "min", advanced: true,
    description: "How long a box (or door) acts on what it last knew after power returns and the network does not.",
    help: "After a power cut, a box that cannot reach the club re-lights paid courts and admits rostered members from"
      + " what it saved, for at most this long; a door does the same with its roster. The first answer from the club"
      + ` replaces it. 0 turns this off. ${ONE_HEARTBEAT}`,
    defaultValue: 20,
  },
  {
    ...BOX_NUMBER, key: "clock_trust_minutes", section: "boxes", label: "Box trusts its clock for (minutes)", unit: "min",
    advanced: true,
    description: "How long a box keeps showing the time without hearing from the club.",
    help: `A box that has not heard the club's time for this long stops printing a time at all rather than a wrong one. ${ONE_HEARTBEAT}`,
    defaultValue: 90,
  },
  {
    ...BOX_NUMBER, key: "device_net_fallback_minutes", section: "boxes", label: "Give up on a new network address after (minutes)",
    unit: "min", advanced: true,
    description: "A board that cannot reach the club at a new address goes back to the old one after this.",
    help: "When the club's network settings change (Boards › Club network), a board that has not reached the club at"
      + ` the new address within this long goes back to the previous one, so a typo cannot strand it. ${ONE_HEARTBEAT}`,
    defaultValue: 10,
  },
  {
    ...BOX_NUMBER, key: "device_key_grace_hours", section: "boxes", label: "Old device key keeps working for (hours)", unit: "h",
    advanced: true,
    description: "After a key rotation, the old key is retired this long after every board has the new one.",
    help: "After a key rotation (Boards › Device key), the old key is retired automatically once every board has moved to"
      + " the new one and this long has passed — never while a board that cannot rotate is still in service.",
    defaultValue: 168,
  },
];

/**
 * The five hardware facts the Mega once had compiled in (device-api §5, §12; HW-1, HW-2, HW-5):
 * the club's values, which a board may override on Boards. Their values and range are the API's
 * (`bounds`); the labels name each value in words. Advanced: a club sets them once, at
 * commissioning (`lights-controller.md`), and a wrong one is fixed per board, never by a cable.
 */
const HW_VALUE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  hw_relay_active_level: { high: "High — an active-high module", low: "Low — an active-low module" },
  hw_scanner_line_end: { auto: "Auto — CR, LF or a pause ends a code", crlf: "CR/LF — only the scanner's own line end" },
  hw_lcd_i2c_address: { 0: "Search for it" },
  hw_scanner_baud: { 0: "Auto-detect" },
};

/** A served hardware value in words: an LCD address in hex, a scanner speed in baud. */
function hwValueLabel(key: string, value: string): string | undefined {
  const named = HW_VALUE_LABELS[key]?.[value];
  if (named) return named;
  const n = Number(value);
  if (key === "hw_lcd_i2c_address" && Number.isInteger(n)) return `0x${n.toString(16).toUpperCase().padStart(2, "0")}`;
  if (key === "hw_scanner_baud" && Number.isInteger(n)) return `${n} baud`;
  return undefined;
}

const HARDWARE: SettingDef[] = [
  {
    ...BOX_KEY, key: "hw_relay_active_level", section: "boxes", kind: "select", label: "Relay drive level", advanced: true,
    description: "Which level switches a court's relay on. A board can be set on its own on Boards.",
    help: "Set at commissioning: light a court the normal way; if it stays dark while the box says it is on, the level is"
      + " the other one. A released relay is never driven, so a wrong level keeps courts dark — it never lights one that"
      + ` should be off. Changing it re-drives every lit court at the new level. ${ONE_HEARTBEAT}`,
    defaultValue: "high",
  },
  {
    ...BOX_KEY, key: "hw_lcd_i2c_address", section: "boxes", kind: "select", numericChoice: true, label: "Screen (LCD) address",
    advanced: true,
    description: "Where the box looks for its screen. Searching finds every common backpack.",
    help: "Leave it on search: the box tries every address a character-screen backpack uses and keeps the one that answers,"
      + " and Boards shows which. Set an address only for a backpack the search cannot find. A board can be set on its own."
      + ` ${ONE_HEARTBEAT}`,
    defaultValue: 0,
  },
  {
    ...BOX_KEY, key: "hw_scanner_baud", section: "boxes", kind: "select", numericChoice: true, label: "Scanner speed", advanced: true,
    description: "How fast the QR scanner talks to the box. Auto finds it while the box is idle.",
    help: "Auto tries each speed while nobody is scanning and keeps the one a scan arrives on; Boards shows which. Set it only"
      + ` if scans never arrive. A board can be set on its own. ${ONE_HEARTBEAT}`,
    defaultValue: 0,
  },
  {
    ...BOX_KEY, key: "hw_scanner_line_end", section: "boxes", kind: "select", label: "Scanner line end", advanced: true,
    description: "How the box knows a scanned code has ended.",
    help: "Auto accepts a CR, an LF, or a short pause after the last character, so a scanner with no line end still works."
      + ` CR/LF waits for the scanner's own line end. A board can be set on its own. ${ONE_HEARTBEAT}`,
    defaultValue: "auto",
  },
  {
    ...BOX_NUMBER, key: "hw_scanner_gap_ms", section: "boxes", label: "Scanner end-of-code pause (milliseconds)", unit: "ms",
    advanced: true,
    description: "With the line end on auto, a pause this long after the last character ends a scanned code.",
    help: `Too short and a slow scanner's code is cut in two; too long and the box waits after every scan. ${ONE_HEARTBEAT}`,
    defaultValue: 150,
  },
];

/** The two fault switches belong with monitoring: they decide what reaches Faults at all. */
const MONITORING_DEVICE: SettingDef[] = [
  {
    ...BOX_KEY, key: "device_fault_reporting", section: "monitoring", kind: "switch", label: "Boards report their faults",
    description: "Whether boards send their own faults to Faults at all.",
    help: `Off, no board sends a fault and Faults hears nothing from them. ${ONE_HEARTBEAT}`,
    defaultValue: true,
  },
  {
    ...BOX_NUMBER, key: "device_fault_max_per_hour", section: "monitoring", label: "Most fault reports from one board an hour",
    unit: "faults", advanced: true,
    description: "Repeats of one fault inside the window are counted into one report, not sent one by one.",
    help: "A board turns this into a quiet time per fault code: at 20 an hour, one report of a code every three"
      + ` minutes, carrying how many times it happened. ${ONE_HEARTBEAT}`,
    defaultValue: 20,
  },
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
  // wire "both": the settings PUT binds these four snake_case only, and a camelCase-only save
  // of them was answered {"saved": true} and changed nothing.
  fromRule(rule(MONITORING_RULES, "device_error_retention_days"), "monitoring",
    "How long a resolved board fault is kept.", { unit: "days", wire: "both" }),
  fromRule(rule(REALTIME_RULES, "realtime_fallback_after_failures"), "monitoring",
    "Failures in a row before a screen re-reads on a timer instead of live.", { unit: "tries" }),
  fromRule(rule(MONITORING_RULES, "device_error_max_open_rows"), "monitoring",
    "Past this, one board's new faults are counted rather than kept.", { advanced: true, unit: "faults", wire: "both" }),
  fromRule(rule(REALTIME_RULES, "sse_keepalive_seconds"), "monitoring",
    "How often a live connection is proven alive. Keep it under 60.", { advanced: true, unit: "s" }),
  fromRule(rule(REALTIME_RULES, "realtime_poll_seconds_control_board"), "monitoring",
    "The control board's timer once live updates are given up on.", { advanced: true, unit: "s", wire: "both" }),
  fromRule(rule(REALTIME_RULES, "control_board_resync_seconds"), "monitoring",
    "A full re-read, so a wall screen that missed an update catches up.", { advanced: true, unit: "s", wire: "both" }),
];

// The admin notifier's numbers (R23). Snake_case on the wire: nothing ever sent them any other way,
// so the API binds that one spelling. Bounds are `AdminNotificationSettings`' own constants.
const SNAKE = { kind: "number", integer: true, range: true, optional: true, wire: "snake" } as const;

const ALERTS: SettingDef[] = [
  {
    ...SNAKE, key: "application_reminder_hours", section: "alerts", label: "Remind about waiting applications after (hours)",
    unit: "h",
    description: "Once an application has waited this long, every admin is reminded daily until it is dealt with.",
    help: "1–168. A day is what an applicant is told to expect. The reminder repeats once a day while any application"
      + " has waited longer than this, and stops the moment none has.",
    min: 1, max: 168, defaultValue: 24,
  },
  {
    ...SNAKE, key: "fault_spike_count", section: "alerts", label: "Fault spike (faults)", unit: "faults",
    description: "Different faults open at once across the club’s boards before every admin is emailed.",
    help: "2–100. Counts DIFFERENT open faults of error or worse inside the window beside this — one board repeating the"
      + " same fault is one. The quiet time between two spike emails is the Alert cooldown under Court boxes.",
    min: 2, max: 100, defaultValue: 5,
  },
  {
    ...SNAKE, key: "fault_spike_minutes", section: "alerts", label: "Fault spike window (minutes)", unit: "min",
    description: "The window those faults have to fall inside.",
    help: "5–240. The faults above count only if they all opened inside this many minutes.",
    min: 5, max: 240, defaultValue: 15,
  },
  {
    ...SNAKE, key: "topup_failure_cooldown_minutes", section: "alerts", label: "Failed purchase emails — quiet time (minutes)",
    unit: "min",
    description: "Package purchases that fail for the same reason inside this time are one email, not one per member.",
    help: "5–1440. A payment gateway having a bad quarter of an hour fails every member who tries; the club hears it"
      + " once per reason inside this window. It cannot go below 5, so a failing gateway never becomes an email per member.",
    min: 5, max: 1440, defaultValue: 30,
  },
  {
    ...SNAKE, key: "overdraft_cooldown_minutes", section: "alerts", label: "Below-zero booking emails — quiet time (minutes)",
    unit: "min",
    description: "One admin booking the same member below zero inside this time is one email.",
    help: "1–240. A bulk booking of twenty courts below zero is one decision, so it is one email to the other admins"
      + " rather than twenty. It cannot go below 1.",
    min: 1, max: 240, defaultValue: 15,
  },
  {
    ...SNAKE, key: "admin_notification_retention_days", section: "alerts", label: "Keep alerts on the Overview for (days)",
    unit: "days", advanced: true,
    description: "Finished alerts older than this are deleted from Recent alerts.",
    help: "7–730. Past this an alert that was emailed, held back or given up on is DELETED from the Overview’s Recent"
      + " alerts. One still waiting to be sent is never deleted by age.",
    min: 7, max: 730, defaultValue: 90,
  },
];

// P12 — the play numbers (play.md §6.4). Snake_case on the wire, as every key since R23: the
// settings PUT binds them by `JsonPropertyName`. Bounds are `PlaySettings.cs`' own.
const PLAY_KEY = { section: "play", integer: true, range: true, optional: true, wire: "snake" } as const;

const PLAY: SettingDef[] = [
  {
    ...PLAY_KEY, kind: "number", key: "result_autoconfirm_hours", label: "Result confirms itself after (hours)", unit: "h",
    description: "A recorded result nobody answers is confirmed after this long.",
    help: "12–168. Silence is consent to the score shown: an edit restarts the clock. A disputed result never confirms"
      + " itself — it waits for an admin.",
    min: 12, max: 168, defaultValue: 48,
  },
  {
    ...PLAY_KEY, kind: "number", key: "result_record_days", label: "Results can be recorded for (days)", unit: "days",
    description: "How long after a game its players can still record the result.",
    help: "1–30, counted from the booking's end. Recording opens the moment the court is checked in at the box.",
    min: 1, max: 30, defaultValue: 7,
  },
  {
    ...PLAY_KEY, kind: "number", key: "streak_rest_every_weeks", label: "A rest week every (weeks played)", unit: "weeks",
    description: "Weeks played in a row that earn one rest week.",
    help: "2–12. A missed week spends a banked rest week automatically, so the streak carries on.",
    min: 2, max: 12, defaultValue: 4,
  },
  {
    ...PLAY_KEY, kind: "number", key: "streak_rest_cap", label: "Rest weeks a member can bank", unit: "weeks",
    description: "The most rest weeks held at once. 0 turns rest weeks off.",
    help: "0–4. A rest week earned past this is not kept.",
    min: 0, max: 4, defaultValue: 2,
  },
  {
    ...PLAY_KEY, kind: "number", key: "streak_pause_weeks_per_year", label: "Injury pause weeks a year", unit: "weeks",
    description: "How many weeks a year a member's injury pause can hold their streak. 0 turns pausing off.",
    help: "0–26, per calendar year. Past it the pause stays on but the weeks count again.",
    min: 0, max: 26, defaultValue: 8,
  },
  {
    ...PLAY_KEY, kind: "minuteOfDay", key: "play_early_bird_before_minute", label: "Early bird: sessions starting before",
    description: "A session starting before this time earns the Early bird badge.",
    help: "Midnight to midday (00:00–12:00). A badge already earned stays when this changes.",
    min: 0, max: 720, defaultValue: 420,
  },
  {
    ...PLAY_KEY, kind: "minuteOfDay", key: "play_night_owl_from_minute", label: "Night owl: sessions starting from",
    description: "A session starting at or after this time earns the Night owl badge.",
    help: "Midday to 23:59 (12:00–23:59). A badge already earned stays when this changes.",
    min: 720, max: 1439, defaultValue: 1260,
  },
];

/** Every setting on the page, in page order. */
export const SETTINGS: readonly SettingDef[] = [
  ...BOOKINGS, ...HOURS, ...CANCELLATIONS, ...MONEY, ...SCHEDULES, ...BOXES, ...BOX_V3, ...HARDWARE, ...SCREENS, ...DOORS, ...RECORDS,
  ...MONITORING, ...MONITORING_DEVICE, ...ALERTS, ...PLAY,
];

const BY_KEY = new Map(SETTINGS.map((def) => [def.key, def]));

// ---------------------------------------------------------------------------------------
// Alert cooldowns the API serves that this registry has no row for
// ---------------------------------------------------------------------------------------

/**
 * The notifier's per-kind quiet times. The two the API serves today (`topup_failure_cooldown_minutes`,
 * `overdraft_cooldown_minutes`) are rows above with the server's own bounds. Any OTHER
 * `*_cooldown_minutes` key the API serves and this table does not name still becomes a row in
 * Admin alerts, so a kind added on the server is editable the day it ships. Its bound is the
 * SERVER's: the page does not invent one, and a value outside it comes back as
 * `<key>_out_of_range`, which the save names by this label.
 */
const COOLDOWN_KEY = /^([a-z][a-z0-9_]*)_cooldown_minutes$/;

const COOLDOWN_HELP = "The club’s system sets the range it accepts. A value outside it is refused when you save, and"
  + " the refusal names this field.";

// One object per key for the life of the page, so a memoised row is not re-rendered by a new def.
const cooldownDefs = new Map<string, SettingDef>();

function cooldownDef(key: string): SettingDef | undefined {
  if (BY_KEY.has(key)) return undefined;
  const match = COOLDOWN_KEY.exec(key);
  if (!match) return undefined;
  const cached = cooldownDefs.get(key);
  if (cached) return cached;
  const words = match[1].replaceAll("_", " ");
  const def: SettingDef = {
    key, section: "alerts", kind: "number", unit: "min", integer: true, range: false, optional: true, wire: "snake",
    label: `Quiet time between “${words}” emails (minutes)`,
    description: `The least time between two “${words}” emails.`,
    help: COOLDOWN_HELP,
  };
  cooldownDefs.set(key, def);
  return def;
}

/**
 * One row with the range the API serves for it (`bounds`, device-api §10), which outranks any
 * client copy. Cached by key and range, so a memoised row keeps its def while the bound holds.
 */
const boundDefs = new Map<string, SettingDef>();

function withServedBound(def: SettingDef, settings: AdminSettings): SettingDef {
  const held = settings as unknown as Record<string, unknown>;
  if (def.kind === "number") return withServedRange(def, held);
  if (def.kind === "select") return withServedChoices(def, held);
  return def;
}

function withServedRange(def: SettingDef, held: Record<string, unknown>): SettingDef {
  const bound = servedBound(held, def.key);
  if (!bound) return def;
  if (def.min === bound.min && def.max === bound.max) return def;
  const id = `${def.key}|${bound.min}|${bound.max}`;
  const cached = boundDefs.get(id);
  if (cached) return cached;
  const next: SettingDef = { ...def, min: bound.min, max: bound.max, range: true };
  boundDefs.set(id, next);
  return next;
}

function withServedChoices(def: SettingDef, held: Record<string, unknown>): SettingDef {
  const values = servedValues(held, def.key);
  if (!values) return heldChoiceOnly(def, held);
  const id = `${def.key}|${values.join(",")}`;
  const cached = boundDefs.get(id);
  if (cached) return cached;
  const known = new Map((def.options ?? []).map((option) => [option.value, option.label]));
  const next: SettingDef = {
    ...def, options: values.map((value) => ({ value, label: known.get(value) ?? hwValueLabel(def.key, value) ?? value })),
  };
  boundDefs.set(id, next);
  return next;
}

/**
 * A served-bounds select with no served values (a hardware key on an API that lists none)
 * offers only what it holds: never an enumeration the client made up.
 */
function heldChoiceOnly(def: SettingDef, held: Record<string, unknown>): SettingDef {
  const current = held[def.key];
  if (!def.serverBounds || (def.options ?? []).length > 0) return def;
  if (typeof current !== "string" && typeof current !== "number") return def;
  return { ...def, options: [{ value: String(current), label: hwValueLabel(def.key, String(current)) ?? String(current) }] };
}

/** Whether the API serves a range (or value list) for any key at all. */
function servesBounds(settings: AdminSettings): boolean {
  const bounds = (settings as unknown as { bounds?: unknown }).bounds;
  return typeof bounds === "object" && bounds !== null && Object.keys(bounds).length > 0;
}

/**
 * The registry, with every served bound applied, plus a row for every alert cooldown the API
 * serves that the registry does not name.
 */
export function settingsFor(settings: AdminSettings): readonly SettingDef[] {
  const extra = Object.keys(settings).sort()
    .map((key) => ((settings as unknown as Record<string, unknown>)[key] === undefined ? undefined : cooldownDef(key)))
    .filter((def): def is SettingDef => def !== undefined);
  const all = extra.length === 0 ? SETTINGS : [...SETTINGS, ...extra];
  if (!servesBounds(settings)) return all;
  return all.map((def) => withServedBound(def, settings));
}

export function settingDef(key: string, settings?: AdminSettings): SettingDef | undefined {
  const def = BY_KEY.get(key) ?? cooldownDef(key);
  return def && settings ? withServedBound(def, settings) : def;
}

export function sectionDef(id: SettingsSectionId): SettingsSectionDef {
  return SETTINGS_SECTIONS.find((section) => section.id === id)!;
}

/** A section's rows — with the served cooldowns, when handed the document that serves them. */
export function settingsIn(section: SettingsSectionId, settings?: AdminSettings): SettingDef[] {
  return (settings ? settingsFor(settings) : SETTINGS).filter((def) => def.section === section);
}

/**
 * The section a settings key — or a weekday row's pseudo-key (`operating_hours_sat`) — lives in.
 */
export function sectionOfKey(key: string): SettingsSectionId | undefined {
  if (key.startsWith("operating_hours")) return "hours";
  return settingDef(key)?.section;
}

/** A field's caption in the club's own currency — the one reader, so a jump link and a label agree. */
export function settingLabel(key: string, currency: string): string {
  return (settingDef(key)?.label ?? key).replaceAll("{currency}", currency);
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

/**
 * The control's edge wears the short unit ("min", "h", "s"); a caption is a sentence and says it
 * in words (R8 J8-4). The edge tag is aria-hidden on the promise that the caption says it.
 */
const SPOKEN_UNITS: Readonly<Record<string, readonly [string, string]>> = {
  min: ["minute", "minutes"], h: ["hour", "hours"], s: ["second", "seconds"],
};

function spokenUnit(unit: string, upTo: number): string {
  const words = SPOKEN_UNITS[unit];
  if (!words) return unit;
  return upTo === 1 ? words[0] : words[1];
}

/** The visible line under a field: what the setting is, then the range it accepts, in words. */
export function describeSetting(def: SettingDef, currency: string): string {
  const line = def.description.replaceAll("{currency}", currency);
  if (def.kind !== "number" || def.min === undefined || typeof def.max !== "number") return line;
  const unit = unitOf(def, currency);
  const range = def.minExclusive ? `more than 0, up to ${def.max}` : `${def.min}–${def.max}`;
  const suffix = unit && !def.unitBefore ? ` ${spokenUnit(unit, def.max)}` : "";
  return `${line} Allowed: ${range}${suffix}.`;
}

/** Whether the API serves this key — an optional row for an absent key is not rendered at all. */
export function isServed(def: SettingDef, settings: AdminSettings): boolean {
  if (!def.optional) return true;
  return (settings as unknown as Record<string, unknown>)[def.key] !== undefined;
}

/** The numeric keys — the ones an emptied box (NaN) is a complaint about. */
export const NUMERIC_KEYS: readonly string[] = SETTINGS.filter((def) => def.kind === "number").map((def) => def.key);

/** The same, with the served cooldowns. */
export function numericKeysOf(settings: AdminSettings): readonly string[] {
  const all = settingsFor(settings);
  return all === SETTINGS ? NUMERIC_KEYS : all.filter((def) => def.kind === "number").map((def) => def.key);
}

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
  for (const def of settingsFor(settings)) {
    if (!def.range) continue;
    if (def.serverBounds && (def.min === undefined || def.max === undefined)) continue; // the API's refusal names it
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
