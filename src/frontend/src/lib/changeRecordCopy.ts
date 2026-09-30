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
  occurrences_cancelled: "Dates cancelled",
  courts: "Courts",
  name: "Name",
  label: "Label on the grid",
  part_of_batch: "Part of a batch",
  self: "Their own booking",
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

/** One stored value in the words a volunteer uses. */
export function changeValueInWords(field: string, value: string | null | undefined, timezone?: string): string | null {
  if (value === null || value === undefined) return null;
  const formatted = money(field, value);
  if (formatted) return formatted;
  const token = value.trim();
  const when = whenOrCount(field, token, timezone) ?? eventsInWords(field, token);
  if (when) return when;
  if (field === "reason_code" && (ADJUST_REASON_CODES as readonly string[]).includes(token)) {
    return reasonLabel(token as AdjustReasonCode);
  }
  const state = STATE_WORDS[token.toLowerCase()];
  if (state && (field === "status" || field.endsWith("_status"))) return state;
  // A bare snake_case token is a code, not a sentence: say it in words.
  if (/^[a-z]+(_[a-z]+)+$/.test(token)) return inWords(token);
  return value;
}

/** The server's diff, as the page shows it: what changed, then the facts around it. */
export function presentChanges(
  row: { area?: string | null; action?: string | null; changes?: RawChange[] | null },
  timezone?: string,
): PresentedChanges {
  const raw = (row.changes ?? []).filter((c) => !isIdField(c.field, c));
  const byField = new Map(raw.map((c) => [c.field, c]));
  const changed: ChangeLine[] = [];
  const facts: ChangeFact[] = [];

  // A collection or adjustment stores its balance as two AFTER fields; they are one change.
  const before = byField.get("balance_before_credits");
  const after = byField.get("balance_after_credits");
  if (before || after) {
    changed.push({
      field: "balance_credits",
      label: FIELD_LABEL.balance_credits,
      before: changeValueInWords("balance_credits", before?.after ?? before?.before),
      after: changeValueInWords("balance_credits", after?.after ?? after?.before),
    });
  }

  for (const c of raw) {
    if (c.field === "balance_before_credits" || c.field === "balance_after_credits") continue;
    const label = labelFor(row, c);
    const was = changeValueInWords(c.field, c.before, timezone);
    const is = changeValueInWords(c.field, c.after, timezone);
    const oneSided = (was === null) !== (is === null);
    if (oneSided && !STATE_FIELDS.has(c.field) && !isSettingsDiff(row)) {
      facts.push({ field: c.field, label, value: (is ?? was)! });
    } else {
      changed.push({ field: c.field, label, before: was, after: is });
    }
  }
  return { changed, facts };
}

/** Whether a row has anything to show once ids are hidden. */
export function hasChangeDiff(row: { area?: string | null; action?: string | null; changes?: RawChange[] | null }): boolean {
  const { changed, facts } = presentChanges(row);
  return changed.length + facts.length > 0;
}
