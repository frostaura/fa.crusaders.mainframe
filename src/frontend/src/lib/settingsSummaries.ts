import type { AdminSettings } from "./api";
import { GATE_POLICY_LABELS } from "./gateCopy";
import { DAY_KEYS } from "./tenantSettings";
import { minuteLabel, parsePeakHours, type SettingsSectionId } from "./settingsSchema";

/**
 * One line per Settings section, read off the WORKING copy (plan R13: "each header showing title +
 * live one-line summary").
 *
 * <p>
 * <b>Why a summary at all.</b> Collapsed, a section is a title — and "Door gates" says nothing
 * about how the doors are set. The summary is the section's answer in one breath, so an admin can
 * read the whole club's configuration down ten collapsed rows and only open the one that is wrong.
 * It follows the working copy rather than the saved one because the admin editing a field is the
 * person who most needs to see the headline move.
 * </p>
 *
 * <p>
 * <b>Only what is true.</b> A key the API does not serve is left out of the line rather than
 * quoted at a default this console invented, and an emptied box reads as "not set" rather than as
 * `NaN`. A section with nothing to say says so plainly.
 * </p>
 */

type Held = Record<string, unknown>;

const num = (settings: AdminSettings, key: string): number | null => {
  const value = (settings as unknown as Held)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const join = (parts: (string | null | false | undefined)[]) =>
  parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");

function bookings(settings: AdminSettings): string {
  const slice = num(settings, "slice_minutes");
  const ahead = num(settings, "advance_booking_days");
  const minutes = num(settings, "member_per_day_max_minutes");
  const slots = num(settings, "member_max_slots_per_day");
  const peak = parsePeakHours(settings.peak_hours ?? "");
  return join([
    slice !== null && `${slice}-min slices`,
    ahead !== null && `${plural(ahead, "day")} ahead`,
    minutes !== null && (minutes > 0 ? `${minutes} min a day each` : "no daily time limit"),
    slots !== null && slots > 0 && `${plural(slots, "slot")} a day`,
    peak && `peak ${peak.start}–${peak.end}`,
  ]);
}

function hours(settings: AdminSettings): string {
  const own = DAY_KEYS.filter((day) => settings.operating_hours?.[day] !== undefined).length;
  const club = `${minuteLabel(settings.day_start_minute)}–${minuteLabel(settings.day_end_minute)} by default`;
  if (own === 0) return club;
  if (own === DAY_KEYS.length) return "Every day has its own hours";
  return join([club, `${plural(own, "day")} with ${own === 1 ? "its" : "their"} own hours`]);
}

function cancellations(settings: AdminSettings): string {
  const pct = num(settings, "penalty_pct");
  const window = num(settings, "penalty_window_minutes");
  const grace = num(settings, "grace_window_minutes");
  return join([
    pct !== null && window !== null && (pct > 0 ? `${pct}% penalty inside ${window} min` : "no late-cancel penalty"),
    grace !== null && `${grace}-min grace before a no-show`,
  ]);
}

/**
 * P13: the section holds the currency symbol alone — packages and group discounts live on their
 * own pages — so the line says how money works here, in the club's own symbol.
 */
function money(_settings: AdminSettings, currency: string): string {
  return `Minutes bought in packages, priced in ${currency}`;
}

function schedules(settings: AdminSettings): string {
  const days = num(settings, "schedule_materialisation_days");
  return days === null ? "" : `Written ${plural(days, "day")} ahead`;
}

function boxes(settings: AdminSettings): string {
  const walkUp = num(settings, "walk_up_max_minutes");
  const cue = num(settings, "activation_cue_window_minutes");
  return join([
    walkUp !== null && `walk-ups up to ${walkUp} min`,
    cue !== null && `lights on ${cue} min early`,
  ]);
}

function screens(settings: AdminSettings): string {
  const revert = num(settings, "lcd_revert_seconds");
  const rapid = num(settings, "rapid_scan_window_seconds");
  return join([
    revert !== null && `results show ${revert} s`,
    rapid !== null && (rapid > 0 ? `next scan within ${rapid} s` : "one person at a time"),
  ]);
}

function doors(settings: AdminSettings): string {
  const policy = GATE_POLICY_LABELS[settings.gate_access_policy] as string | undefined;
  const unlock = num(settings, "gate_unlock_seconds");
  return join([policy, unlock !== null && `lock released ${unlock} s`]);
}

function records(settings: AdminSettings): string {
  const years = num(settings, "retention_years");
  const doorDays = num(settings, "door_log_retention_days");
  const trace = settings.member_trace_enabled;
  return join([
    years !== null && `history ${plural(years, "year")}`,
    doorDays !== null && `door scans ${plural(doorDays, "day")}`,
    trace !== undefined && (trace ? "night view on" : "night view off"),
  ]);
}

function monitoring(settings: AdminSettings): string {
  const faults = num(settings, "device_error_retention_days");
  const fallback = num(settings, "realtime_fallback_after_failures");
  return join([
    faults !== null && `faults kept ${plural(faults, "day")}`,
    fallback !== null && `live, timer after ${plural(fallback, "failure")}`,
  ]);
}

function alerts(settings: AdminSettings): string {
  const reminder = num(settings, "application_reminder_hours");
  const count = num(settings, "fault_spike_count");
  const minutes = num(settings, "fault_spike_minutes");
  const kept = num(settings, "admin_notification_retention_days");
  const line = join([
    reminder !== null && `applications chased after ${plural(reminder, "hour")}`,
    count !== null && minutes !== null && `${count} faults in ${minutes} min is a spike`,
    kept !== null && `alerts kept ${plural(kept, "day")}`,
  ]);
  // An API without the club's thresholds still has each admin's own switches in this section, so
  // "not available" would be false of it.
  return line || "Which alerts reach your inbox";
}

/** P12 — "results confirm after 48 hours, a rest week every 4 weeks played". */
function play(settings: AdminSettings): string {
  const confirm = num(settings, "result_autoconfirm_hours");
  const every = num(settings, "streak_rest_every_weeks");
  const cap = num(settings, "streak_rest_cap");
  return join([
    confirm !== null && `results confirm after ${plural(confirm, "hour")}`,
    every !== null && cap !== null && (cap > 0 ? `a rest week every ${plural(every, "week")} played` : "no rest weeks"),
  ]);
}

const SUMMARY: Record<SettingsSectionId, (settings: AdminSettings, currency: string) => string> = {
  bookings, hours, cancellations, money, schedules, boxes, screens, doors, records, monitoring, alerts, play,
};

/** What a collapsed section says about itself. Never empty: an unserved section says so. */
export function sectionSummary(id: SettingsSectionId, settings: AdminSettings, currency: string): string {
  const line = SUMMARY[id](settings, currency);
  if (!line) return "Not available on this club's system yet";
  return line.charAt(0).toUpperCase() + line.slice(1);
}
