import { ApiError, type AdminSettings } from "@/lib/api";
import { describeDeviceError } from "@/lib/deviceErrors";
import { ecoSettingComplaints } from "@/lib/ecoSettings";
import {
  DAY_KEYS, DAY_NAMES, deviceNumbersComplaint, doorSettingComplaints, gateSettingComplaints, operatingHoursComplaint,
  type SettingComplaint,
} from "@/lib/tenantSettings";
import {
  type SettingDef, SETTINGS, SETTINGS_SECTIONS, defaultDayComplaint, numericKeysOf, peakHoursComplaint, rangeComplaints,
  sectionOfKey, settingDef, settingLabel, settingsFor, type SettingsSectionId,
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
  return numericKeysOf(settings)
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
  const keys = settingsFor(draft).map((def) => def.key).filter((key) => !same(before[key], after[key]));
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
 * What a save sends: the whole working copy EXCEPT the button map, which the Boards screen owns,
 * and the league rate, which is the League group's now (D2). The API reads an absent key as
 * unchanged, so leaving the map out is what stops this page reverting a remap somebody made
 * there; and it REFUSES the league rate (400 `credits_per_zar_league_moved_to_groups`), so an API
 * still serving it on the read must not have it echoed back on the save.
 */
export function savePayload(settings: AdminSettings): AdminSettings {
  const copy = { ...(settings as unknown as Held) };
  delete copy.button_map;
  delete copy.credits_per_zar_league;
  return copy as unknown as AdminSettings;
}

/** Sent back as read, camelCase: the tenant's default court price, which the PUT requires. */
const ROUND_TRIP = ["slice_price_credits", "operating_hours"] as const;

const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * The PUT body: every row this page shows, under the spelling(s) the API binds for it (the
 * registry's `wire`), plus the two keys the API needs back as read. Nothing the page does not show
 * is sent, so a save from here cannot revert a key another screen owns.
 *
 * <p>
 * <b>Why the page builds its own body</b> rather than `endpoints.adminSettingsSave`'s: that mapper
 * names each key by hand and camelCases all of them, so a key it has not heard of — every alert
 * number R23 adds, and every per-kind cooldown the server serves — never reached the wire, and the
 * five snake-only box and monitoring keys it did send were bound by nothing. The registry already
 * knows every row; this is it, spelled the way the server listens. `settings-wire.test.ts` holds
 * it equal to the mapper for every key the two share.
 * </p>
 */
export function wireBody(settings: AdminSettings): Record<string, unknown> {
  const held = settings as unknown as Held;
  const body: Record<string, unknown> = {};
  const put = (key: string, wire: SettingDef["wire"] = "camel") => {
    const value = held[key];
    if (value === undefined) return;
    if (wire !== "snake") body[camel(key)] = value;
    if (wire !== "camel") body[key] = value;
  };
  for (const key of ROUND_TRIP) put(key);
  for (const def of settingsFor(settings)) put(def.key, def.wire);
  return body;
}

/**
 * A refused save, in words. The shared device-error dictionary first (a code that HAS a sentence
 * gets it); then the two refusals this page can name better than a token read aloud: a value
 * outside the server's bound, named by the field's own caption — the only bound the page knows
 * for a cooldown the server added — and the league rate that moved to Groups.
 */
export function describeSaveFailure(err: unknown, currency: string): string {
  const said = describeDeviceError(err, SETTINGS_COPY.saveFailed);
  const code = err instanceof ApiError ? err.code : null;
  if (!code || said !== code.replace(/_/g, " ")) return said;
  if (code === "credits_per_zar_league_moved_to_groups") return SETTINGS_COPY.leagueRateMoved;
  const key = /^(.+)_out_of_range$/.exec(code)?.[1];
  if (key && settingDef(key)) return `${settingLabel(key, currency)} is outside what the club’s system accepts. Nothing was saved.`;
  return said;
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
