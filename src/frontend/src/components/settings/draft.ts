import { ApiError, type AdminSettings } from "@/lib/api";
import { describeDeviceError } from "@/lib/deviceErrors";
import { rateLimitedSentence } from "@/lib/errors";
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

/**
 * Unsaved edits carried onto a fresher copy of the club's settings — review round 2, F3-4.
 *
 * <p>
 * Each edit made over `basis` survives unless the club's value for that key has moved since
 * (someone else saved it): their save wins, and the key is named in `dropped`, because restoring
 * over it would silently undo theirs. Every other key takes the fresh value. With nothing carried
 * the fresh object itself comes back, so "no unsaved edits" stays `draft === saved`.
 * </p>
 *
 * <p>
 * <b>Why this exists.</b> The kept draft was restored once per mount and then a SECOND settings
 * read (StrictMode's double effect in development, a retry in production) replaced the working
 * copy with the server's and the mirror erased the kept draft — measured in a real browser:
 * restored, then gone 300 ms later. And any unrelated setting saved by another admin threw the
 * whole draft away.
 * </p>
 */
export function carryEdits(
  basis: AdminSettings, draft: AdminSettings, fresh: AdminSettings,
): { merged: AdminSettings; carried: string[]; dropped: string[] } {
  const before = basis as unknown as Held;
  const edited = draft as unknown as Held;
  const now = fresh as unknown as Held;
  const merged: Held = { ...now };
  const hours: Record<string, string | undefined> = { ...(fresh.operating_hours ?? {}) };
  const carried: string[] = [];
  const dropped: string[] = [];
  for (const key of changedKeys(basis, draft)) {
    const day = /^operating_hours_(.+)$/.exec(key)?.[1] as keyof NonNullable<AdminSettings["operating_hours"]> | undefined;
    const was = day ? basis.operating_hours?.[day] : before[key];
    const is = day ? fresh.operating_hours?.[day] : now[key];
    if (!same(was, is)) { dropped.push(key); continue; }
    carried.push(key);
    if (day) hours[day] = draft.operating_hours?.[day];
    else merged[key] = edited[key];
  }
  if (carried.length === 0) return { merged: fresh, carried, dropped };
  if (carried.some((key) => key.startsWith("operating_hours_"))) {
    merged.operating_hours = Object.fromEntries(Object.entries(hours).filter(([, v]) => v !== undefined));
  }
  return { merged: merged as unknown as AdminSettings, carried, dropped };
}

/**
 * A blocker's or a refusal's sentence, without the caption said twice. Most messages already
 * open with the setting's name ("Screen returns … has to be from 5 to 120."), and the list and the
 * field's live region both put the caption in front of them — "X: X has to be…" (F3-4).
 * Returns the part of the message after the caption, or null when it does not open with it.
 */
