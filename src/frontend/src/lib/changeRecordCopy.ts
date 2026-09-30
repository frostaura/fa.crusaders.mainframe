import { settingDef } from "./settingsSchema";
import { clubCurrencySymbol } from "./currency";
import { ADJUST_REASON_CODES, type AdjustReasonCode } from "./adminApi";
import { reasonLabel } from "./topUpCopy";
import { formatCredits, formatMoney } from "./utils";
import { clubCalendarDate, clubDayAndClock } from "./clubClock";

/**
 * The change record's own words — review round 1, F3.2.
 *
 * <p>
 * The headline and the diff are composed on the SERVER from a closed dictionary; this module
 * only covers what the server's words leave raw. A settings change's diff names the stored key
 * (`credits_per_zar_regular`), which is the one name an admin never sees on the Settings page —
 * so a setting is labelled with the Settings page's own caption, and anything else falls back to
 * the server's label, then to the key in words.
 * </p>
 */
export const CHANGES_PAGE = {
  showing: (shown: number, total: number) => `Showing ${shown} of ${total}.`,
  loadMore: "Load more",
  loadMoreAction: "read more of the change record",
} as const;

/** A key in words: "member_code.reset" → "Member code reset". */
export function inWords(key: string): string {
  const words = key.replace(/[._]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/** The headline, or — for an action the server has no sentence for yet — the action in words. */
export function changeHeadline(row: { headline?: string | null; action?: string | null }): string {
  return row.headline || inWords(row.action ?? "");
}

/** A diff row's caption: the Settings page's own label for a setting, else the server's label. */
export function changeFieldLabel(
  row: { area?: string | null; action?: string | null },
  change: { field: string; label?: string | null },
): string {
  const isSetting = row.area === "setting" || (row.action ?? "").startsWith("settings.");
  const def = isSetting ? settingDef(change.field) : undefined;
  if (def) return def.label.replaceAll("{currency}", clubCurrencySymbol());
  return change.label || inWords(change.field);
}

// ---------------------------------------------------------------------------------------
// "Show what changed", in words — review round 2, F3-7
// ---------------------------------------------------------------------------------------

/**
 * The server renders a diff from whatever the writer stored, and the writers store keys and
 * tokens: the reviewer read `pending_approval`, `top_up_cash`, "Zar received 125.5", entry and
 * booking UUIDs, "Balance credits 0.0 → 200.00", a collection whose balance pair and seat sat in
 * the wrong columns, and schedule keys (`end_minute`, `days_of_week`). This layer is the last
 * step before the page: labels a volunteer uses, money formatted as money, ids hidden, the
 * balance pair joined into one row, and facts that are not a before → after (a seat, the amount
 * collected) listed as facts rather than as something that was "removed".
 */
export type ChangeLine = { field: string; label: string; before: string | null; after: string | null };
export type ChangeFact = { field: string; label: string; value: string };
export type PresentedChanges = { changed: ChangeLine[]; facts: ChangeFact[] };

type RawChange = { field: string; label?: string | null; before?: string | null; after?: string | null };

const FIELD_LABEL: Record<string, string> = {
  status: "Status",
  balance_credits: "Balance",
  /** R3 A-8: what the member may spend — the balance less shares held — the figure the confirm used. */
  spendable_credits: "Can spend",
  /** R3 A-5: a webhook added or removed — where it sends (scheme and host only), what, and its name. */
  destination: "Sends to",
  event_filter: "Events",
  description: "Description",
  amount_credits: "Amount",
  collected_credits: "Collected",
  reason_code: "Reason",
  zar_received: "Money received",
  is_admin: "Admin rights",
  must_change_password: "Must choose a new password",
  passkeys_removed: "Passkeys removed",
  seat: "Seat",
  court: "Court",
  starts_at: "Starts",
  minutes: "Length",
  days_of_week: "Days",
  start_minute: "Starts",
  end_minute: "Ends",
  start_date: "First date",
  end_date: "Last date",
  interval_weeks: "Repeats",
  occurrence_date: "Date",
  /** R4 A4-3: a "from this date on" change says from when. */
  effective_from: "Takes effect from",
  occurrences_cancelled: "Dates cancelled",
  courts: "Courts",
  name: "Name",
  label: "Label on the grid",
  part_of_batch: "Part of a batch",
  self: "Their own booking",
  // R4 A4-6: group snapshots and the privacy-view rows, in a volunteer's words.
  pricing_mode: "Price",
  multiplier_bps: "Price multiplier",
  windows: "Booking times",
  added: "Added",
  removed: "Removed",
  range: "Period looked at",
  strands_returned: "What was shown",
  event_count: "Events shown",
  games: "Games",
  format: "Format",
};

/** Membership and result states as the Members page says them. */
const STATE_WORDS: Record<string, string> = {
  pending_approval: "Awaiting approval",
  pendingapproval: "Awaiting approval",
  active: "Active",
  rejected: "Turned down",
  suspended: "Suspended",
  pending: "Waiting to be confirmed",
  confirmed: "Confirmed",
  disputed: "Disputed",
  withdrawn: "Withdrawn",
  // R4 A4-6: bookings, seats and groups.
  booked: "Booked",
  cancelled: "Cancelled",
  invited: "Invited",
  accepted: "Playing",
  declined: "Turned it down",
  removed: "Taken off the booking",
  archived: "Archived",
  voided: "Voided",
};

/** Group pricing, as the Groups screen says it (R4 A4-6: the record read "InheritCourt"). */
const PRICING_WORDS: Record<string, string> = {
  inheritcourt: "The court’s own price",
  inherit_court: "The court’s own price",
  multiplier: "A multiple of the court’s price",
  flatperslice: "A flat price per slot",
  flat_per_slice: "A flat price per slot",
};

/** A trace's strands (R4 A4-6: "Strands returned: other"). */
const STRAND_WORDS: Record<string, string> = {
  booking: "Bookings", bookings: "Bookings", door: "Door scans", doors: "Door scans",
  wallet: "Money", ledger: "Money", court: "Courts", account: "Account", other: "Other activity",
};

const DAY_WORD: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Fields that are the subject's own state; anything else on one side only is a fact. */
const STATE_FIELDS = new Set(["status", "balance_credits", "is_admin", "must_change_password"]);

function isIdField(field: string, change: RawChange): boolean {
  if (field === "id" || field.endsWith("_id") || field.endsWith("_ids")) return true;
  const values = [change.before, change.after].filter((v): v is string => typeof v === "string");
  return values.length > 0 && values.every((v) => UUID.test(v.trim()));
}

/**
 * A settings change — the page's own keys. A webhook row is filed under the setting area too
 * (R3 A-5) but carries its own facts (destination, events), which are not settings keys.
 */
function isSettingsDiff(row: { area?: string | null; action?: string | null }): boolean {
  const action = row.action ?? "";
  if (action.startsWith("webhook.")) return false;
  return row.area === "setting" || action.startsWith("settings.");
}

/** A label for a field: the Settings caption, ours, the server's without its unit, or the key. */
function labelFor(row: { area?: string | null; action?: string | null }, change: RawChange): string {
  if (isSettingsDiff(row)) return changeFieldLabel(row, change);
  const known = FIELD_LABEL[change.field];
  if (known) return known;
  // A group's top-up rate: the server's "Credits per zar" lost its unit to the strip below (R4 A4-6).
  if (change.field === "credits_per_zar") return `Credits per ${clubCurrencySymbol()}1`;
  const server = change.label?.replace(/\s+(credits|zar)$/i, "").trim();
  return server || inWords(change.field);
}

function money(field: string, value: string): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || value.trim() === "") return null;
  if (field.endsWith("_credits")) return formatCredits(n);
  if (field.endsWith("_zar") || field.startsWith("zar_")) return formatMoney(n);
  return null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Times, dates and counts in words (review round 3, A-7): the record read "Starts
 * 2026-09-30T16:00:00+00:00", "First date 2026-09-30", "Length 15" and "Every 1". An instant is
 * said in the CLUB's day and clock, a calendar date as the club's short date, a length in minutes
 * and a repeat as "Every week".
 */
function whenOrCount(field: string, token: string, timezone?: string): string | null {
  if (ISO_INSTANT.test(token) && Number.isFinite(Date.parse(token))) return clubDayAndClock(token, timezone);
  if (ISO_DATE.test(token)) return clubCalendarDate(token, { weekday: true });
  const n = /^\d+$/.test(token) ? Number(token) : null;
  if (n === null) return null;
  if (field === "minutes") return n === 1 ? "1 minute" : `${n} minutes`;
  if (field === "interval_weeks") return n === 1 ? "Every week" : `Every ${n} weeks`;
  return null;
}

/** A webhook's event filter: "*" is every event (R3 A-5). */
function eventsInWords(field: string, token: string): string | null {
  return field === "event_filter" && token === "*" ? "Every event" : null;
}

/**
 * The server renders a stored object or list as its JSON text (R4 A4-6): a member list read
 * `{"name": "Thandi", "user_id": "…"}`, a trace's period `{"to": "2026-09-29T22:00:00+00:00", …}`
 * and a result's games `{"a": 11, "b": 9}, …`. Parsed and said: names, a period, scores.
 */
function jsonInWords(token: string, timezone?: string): string | null {
  if (!token.startsWith("{") && !token.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(token.startsWith("[") ? token : `[${token}]`);
  } catch {
    return null;
  }
  const items = (Array.isArray(parsed) ? parsed : [parsed]).filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
  if (items.length === 0) return null;
  const said = items.map((item) => objectInWords(item, timezone)).filter((x): x is string => x !== null);
  return said.length > 0 ? said.join(", ") : null;
}

function objectInWords(item: Record<string, unknown>, timezone?: string): string | null {
  if (typeof item.name === "string") return item.name;
  if (typeof item.from === "string" || typeof item.to === "string") {
    const end = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? clubDayAndClock(v, timezone) : null);
    const from = end(item.from);
    const to = end(item.to);
    if (from && to) return `${from} to ${to}`;
    return from ? `From ${from}` : to ? `Until ${to}` : null;
  }
  if (typeof item.a === "number" && typeof item.b === "number") return `${item.a}–${item.b}`;
  return null;
}

