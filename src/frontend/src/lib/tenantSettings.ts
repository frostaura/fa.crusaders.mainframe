import { GATE_ACCESS_POLICIES, type GateAccessPolicy } from "./api";

/**
 * Small derivations from the club's own settings, kept out of the settings page.
 *
 * <p>
 * Both of these mirror a rule the API owns. That is a duplication worth having — the
 * admin is choosing a number and needs to know what it buys before they press Save, not
 * after a box has been dark for three minutes — but it is a duplication, so it lives in
 * one named place with the server constant it mirrors written down beside it, rather than
 * inline in a hint string where the next person to change the server has no chance of
 * finding it.
 * </p>
 */

/**
 * The floor under the offline threshold, in seconds.
 *
 * Mirrors <code>HeartbeatCadence.MinOfflineAfterSeconds</code>. A club on the 15-second
 * minimum interval must not be called offline after 45 seconds of ordinary jitter.
 */
export const OFFLINE_FLOOR_SECONDS = 180;

/** Mirrors <code>HeartbeatCadence.MissedBeatsBeforeOffline</code>. */
export const MISSED_BEATS_BEFORE_OFFLINE = 3;

/** Mirrors <code>HeartbeatCadence.MinSeconds</code> / <code>MaxSeconds</code> — the range a box honours. */
export const HEARTBEAT_MIN_SECONDS = 15;
export const HEARTBEAT_MAX_SECONDS = 300;

/** The interval a box will actually run at, given what the tenant asked for. */
export function effectiveHeartbeatSeconds(configured: number): number {
  if (!Number.isFinite(configured)) return HEARTBEAT_MIN_SECONDS;
  return Math.min(HEARTBEAT_MAX_SECONDS, Math.max(HEARTBEAT_MIN_SECONDS, Math.trunc(configured)));
}

/** How long a box may be silent before the Devices page calls it offline. */
export function offlineAfterSeconds(configured: number): number {
  return Math.max(OFFLINE_FLOOR_SECONDS, effectiveHeartbeatSeconds(configured) * MISSED_BEATS_BEFORE_OFFLINE);
}

/**
 * The offline threshold in the words a hint should use.
 *
 * The settings hint used to promise "three missed beats" flatly, which is true only above
 * 60 seconds; below that the floor takes over and an admin lowering the interval to catch
 * an outage sooner got exactly no improvement and no explanation.
 */
export function describeOfflineAfter(configured: number): string {
  const seconds = offlineAfterSeconds(configured);
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
}

/**
 * The three door-gate bounds, mirroring the API's own
 * <code>AdminConfigEndpoints.ValidateDeviceNumbers</code>.
 *
 * <p>
 * The unlock maximum is mirrored twice over on purpose: the API refuses anything above it,
 * AND the firmware clamps the released window to it (<code>GATE_UNLOCK_HARD_CAP_MS</code>)
 * so that a value smuggled past the API by any other route still cannot hold a lock open
 * longer. The console states the bound rather than only enforcing it, because "30" on its
 * own reads as an arbitrary form limit rather than as what the hardware will do.
 * </p>
 */
export const GATE_UNLOCK_MIN_SECONDS = 1;
export const GATE_UNLOCK_MAX_SECONDS = 30;
export const GATE_EARLY_ENTRY_MIN_MINUTES = 0;
export const GATE_EARLY_ENTRY_MAX_MINUTES = 240;

/** Mirrors <code>AdminConfigEndpoints.ValidateDeviceNumbers</code> for the two court windows. */
export const ROSTER_WINDOW_MIN_MINUTES = 5;
export const ROSTER_WINDOW_MAX_MINUTES = 1440;
export const ACTIVATION_CUE_MIN_MINUTES = 0;
export const ACTIVATION_CUE_MAX_MINUTES = 1440;

/**
 * The hard ceiling on how early a booking's own QR opens a door, in minutes.
 *
 * Mirrors <code>GateAccess.MaxEarlyEntryMinutes</code>. Four hours, and the API applies it
 * inside the one function that answers the question, so no combination of settings — legal
 * or hand-edited — buys a door a wider horizon than this.
 */
export const DOOR_BOOKING_HORIZON_MAX_MINUTES = 240;

