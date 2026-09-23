import type { AdminSettings } from "@/lib/api";
import { ecoSettingComplaints } from "@/lib/ecoSettings";
import {
  DAY_KEYS, DAY_NAMES, deviceNumbersComplaint, doorSettingComplaints, gateSettingComplaints, operatingHoursComplaint,
  type SettingComplaint,
} from "@/lib/tenantSettings";
import {
  type SettingDef, NUMERIC_KEYS, SETTINGS, SETTINGS_SECTIONS, defaultDayComplaint, peakHoursComplaint, rangeComplaints, sectionOfKey,
  settingLabel, type SettingsSectionId,
} from "@/lib/settingsSchema";
import { SETTINGS_COPY } from "@/lib/settingsCopy";

/**
 * The Settings page's working copy, as pure functions: what an empty box is, what stands between
 * the page and a save, and what has changed since the last one.
 *
 * <p>
 * <b>An empty box is not zero.</b> (B5 / C11) `Number("")` is `0`, so a cleared field used to SET
 * the setting to zero — for `gate_early_entry_minutes` that is in range and would have been saved.
 * `NaN` is the sentinel for "the box is empty": it renders as an empty input, fails every bound,
 * and because Save cannot be pressed while any field holds one it never reaches the wire.
 * </p>
 */
export const toNumber = (raw: string): number => (raw.trim() === "" ? Number.NaN : Number(raw));

/** What a number input shows: its value, or an empty box for a field that has been cleared. */
export const shown = (value: number | undefined): number | string => (Number.isFinite(value) ? (value as number) : "");

/** A reason this page cannot be saved, with the field it belongs to and that field's caption. */
export type Blocker = SettingComplaint & { label: string };

type Held = Record<string, unknown>;

function emptyNumberComplaints(settings: AdminSettings, currency: string): SettingComplaint[] {
  const held = settings as unknown as Held;
  return NUMERIC_KEYS
    .filter((key) => typeof held[key] === "number" && !Number.isFinite(held[key]))
    .map((key) => ({
      key,
      message: `${settingLabel(key, currency)} needs a number — an empty box is not the same as 0.`,
    }));
}

/** Where a key sits on the page, for reading the complaints in the order an admin meets them. */
function pageOrder(key: string): number {
  const section = sectionOfKey(key);
  const sectionIndex = SETTINGS_SECTIONS.findIndex((candidate) => candidate.id === section);
  const settingIndex = SETTINGS.findIndex((def) => def.key === key);
  const day = DAY_KEYS.findIndex((candidate) => key === `operating_hours_${candidate}`);
  return sectionIndex * 1000 + (settingIndex >= 0 ? settingIndex : 900 + day);
}

/**
 * Everything standing between the page and a save, in the order an admin meets it reading down.
 *
 * <p>
 * An emptied field WINS over the bound-check for the same key: both are true of a cleared box,
 * but "has to be a whole number between 1 and 30" is a confusing thing to be told about a field
 * you have just emptied, and two messages on one input is worse than one.
 * </p>
 */
export function blockersOf(settings: AdminSettings, currency: string): Blocker[] {
  const empties = emptyNumberComplaints(settings, currency);
  const emptied = new Set(empties.map((complaint) => complaint.key));
  const cooldown = deviceNumbersComplaint(settings);
  const rules: SettingComplaint[] = [
    ...rangeComplaints(settings, { settings, currency }),
    ...defaultDayComplaint(settings),
    ...peakHoursComplaint(settings.peak_hours),
    ...(cooldown ? [{ key: "device_alert_cooldown_minutes", message: cooldown }] : []),
    ...gateSettingComplaints(settings),
    ...doorSettingComplaints(settings),
    // The eco keys' bounds, plus the cross-field rule whose failure appears weeks later: a member
    // booking past the horizon repeating bookings are written to.
    ...ecoSettingComplaints(settings as unknown as Held),
  ].filter((complaint) => !emptied.has(complaint.key));

  // A weekly table with a bad row must not reach the API: the refusal names the day, but a toast
  // that has faded says nothing about which of seven rows to fix.
  const hours = operatingHoursComplaint(settings.operating_hours ?? {});
  const dayRow: Blocker[] = hours
    ? [{ key: `operating_hours_${hours.day}`, label: SETTINGS_COPY.dayHoursLabel(DAY_NAMES[hours.day]), message: hours.message }]
    : [];

  return [
    ...dayRow,
    ...[...empties, ...rules].map((complaint) => ({ ...complaint, label: settingLabel(complaint.key, currency) })),
  ].sort((a, b) => pageOrder(a.key) - pageOrder(b.key));
}

const same = (a: unknown, b: unknown) => Object.is(a, b);

/**
 * Which settings differ from the last saved copy. A weekday counts as its own change
 * (`operating_hours_sat`), because "3 changes" should mean three things an admin did.
 */
export function changedKeys(original: AdminSettings, draft: AdminSettings): string[] {
  const before = original as unknown as Held;
  const after = draft as unknown as Held;
  const keys = SETTINGS.map((def) => def.key).filter((key) => !same(before[key], after[key]));
  const days = DAY_KEYS
    .filter((day) => original.operating_hours?.[day] !== draft.operating_hours?.[day])
    .map((day) => `operating_hours_${day}`);
  return [...keys, ...days];
}

/** The sections holding at least one unsaved change — for each header's dot. */
export function dirtySections(changed: readonly string[]): Set<SettingsSectionId> {
  const out = new Set<SettingsSectionId>();
  for (const key of changed) {
    const section = sectionOfKey(key);
    if (section) out.add(section);
  }
  return out;
}

/**
 * What a save sends: the whole working copy EXCEPT the button map, which the Boards screen owns.
 * The API reads an absent key as unchanged, so leaving it out is what stops this page reverting a
 * remap somebody made there.
 */
export function savePayload(settings: AdminSettings) {
  const { button_map: _buttonMap, ...withoutButtonMap } = settings;
  return withoutButtonMap;
}

/** Club times are chosen, never typed. Quarter-hours, or 5 minutes where a stored time is not one. */
export function clockStep(values: readonly (string | undefined)[]): number {
  return values.every((value) => !value || Number(value.split(":")[1]) % 15 === 0) ? 15 : 5;
}

/** Whether this kind of control carries the setting's guidance on its own `aria-describedby`. */
export function takesDescription(def: SettingDef): boolean {
  return def.kind !== "minuteOfDay" && def.kind !== "peakHours";
}

/** The ring a deep-linked field wears for a moment, so the eye lands where focus did. */
export const HIGHLIGHT_CLASS = "ring-2 ring-accent-strong ring-offset-4 ring-offset-bg-surface";
