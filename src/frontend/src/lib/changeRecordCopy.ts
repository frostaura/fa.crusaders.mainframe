import { settingDef } from "./settingsSchema";
import { clubCurrencySymbol } from "./currency";
import { isDeskReasonCode, percentOfBps, reasonLabel } from "./deskMinutesCopy";
import { formatMoney } from "./utils";
import { minutesSpoken } from "./minutes";
import { clubCalendarDate, clubDayAndClock } from "./clubClock";

/**
 * The change record's own words — review round 1, F3.2.
 *
 * <p>
 * The headline and the diff are composed on the SERVER from a closed dictionary; this module
 * only covers what the server's words leave raw. A settings change's diff names the stored key
 * (`penalty_pct`), which is the one name an admin never sees on the Settings page —
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
  const retired = LEGACY_LABEL[change.field];
  if (isSetting && retired) return retired;
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
 * booking UUIDs, a balance as "0.0 → 200.00", a collection whose balance pair and seat sat in
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
  balance_minutes: "Balance",
  /** R3 A-8: what the member may spend — the balance less shares held — the figure the confirm used. */
  spendable_minutes: "Can spend",
  /** R3 A-5: a webhook added or removed — where it sends (scheme and host only), what, and its name. */
  destination: "Sends to",
  event_filter: "Events",
  description: "Description",
  amount_minutes: "Amount",
  collected_minutes: "Collected",
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
  /** P13 §3.8: a group's say on club-package prices, "10% off packages" or "no say". */
  package_discount_bps: "Package discount",
  windows: "Booking times",
  added: "Added",
  removed: "Removed",
  range: "Period looked at",
  strands_returned: "What was shown",
  event_count: "Events shown",
  games: "Games",
  format: "Format",
  // R5 A5-2: a batch's own row — its bookings one per line, and its counts and totals.
  bookings: "Bookings",
  requested: "Bookings requested",
  succeeded: "Done",
  failed: "Not done",
  total_refunded_minutes: "Refunded in all",
  total_penalty_minutes: "Penalties in all",
  // P13 §3.5: a minutes package's before/after.
  price_zar: "Price",
  group: "Group",
  sort_order: "Place on the shelf",
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

/**
 * Keys only OLD rows carry (contract §2.5): the record is append-only and survives the P13 money
 * reset, so a row written before minutes still names the retired unit's keys. Each gets a caption
 * that says it is history; its figures are shown as the bare numbers they were, with no unit,
 * because the unit no longer exists. Every retired money key lives here and nowhere else.
 */
const LEGACY_LABEL: Record<string, string> = {
  balance_credits: "Balance (before minutes)",
  balance_before_credits: "Balance before (before minutes)",
  balance_after_credits: "Balance after (before minutes)",
  spendable_credits: "Can spend (before minutes)",
  amount_credits: "Amount (before minutes)",
  collected_credits: "Collected (before minutes)",
  total_refunded_credits: "Refunded in all (before minutes)",
  total_penalty_credits: "Penalties in all (before minutes)",
  credits_per_zar: "Top-up rate (retired)",
  flat_slice_price_credits: "Flat price per slot (retired)",
  slice_price_credits: "Price per slot (retired)",
  pricing_mode: "Price (retired)",
  multiplier_bps: "Price multiplier (retired)",
  // Settings P13 retired (§3.6, §3.9): bound and ignored now, but named by old settings rows.
  credits_per_zar_regular: "Top-up rate for members (retired)",
  credits_per_zar_league: "League top-up rate (retired)",
  topup_block_zar: "Top-up block (retired)",
  topup_max_zar_per_member: "Top-up cap per member (retired)",
};

/** Group pricing as it was (retired by P13; R4 A4-6: the record read "InheritCourt"). */
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
const STATE_FIELDS = new Set(["status", "balance_minutes", "balance_credits", "is_admin", "must_change_password"]);

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

/** A minutes package's row (P13 §3.5): its `minutes` is the amount sold, not a booking's length. */
function isPackageRow(row: { action?: string | null }): boolean {
  return (row.action ?? "").startsWith("package.");
}