/**
 * How far before a booking that booking's own QR opens a door, given the club's current
 * settings. Mirrors <code>BookingCodeWindow.DoorHorizonMinutes</code>.
 *
 * <p>
 * <b>Why this exists at all.</b> The settings screen printed
 * <code>gate_early_entry_minutes</code> and called it the window a booking QR opens a door
 * in. Under <code>booking_window</code> it is. Under <code>active_member</code> — the API's
 * default, so what most clubs are actually running — the door accepts a booking's code for
 * exactly as long as the member's own phone would have shown it, which is
 * <code>roster_window_minutes + activation_cue_window_minutes</code>: 130 minutes at the
 * defaults, while the screen said 30. An admin narrowing "Early entry" to 5 narrowed nothing,
 * and nothing on the screen said which two fields they wanted instead.
 * </p>
 *
 * <p>
 * The <code>max</code> is what keeps online at least as permissive as offline: the cached
 * roster admits a booking from <code>StartsAt − gate_early_entry_minutes</code>, so a door
 * accepting less than that while it could reach the server would refuse, online, a member it
 * would have admitted during an outage.
 * </p>
 *
 * <p>
 * <b>The inputs are clamped before the arithmetic</b>, as the API clamps them on read. The
 * settings document is a JSON column, a hand edit can put anything in it, and the point of
 * the cap is that nothing widens a door past it.
 * </p>
 */
export function doorBookingHorizonMinutes(settings: {
  gate_access_policy: string;
  gate_early_entry_minutes: number;
  roster_window_minutes: number;
  activation_cue_window_minutes: number;
}): number {
  const early = clamp(settings.gate_early_entry_minutes, GATE_EARLY_ENTRY_MIN_MINUTES, GATE_EARLY_ENTRY_MAX_MINUTES);
  // The strict policy's whole claim is that a member may be in the building because they are
  // due on a court, so the entry window is when they are due — and nothing else reaches it.
  if (settings.gate_access_policy === "booking_window") return early;
  const roster = clamp(settings.roster_window_minutes, ROSTER_WINDOW_MIN_MINUTES, ROSTER_WINDOW_MAX_MINUTES);
  const cue = clamp(settings.activation_cue_window_minutes, ACTIVATION_CUE_MIN_MINUTES, ACTIVATION_CUE_MAX_MINUTES);
  return Math.max(early, Math.min(roster + cue, DOOR_BOOKING_HORIZON_MAX_MINUTES));
}

/** A settings value as the API would read it: whole, inside its bounds, and never NaN. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * How long the club waits between "not reporting" emails about one board, in minutes.
 *
 * Mirrors the API's <code>device_alert_cooldown_minutes</code> bound. It is a device number
 * rather than a door one: a court box that goes quiet flaps exactly as a door does.
 */
export const DEVICE_ALERT_COOLDOWN_MIN_MINUTES = 5;
export const DEVICE_ALERT_COOLDOWN_MAX_MINUTES = 1440;

/**
 * Why the court-box and identification numbers cannot be saved, in a sentence, or null.
 *
 * <p>
 * Same argument as {@link gateSettingsComplaint}: a number input's <code>min</code> and
 * <code>max</code> stop the spinner and nothing else, and Save is not a native submit. An
 * absent key is not a complaint — an older API that does not serve the cooldown leaves it
 * undefined, and omitted means unchanged on the way back, so there is nothing to refuse.
 * </p>
 */
export function deviceNumbersComplaint(settings: { device_alert_cooldown_minutes?: number }): string | null {
  const cooldown = settings.device_alert_cooldown_minutes;
  if (cooldown === undefined) return null;
  if (!inRange(cooldown, DEVICE_ALERT_COOLDOWN_MIN_MINUTES, DEVICE_ALERT_COOLDOWN_MAX_MINUTES)) {
    return `Alert cooldown has to be a whole number of minutes between ${DEVICE_ALERT_COOLDOWN_MIN_MINUTES} and ${DEVICE_ALERT_COOLDOWN_MAX_MINUTES}.`;
  }
  return null;
}

/**
 * Why the door-gate settings cannot be saved, in a sentence, or null when they can.
 *
 * <p>
 * The bounds are on the inputs too, but a number input's <code>min</code> and
 * <code>max</code> stop the spinner and nothing else — a typed or pasted value passes
 * straight through, and Save here is not a native submit, so the browser never says a
 * word. That is the same gap the credits-per-rand <code>step</code> fell through, where
 * the field looked fine while the arrows moved the money conversion rate by a hundredth.
 * The policy is checked against the closed list as well, so a document carrying a value
 * this build does not know about is refused here rather than saved back as a blank select.
 * </p>
 */