/** "tue 18:00-21:00, thu 18:00-21:00" → "Tue 18:00–21:00, Thu 18:00–21:00"; none → "No set times". */
function windowsInWords(token: string): string {
  if (token === "") return "No set times";
  return token.replace(/\b(mon|tue|wed|thu|fri|sat|sun)\b/g, (d) => DAY_WORD[d]).replace(/(\d{2}:\d{2})-(\d{2}:\d{2})/g, "$1–$2");
}

/** One basis point: 10000 bps is ×1.00. */
const BPS = 0.0001;

/** "10000" → "×1.00 the court’s price" (R4 A4-6: the record read "Multiplier bps 10000"). */
function multiplierInWords(token: string): string | null {
  const n = Number(token);
  if (token === "" || !Number.isFinite(n)) return null;
  return "×" + (n * BPS).toFixed(2) + " the court’s price";
}

/** The fields whose values have their own words (R4 A4-6); undefined for every other field. */
function fieldInWords(field: string, token: string): string | null | undefined {
  switch (field) {
    case "windows": return windowsInWords(token);
    case "pricing_mode": return PRICING_WORDS[token.toLowerCase()] ?? inWords(token);
    case "multiplier_bps": return multiplierInWords(token);
    case "strands_returned":
      return token.split(",").map((t) => t.trim()).filter(Boolean)
        .map((t) => STRAND_WORDS[t.toLowerCase()] ?? inWords(t)).join(", ") || null;
    case "event_filter":
      return token.split(",").map((t) => t.trim()).filter(Boolean)
        .map((t) => (t === "*" ? "Every event" : inWords(t))).join(", ") || null;
    default: return undefined;
  }
}