/** A label for a field: the Settings caption, ours, the server's without its unit, or the key. */
function labelFor(row: { area?: string | null; action?: string | null }, change: RawChange): string {
  if (isSettingsDiff(row)) return changeFieldLabel(row, change);
  if (isPackageRow(row) && change.field === "minutes") return "Minutes";
  const known = FIELD_LABEL[change.field] ?? LEGACY_LABEL[change.field];
  if (known) return known;
  // The server's label without its unit word ("Max minutes" stays: there the unit is the point).
  const server = change.label?.replace(/\s+zar$/i, "").trim();
  return server || inWords(change.field);
}

/**
 * A stored amount of minutes, however the server printed it: "300", "-45", "300 minutes",
 * "1 minute" (`AdminChangeDiff.Number` words a `*_minutes` field) — and "100.00" from a fixture
 * or a row written mid-migration. Whole minutes, truncated toward zero.
 */
const MINUTES_TEXT = /^([-−]?\d+)(?:\.\d+)?(?:\s+minutes?)?$/;

/** "300 minutes" → 300; null for anything that is not an amount of minutes. */
export function minutesIn(value: string): number | null {
  const m = MINUTES_TEXT.exec(value.trim());
  return m ? Number(m[1].replace("−", "-")) : null;
}

function money(field: string, value: string): string | null {
  if (value.trim() === "") return null;
  if (field.endsWith("_minutes")) {
    const minutes = minutesIn(value);
    return minutes === null ? null : minutesSpoken(minutes);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // `topup_max_zar_per_member` (retired) was rand too, with its unit mid-key.
  if (field.endsWith("_zar") || field.startsWith("zar_") || field.includes("_zar_per_")) return formatMoney(n);
  // An old row's figure in the retired unit: the number as it was, without a unit (§2.5).
  if (field in LEGACY_LABEL) return Number.isInteger(n) ? String(n) : n.toFixed(2);
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

/** "1000" → "10% off packages", "1250" → "12.5% off packages" (P13 §3.8: a group's package discount). */
function discountInWords(token: string): string | null {
  const n = Number(token);
  if (token === "" || !Number.isFinite(n)) return null;
  return `${percentOfBps(n)} off packages`;
}

/** One basis point: 10000 bps is ×1.00. */
const BPS = 0.0001;

/** "10000" → "×1.00 the court’s price" (R4 A4-6: the record read "Multiplier bps 10000"). */
function multiplierInWords(token: string): string | null {
  const n = Number(token);
  if (token === "" || !Number.isFinite(n)) return null;
  return "×" + (n * BPS).toFixed(2) + " the court’s price";
}

/** An old row's group rate, "1.6" → "1.6 per R1" — a rate, never money ("R1.60", R5 A5-3). Retired by P13. */
function rateInWords(token: string): string | null {
  const n = Number(token);
  if (token === "" || !Number.isFinite(n)) return null;
  return `${Number(n.toFixed(2))} per ${clubCurrencySymbol()}1`;
}

/** What happened to one item of a batch (R5 A5-2), as the line ends it. */
const BATCH_ITEM_WORDS: Record<string, string> = {
  cancelled: "cancelled",
  block_lifted: "hold lifted",
  already_cancelled: "already cancelled",
  booked: "booked",
};

type BatchItem = {
  member_name?: string | null; block_label?: string | null; court?: number | null; starts_at?: string | null;
  status?: string | null; error?: string | null; refund_minutes?: number | null; penalty_minutes?: number | null;
  amount_minutes?: number | null;
};

/** "Court 2, Sat 3 Oct, 18:00". */
function batchItemWhere(item: BatchItem, timezone?: string): string {
  const when = typeof item.starts_at === "string" && Number.isFinite(Date.parse(item.starts_at))
    ? clubDayAndClock(item.starts_at, timezone) : null;
  return [item.court != null ? `Court ${item.court}` : null, when].filter(Boolean).join(", ");
}

/** "cancelled", "hold lifted", "not booked (Slot taken)". A bulk book's items carry an amount. */
function batchItemOutcome(item: BatchItem): string {
  const status = item.status ?? "";
  if (status === "refused" || status === "failed") {
    const verb = item.amount_minutes !== undefined ? "not booked" : "not cancelled";
    return item.error ? `${verb} (${inWords(item.error)})` : verb;
  }
  return BATCH_ITEM_WORDS[status] ?? (status ? inWords(status).toLowerCase() : "");
}

/** "50 min back", "15 min penalty", or a booked item's price. */
function batchItemMoney(item: BatchItem): string[] {
  const money: string[] = [];
  if (item.status === "booked" && item.amount_minutes) money.push(minutesSpoken(item.amount_minutes));
  if (item.refund_minutes) money.push(`${minutesSpoken(item.refund_minutes)} back`);
  if (item.penalty_minutes) money.push(`${minutesSpoken(item.penalty_minutes)} penalty`);
  return money;
}

/** "Olga Smith — Court 2, Sat 3 Oct, 18:00 — cancelled, 50 min back". */
function batchItemInWords(item: BatchItem, timezone?: string): string {
  const who = item.member_name ?? (item.block_label ? `${item.block_label} (club hold)` : null);
  const end = [batchItemOutcome(item), ...batchItemMoney(item)].filter(Boolean).join(", ");
  return [who, batchItemWhere(item, timezone), end].filter(Boolean).join(" — ");
}

/** A batch's `bookings` — the server's JSON text of one object per item — one line each. */
function batchInWords(token: string, timezone?: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(token.startsWith("[") ? token : `[${token}]`);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const items = parsed.filter((x): x is BatchItem => typeof x === "object" && x !== null);
  return items.length > 0 ? items.map((item) => batchItemInWords(item, timezone)).join("\n") : null;
}

/** The fields whose values have their own words (R4 A4-6); undefined for every other field. */
function fieldInWords(field: string, token: string, timezone?: string): string | null | undefined {
  switch (field) {
    case "bookings": return batchInWords(token, timezone);
    case "package_discount_bps": return discountInWords(token);
    case "credits_per_zar":
    case "credits_per_zar_regular":
    case "credits_per_zar_league": return rateInWords(token);
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
  const own = fieldInWords(field, token, timezone);
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
  if (field === "reason_code" && isDeskReasonCode(token)) return reasonLabel(token);
  const state = STATE_WORDS[token.toLowerCase()];
  if (state && (field === "status" || field.endsWith("_status"))) return state;
  // A bare snake_case token is a code, not a sentence: say it in words ("best_of_5" too).
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(token)) return inWords(token);
  return null;
}

type Row = { area?: string | null; action?: string | null; changes?: RawChange[] | null };

/**
 * A group field whose EMPTY value is itself a setting (R5 A5-3): a peak say or a package discount
 * cleared is "no say" (an old row's rate cleared was the club's). On an edit the empty side is said, so the row reads as the change
 * it was ("yes → no say") — a one-sided value was listed as a fact ("Peak priority — yes"), which
 * reads as the change being TO yes.
 */
const GROUP_EMPTY_WORDS: Record<string, string> = {
  peak_priority: "no say",
  package_discount_bps: "no say",
  credits_per_zar: "the club's rate",
};

function clearedGroupValue(row: Row, field: string): string | null {
  return row.action === "group.updated" ? GROUP_EMPTY_WORDS[field] ?? null : null;
}

/** A collection or adjustment stores its balance as two AFTER fields; they are one change. */
function balancePair(byField: Map<string, RawChange>): ChangeLine | null {
  const before = byField.get("balance_before_minutes");
  const after = byField.get("balance_after_minutes");
  if (!before && !after) return null;
  return {
    field: "balance_minutes",
    label: FIELD_LABEL.balance_minutes,
    before: changeValueInWords("balance_minutes", before?.after ?? before?.before),
    after: changeValueInWords("balance_minutes", after?.after ?? after?.before),
  };
}

const BALANCE_HALVES = new Set(["balance_before_minutes", "balance_after_minutes"]);

/** One stored change as a line, a fact, or nothing (an id, a balance half, an emptied value, a repeated total). */
function presentOne(
  row: Row, c: RawChange, byField: Map<string, RawChange>, timezone?: string,
): { line: ChangeLine } | { fact: ChangeFact } | null {
  if (BALANCE_HALVES.has(c.field)) return null;
  if (c.field === "total" && repeatsACount(c, byField)) return null;
  const label = labelFor(row, c);
  // A package's `minutes` is an amount ("5 h"), read like every other `*_minutes` figure.
  const valueField = isPackageRow(row) && c.field === "minutes" ? "package_minutes" : c.field;
  let was = changeValueInWords(valueField, c.before, timezone);
  let is = changeValueInWords(valueField, c.after, timezone);
  if (was === null && is === null) return null;
  const cleared = clearedGroupValue(row, c.field);
  if (cleared !== null) {
    was ??= cleared;
    is ??= cleared;
  }
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