export function gateSettingsComplaint(settings: {
  gate_unlock_seconds: number;
  gate_access_policy: string;
  gate_early_entry_minutes: number;
}): string | null {
  if (!inRange(settings.gate_unlock_seconds, GATE_UNLOCK_MIN_SECONDS, GATE_UNLOCK_MAX_SECONDS)) {
    return `Unlock time has to be a whole number of seconds between ${GATE_UNLOCK_MIN_SECONDS} and ${GATE_UNLOCK_MAX_SECONDS}.`;
  }
  if (!inRange(settings.gate_early_entry_minutes, GATE_EARLY_ENTRY_MIN_MINUTES, GATE_EARLY_ENTRY_MAX_MINUTES)) {
    return `Early entry has to be a whole number of minutes between ${GATE_EARLY_ENTRY_MIN_MINUTES} and ${GATE_EARLY_ENTRY_MAX_MINUTES}.`;
  }
  if (!GATE_ACCESS_POLICIES.includes(settings.gate_access_policy as GateAccessPolicy)) {
    return "Pick who may open a door.";
  }
  return null;
}

/**
 * The W1 door numbers, mirroring the API's own bounds (WIRE-W1 §6).
 *
 * <p>
 * Every one of them binds camelCase AND snake_case on the PUT and is clamped again on read,
 * which is this repo's standing rule for a reason: binding one spelling silently answers
 * `{"saved": true}` and changes nothing, and a hand-edited settings document is not a PUT.
 * </p>
 */
export const DOOR_LOG_RETENTION_MIN_DAYS = 7;
export const DOOR_LOG_RETENTION_MAX_DAYS = 730;
export const DOOR_REFUSAL_SPIKE_MIN_COUNT = 3;
export const DOOR_REFUSAL_SPIKE_MAX_COUNT = 100;
export const DOOR_REFUSAL_SPIKE_MIN_MINUTES = 5;
export const DOOR_REFUSAL_SPIKE_MAX_MINUTES = 240;
export const CLUB_CONTACT_PHONE_MAX_LENGTH = 32;
export const CLUB_CONTACT_EMAIL_MAX_LENGTH = 254;

/**
 * Why the door settings cannot be saved, in a sentence, or null when they can.
 *
 * <p>
 * <b>An absent key is not a complaint.</b> An older API that does not serve these leaves them
 * `undefined`, and omitted means unchanged on the way back — so there is nothing to refuse,
 * and a console that refused would be one nobody could save settings from at all.
 * {@link deviceNumbersComplaint} established that rule; this follows it rather than
 * inventing a second.
 * </p>
 *
 * <p>
 * The two contact fields may be EMPTY, deliberately: a club that has not set a phone number
 * is a real state the member surface has copy for, and refusing to save an empty one would
 * make "no contact" impossible to express.
 * </p>
 */