/** One stored value in the words a volunteer uses. */
export function changeValueInWords(field: string, value: string | null | undefined, timezone?: string): string | null {
  if (value === null || value === undefined) return null;
  const token = value.trim();
  // An emptied list or text is no value — except where "none" is itself the fact (times).
  if (token === "" && field !== "windows") return null;
  const own = fieldInWords(field, token);
  if (own !== undefined) return own;
  // The first reading that recognises the value, in this order; the value itself when none does.
  const readings = [
    jsonInWords(token, timezone), money(field, value), whenOrCount(field, token, timezone),
    eventsInWords(field, token), codeInWords(field, token),
  ];
  return readings.find((said) => said !== null) ?? value;
}

/** A reason code, a state token or a bare snake_case code, in words; null for anything else. */
function codeInWords(field: string, token: string): string | null {
  if (field === "reason_code" && (ADJUST_REASON_CODES as readonly string[]).includes(token)) {
    return reasonLabel(token as AdjustReasonCode);
  }
  const state = STATE_WORDS[token.toLowerCase()];
  if (state && (field === "status" || field.endsWith("_status"))) return state;
  // A bare snake_case token is a code, not a sentence: say it in words ("best_of_5" too).
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(token)) return inWords(token);
  return null;
}

type Row = { area?: string | null; action?: string | null; changes?: RawChange[] | null };

