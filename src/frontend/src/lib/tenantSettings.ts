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