export function doorSettingsComplaint(settings: {
  door_log_retention_days?: number;
  door_refusal_spike_count?: number;
  door_refusal_spike_minutes?: number;
  club_contact_phone?: string;
  club_contact_email?: string;
}): string | null {
  const retention = settings.door_log_retention_days;
  if (retention !== undefined && !inRange(retention, DOOR_LOG_RETENTION_MIN_DAYS, DOOR_LOG_RETENTION_MAX_DAYS)) {
    return `Door scans have to be kept for a whole number of days between ${DOOR_LOG_RETENTION_MIN_DAYS} and ${DOOR_LOG_RETENTION_MAX_DAYS}.`;
  }
  const count = settings.door_refusal_spike_count;
  if (count !== undefined && !inRange(count, DOOR_REFUSAL_SPIKE_MIN_COUNT, DOOR_REFUSAL_SPIKE_MAX_COUNT)) {
    return `A refusal spike has to be a whole number of scans between ${DOOR_REFUSAL_SPIKE_MIN_COUNT} and ${DOOR_REFUSAL_SPIKE_MAX_COUNT}.`;
  }
  const minutes = settings.door_refusal_spike_minutes;
  if (minutes !== undefined && !inRange(minutes, DOOR_REFUSAL_SPIKE_MIN_MINUTES, DOOR_REFUSAL_SPIKE_MAX_MINUTES)) {
    return `The refusal-spike window has to be a whole number of minutes between ${DOOR_REFUSAL_SPIKE_MIN_MINUTES} and ${DOOR_REFUSAL_SPIKE_MAX_MINUTES}.`;
  }
  const phone = settings.club_contact_phone;
  if (phone !== undefined && phone.trim().length > CLUB_CONTACT_PHONE_MAX_LENGTH) {
    return `A club contact number is at most ${CLUB_CONTACT_PHONE_MAX_LENGTH} characters.`;
  }
  const email = settings.club_contact_email;
  if (email !== undefined && email.trim().length > CLUB_CONTACT_EMAIL_MAX_LENGTH) {
    return `A club contact email is at most ${CLUB_CONTACT_EMAIL_MAX_LENGTH} characters.`;
  }
  return null;
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * The zones offered in the timezone picker.
 *
 * <p>
 * <code>Intl.supportedValuesOf("timeZone")</code> is the browser's own copy of the IANA
 * tzdb, which is exactly the free-tier dependency CLAUDE.md names — no hand-kept list to
 * go stale when a country moves its clocks. It is not in every runtime (jsdom does not
 * carry it), so a small fallback covers the zones a club in this product's markets would
 * pick, and the tenant's current value is always present whatever the runtime answered:
 * a select that silently dropped the saved zone would show the club the wrong one and
 * then save it.
 * </p>
 */
export function timezoneOptions(current: string): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  let zones: string[] = [];
  try {
    zones = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  if (zones.length === 0) zones = [...FALLBACK_TIMEZONES];
  return zones.includes(current) ? zones : [current, ...zones];
}

const FALLBACK_TIMEZONES = [
  "Africa/Johannesburg", "Africa/Cairo", "Africa/Lagos", "Africa/Nairobi",
  "Europe/London", "Europe/Amsterdam", "Europe/Monaco", "Europe/Lisbon",
  "Asia/Dubai", "Asia/Singapore", "Australia/Sydney",
  "America/New_York", "America/Chicago", "America/Los_Angeles", "UTC",
] as const;

/**
 * The club's opening hours, per weekday — `tenant_settings.operating_hours`.
 *
 * <p>
 * The engine has read this map since it existed and the console could not write it: the
 * settings screen offered one flat "Day starts / Day ends" pair, the seeder names all seven
 * days, and a per-weekday entry always wins. So a club that saved "Day starts 09:00" got a
 * success toast and a schedule that had not moved — the one setting the product now
 * ENFORCES was the one setting the product could not edit.
 * </p>
 *
 * <p>
 * These helpers are the editor's half of that contract, and they mirror
 * <code>OperatingHours.TryParseWire</code> on the API exactly: the same seven keys, the same
 * <code>HH:mm-HH:mm</code> text, and the same refusal of a close at or before the open —
 * which is a typo, not an overnight club, and would otherwise sell the small hours.
 * </p>
 */

/** The seven keys the settings document uses. Mirrors <code>OperatingHours.DayKeys</code>. */
export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type DayKey = (typeof DAY_KEYS)[number];

/** What a weekday is called on screen. */
export const DAY_NAMES: Record<DayKey, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};

/** One day's hours as the two `<input type="time">` values behind them. */
export type DayHours = { open: string; close: string };

/** `"07:00-20:00"` to its two halves, or null if it is not a range this product writes. */
export function parseDayHours(text: string | undefined): DayHours | null {
  if (!text) return null;
  const parts = text.split("-");
  if (parts.length !== 2) return null;
  const [open, close] = parts.map((p) => p.trim());
  if (!/^\d{1,2}:\d{2}$/.test(open) || !/^\d{1,2}:\d{2}$/.test(close)) return null;
  return { open: pad(open), close: pad(close) };
}

/** Minutes past midnight, or null for anything a time input would not have produced. */
export function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Why this day's hours cannot be saved, in a sentence, or null when they can.
 *
 * The API refuses the same two cases; saying it here is what stops the admin learning it
 * from a toast after the fact, on a form with seven rows and no indication of which one.
 */
export function dayHoursComplaint(hours: DayHours): string | null {
  const open = minutesOf(hours.open);
  const close = minutesOf(hours.close);
  if (open === null || close === null) return "Give an opening and a closing time.";
  if (close <= open) return "Closing time has to be after opening time.";
  return null;
}

/** The whole map's first complaint, as `{ day, message }`, or null when every day is fine. */
export function operatingHoursComplaint(map: Record<string, string>): { day: DayKey; message: string } | null {
  for (const day of DAY_KEYS) {
    const text = map[day];
    if (text === undefined) continue;
    const parsed = parseDayHours(text);
    if (!parsed) return { day, message: "Give an opening and a closing time." };
    const complaint = dayHoursComplaint(parsed);
    if (complaint) return { day, message: complaint };
  }
  return null;
}

/** The wire text for one day. */
export function formatDayHours(hours: DayHours): string {
  return `${pad(hours.open)}-${pad(hours.close)}`;
}

function pad(hhmm: string): string {
  const [h, m] = hhmm.split(":");
  return `${h.padStart(2, "0")}:${m}`;
}