/** A collection or adjustment stores its balance as two AFTER fields; they are one change. */
function balancePair(byField: Map<string, RawChange>): ChangeLine | null {
  const before = byField.get("balance_before_credits");
  const after = byField.get("balance_after_credits");
  if (!before && !after) return null;
  return {
    field: "balance_credits",
    label: FIELD_LABEL.balance_credits,
    before: changeValueInWords("balance_credits", before?.after ?? before?.before),
    after: changeValueInWords("balance_credits", after?.after ?? after?.before),
  };
}

const BALANCE_HALVES = new Set(["balance_before_credits", "balance_after_credits"]);

/** One stored change as a line, a fact, or nothing (an id, a balance half, an emptied value, a repeated total). */
function presentOne(
  row: Row, c: RawChange, byField: Map<string, RawChange>, timezone?: string,
): { line: ChangeLine } | { fact: ChangeFact } | null {
  if (BALANCE_HALVES.has(c.field)) return null;
  if (c.field === "total" && repeatsACount(c, byField)) return null;
  const label = labelFor(row, c);
  const was = changeValueInWords(c.field, c.before, timezone);
  const is = changeValueInWords(c.field, c.after, timezone);
  if (was === null && is === null) return null;
  const oneSided = (was === null) !== (is === null);
  if (oneSided && !STATE_FIELDS.has(c.field) && !isSettingsDiff(row)) return { fact: { field: c.field, label, value: (is ?? was)! } };
  return { line: { field: c.field, label, before: was, after: is } };
}

/** The server's diff, as the page shows it: what changed, then the facts around it. */
export function presentChanges(row: Row, timezone?: string): PresentedChanges {
  const raw = (row.changes ?? []).filter((c) => !isIdField(c.field, c));
  const byField = new Map(raw.map((c) => [c.field, c]));
  const balance = balancePair(byField);
  const changed: ChangeLine[] = balance ? [balance] : [];
  const facts: ChangeFact[] = [];
  for (const c of raw) {
    const shown = presentOne(row, c, byField, timezone);
    if (shown && "line" in shown) changed.push(shown.line);
    else if (shown) facts.push(shown.fact);
  }
  return { changed, facts };
}

/**
 * A privacy row's `total` beside the count it shows (R4 A4-6: "Total" repeated "Events"): the
 * same figure twice reads as two different facts. Said once when they agree.
 */
function repeatsACount(total: RawChange, byField: Map<string, RawChange>): boolean {
  const value = (c: RawChange | undefined) => (c ? (c.after ?? c.before ?? null) : null);
  const shown = value(byField.get("event_count")) ?? value(byField.get("rows"));
  return shown !== null && shown === value(total);
}

/** Whether a row has anything to show once ids are hidden. */
export function hasChangeDiff(row: { area?: string | null; action?: string | null; changes?: RawChange[] | null }): boolean {
  const { changed, facts } = presentChanges(row);
  return changed.length + facts.length > 0;
}