export function afterCaption(label: string, message: string): string | null {
  // A trailing "(unit)" is dropped. String methods, not a regex: lizard's lexer reads the
  // bracket class in one as code and scored this function 271 lines long (R4).
  const opened = label.lastIndexOf("(");
  const bare = (label.trimEnd().endsWith(")") && opened >= 0 ? label.slice(0, opened) : label).trim();
  for (const head of [label, bare]) {
    if (head && message.toLowerCase().startsWith(head.toLowerCase())) return message.slice(head.length);
  }
  // Review round 3, I-7: a message that names the setting in its OWN words ("Unlock time has to
  // be…" under "Door unlock time (seconds)", "A refusal spike has to be…") still said it twice.
  // A short subject before "has to be" that shares a word with the caption is that setting: keep
  // the predicate. One that does not ("Closing time" under a day's hours) is another thing, kept.
  const parts = /^([^.:]{1,60}?) (has to be .*)$/.exec(message);
  if (!parts) return null;
  const words = (text: string) => text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
  const caption = new Set(words(label));
  return words(parts[1]).some((w) => caption.has(w) || caption.has(w.replace(/s$/, ""))) ? ` ${parts[2]}` : null;
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
 * The settings P13 retired (contract §3.6, §3.9): the slice price, the conversion rates and the
 * purchase block and cap. The server binds and ignores them and no longer serves them; an API
 * mid-deploy that still does must never have them echoed back, so the console sends none.
 */
export const RETIRED_SETTING_KEYS: readonly string[] = [
  "slice_price_credits", "credits_per_zar_regular", "credits_per_zar_league", "topup_block_zar", "topup_max_zar_per_member",
];

/**
 * What a save sends: the whole working copy EXCEPT the button map, which the Boards screen owns,
 * and the retired keys above. The API reads an absent key as unchanged, so leaving the map out is
 * what stops this page reverting a remap somebody made there.
 */
export function savePayload(settings: AdminSettings): AdminSettings {
  const copy = { ...(settings as unknown as Held) };
  delete copy.button_map;
  for (const key of RETIRED_SETTING_KEYS) delete copy[key];
  return copy as unknown as AdminSettings;
}

/** Sent back as read, camelCase: the weekday map (an empty one is an instruction, so it travels whole). */
const ROUND_TRIP = ["operating_hours"] as const;

const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * The PUT body: every row this page shows, under the spelling(s) the API binds for it (the
 * registry's `wire`), plus the weekday map, sent back as read. Nothing the page does not show
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
 * The document's version, when the API serves one (review round 4, A4-1): a hash of the stored
 * settings, sent back with a save so a page opened before somebody else's save is refused 409
 * rather than quietly putting their old values back. An older API serves none.
 */
export function versionOf(settings: AdminSettings): string | null {
  const version = (settings as unknown as Held).version;
  return typeof version === "string" && version !== "" ? version : null;
}

/** The same settings, stamped with the version the club answered with. */
export function withVersion(settings: AdminSettings, version: unknown): AdminSettings {
  return typeof version === "string" && version !== ""
    ? ({ ...(settings as unknown as Held), version } as unknown as AdminSettings)
    : settings;
}

/**
 * Only what this save changed (A4-1): the keys edited since the copy the page was read from, and
 * the whole weekday map when any day moved (the API takes the map whole; an empty one is an
 * instruction). The API reads every absent key as unchanged.
 */
export function changedPayload(base: AdminSettings, sent: AdminSettings): AdminSettings {
  const held = sent as unknown as Held;
  const out: Held = {};
  for (const key of changedKeys(base, sent)) {
    if (key.startsWith("operating_hours_")) out.operating_hours = sent.operating_hours ?? {};
    else out[key] = held[key];
  }
  return savePayload(out as unknown as AdminSettings);
}

/**
 * The PUT body. Against an API that versions the document: the edited keys and the version they
 * were made over. Against one that does not: the whole page, as before — that API requires the
 * eight booking keys on every save.
 */
export function saveBody(base: AdminSettings, sent: AdminSettings): Record<string, unknown> {
  const version = versionOf(base);
  if (version === null) return wireBody(savePayload(sent));
  const body: Record<string, unknown> = { version };
  const partial = changedPayload(base, sent) as unknown as Held;
  const defs = settingsFor(sent);
  for (const [key, value] of Object.entries(partial)) {
    const wire = key === "operating_hours" ? "camel" : defs.find((def) => def.key === key)?.wire ?? "camel";
    if (wire !== "snake") body[camel(key)] = value;
    if (wire !== "camel") body[key] = value;
  }
  return body;
}

/** Thrown by the save when the club refused it as stale (409 `settings_changed`), with what is in force now. */
export class SettingsChanged extends Error {
  constructor(public readonly current: AdminSettings) {
    super("settings_changed");
  }
}

/**
 * What a stale save means for the page (A4-1): what somebody else changed, which of this admin's
 * edits still stand on top of it, and which of them clashed with theirs. `merged` is the working
 * copy to show — theirs, with every edit that did not clash carried over.
 */
export type SettingsConflict = {
  merged: AdminSettings;
  /** Keys somebody else saved since this page was read. */
  theirs: string[];
  /** This admin's edits carried onto theirs, still unsaved. */
  kept: string[];
  /** Keys both changed, to different values: theirs shows, and `mine` can put this admin's back. */
  clashed: string[];
  mine: AdminSettings;
  /** Every "their" change is the value this page was saving: an earlier press of ours landed. */
  ours: boolean;
};

function valueAt(settings: AdminSettings, key: string): unknown {
  const day = /^operating_hours_(.+)$/.exec(key)?.[1];
  return day ? settings.operating_hours?.[day as keyof NonNullable<AdminSettings["operating_hours"]>] : (settings as unknown as Held)[key];
}

export function conflictOf(base: AdminSettings, draft: AdminSettings, fresh: AdminSettings): SettingsConflict {
  const theirs = changedKeys(base, fresh);
  const { merged, carried, dropped } = carryEdits(base, draft, fresh);
  const clashed = dropped.filter((key) => !same(valueAt(fresh, key), valueAt(draft, key)));
  const ours = theirs.length > 0 && theirs.every((key) => same(valueAt(fresh, key), valueAt(draft, key)));
  return { merged, theirs, kept: carried, clashed, mine: draft, ours };
}

/** The working copy with this admin's values put back on the keys that clashed. */
export function reapplyMine(draft: AdminSettings, conflict: SettingsConflict): AdminSettings {
  const out = { ...(draft as unknown as Held) };
  const hours = { ...(draft.operating_hours ?? {}) } as Record<string, string | undefined>;
  let dayTouched = false;
  for (const key of conflict.clashed) {
    const day = /^operating_hours_(.+)$/.exec(key)?.[1];
    if (day) { hours[day] = valueAt(conflict.mine, key) as string | undefined; dayTouched = true; } else out[key] = valueAt(conflict.mine, key);
  }
  if (dayTouched) out.operating_hours = Object.fromEntries(Object.entries(hours).filter(([, v]) => v !== undefined));
  return out as unknown as AdminSettings;
}

/**
 * A refused save, in words. The shared device-error dictionary first (a code that HAS a sentence
 * gets it); then the refusal this page can name better than a token read aloud: a value outside
 * the server's bound, named by the field's own caption — the only bound the page knows for a
 * cooldown the server added.
 */
export function describeSaveFailure(err: unknown, currency: string): string {
  const said = describeDeviceError(err, SETTINGS_COPY.saveFailed);
  const code = err instanceof ApiError ? err.code : null;
  if (!code || said !== code.replace(/_/g, " ")) return said;
  const key = /^(.+)_out_of_range$/.exec(code)?.[1];
  if (!key || !settingDef(key)) return said;
  // The v3 refusal carries the range it applied (device-api §10): say it, so the admin can act.
  const min = (err as ApiError).detail("min");
  const max = (err as ApiError).detail("max");
  if (typeof min === "number" && typeof max === "number") {
    return `${settingLabel(key, currency)} has to be from ${min} to ${max}. Nothing was saved.`;
  }
  return `${settingLabel(key, currency)} is outside what the club’s system accepts. Nothing was saved.`;
}

/** Codes that say only "refused" — the banner replaces them with what to do. */
const GENERIC_REFUSALS = new Set(["validation_failed", "invalid_request", "bad_request"]);

/**
 * A failed save, as the page's banner says it (F3.15): the sentence, and the field to go to.
 * `transient` (F3-4): the club was not reached, or its answer was lost and the settings were
 * read again to find out — so the banner must not say "fix what is named".
 */
export type SaveFailure = { text: string; fieldKey: string | null; sessionEnded: boolean; transient?: boolean };

/** Thrown by the save when its reply was lost; carries what re-reading the club found. */
export class SaveNotConfirmed extends Error {
  constructor(public readonly found: "not_saved" | "unknown") {
    super(found);
  }
}

/** snake_case of a ProblemDetails `errors` key ("SliceMinutes" / "sliceMinutes" → "slice_minutes"). */
function snake(key: string): string {
  return key.replace(/^\$\.?/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Which setting a refusal is about, when it names one. */
function fieldOf(err: ApiError): string | null {
  const code = err.code ?? "";
  if (code === "operating_hours_day_invalid") {
    const day = err.detail("day");
    return typeof day === "string" ? `operating_hours_${day}` : null;
  }
  const named = /^(.+)_(?:out_of_range|invalid|not_whole_cents)$/.exec(code)?.[1];
  if (named && settingDef(named)) return named;
  const errors = typeof err.payload === "object" && err.payload !== null
    ? (err.payload as { errors?: Record<string, unknown> }).errors : undefined;
  const first = errors ? Object.keys(errors).map(snake).find((key) => settingDef(key)) : undefined;
  return first ?? null;
}

/**
 * The banner's words for a failed save. A 401 is a session that ended — the edits are kept for
 * the sign-in (see `settingsDraftStore`); a refusal that names no field says so instead of
 * printing "validation failed"; one that names a field offers a way to it.
 */
/**
 * The failures that name no field and ask for no fix: a lost reply (F3-4), an ended session, and
 * the club's rate limit (review round 3, A-12), which turns a save away before it is read — so
 * nothing was saved and nothing is wrong with a field. Null for a refusal.
 */
function notARefusal(err: unknown): SaveFailure | null {
  if (err instanceof SaveNotConfirmed) {
    const text = err.found === "not_saved" ? SETTINGS_COPY.saveDidNotArrive : SETTINGS_COPY.saveUnknown;
    return { text, fieldKey: null, sessionEnded: false, transient: true };
  }
  if (!(err instanceof ApiError)) return null;
  if (err.status === 401) return { text: SETTINGS_COPY.saveFailed, fieldKey: null, sessionEnded: true };
  if (err.status !== 429) return null;
  const seconds = Number(err.detail("retry_after_seconds")) || null;
  return { text: SETTINGS_COPY.saveRateLimited(rateLimitedSentence(seconds)), fieldKey: null, sessionEnded: false, transient: true };
}

export function saveFailureOf(err: unknown, currency: string): SaveFailure {
  const settled = notARefusal(err);
  if (settled) return settled;
  const fieldKey = err instanceof ApiError ? fieldOf(err) : null;
  const said = describeSaveFailure(err, currency);
  const code = err instanceof ApiError ? err.code : null;
  const raw = code !== null && said === code.replace(/_/g, " ");
  // Only a refusal that says NOTHING usable is replaced — no code, or the generic one. A token
  // like "day end before start" still names the problem better than any sentence here could.
  const unnamed = err instanceof ApiError && err.status === 400 && fieldKey === null
    && (code === null || (raw && GENERIC_REFUSALS.has(code)));
  return { text: unnamed ? SETTINGS_COPY.saveRefusedUnnamed : said, fieldKey, sessionEnded: false };
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
