import { ApiError, api, fetchWithTimeout, tokenStore } from "./api";
import type { MemberGroupChip, MemberTariff } from "./adminApi";

/**
 * The member-detail wire (R17, R20, D9) — one person, as the admin console reads them.
 *
 * <p>
 * <b>Every route here takes the USER id.</b> The older lifecycle routes (approve, suspend,
 * reactivate, reset password) take the MEMBERSHIP id and live in `lib/api.ts`; these take the
 * user id because an account can hold admin rights with no membership row at all, and a detail
 * screen that 404s for the club's own bootstrap admin lies about who runs the club. The detail
 * carries both ids, so a screen never has to translate.
 * </p>
 *
 * <p>
 * <b>Responses are snake_case, requests are camelCase</b> — this repo's standing convention
 * (`lib/adminApi.ts` header). The admin-role body is the exception the server accepts both ways
 * for `confirm_self`; it is sent snake_case, the spelling the contract names.
 * </p>
 */

/** Query string from the fields that are actually set. `?` only when there is something to say. */
function qs(o: Record<string, string | number | boolean | undefined | null>): string {
  const parts = Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/* ─────────────────────────────── shapes ─────────────────────────────── */

/** The MEMBERSHIP's status, exactly as the members list spells it; null with no membership row. */
export type MembershipStatus = "PendingApproval" | "Active" | "Rejected" | "Suspended";

/**
 * Where a person's admin rights come from. `config` is an address in the server's own
 * `Admins:Emails` — the console cannot revoke it, only an operator can.
 */
export type AdminSource = "config" | "granted";

/** R6 E6-6: `refunded_outage` is a no-show refunded in full because no box was reachable — not a no-show. */
export type BookingRowStatus = "booked" | "cancelled" | "noshow" | "completed" | "refunded_outage";

/** One booking as every member-detail surface prints it (next bookings and each bookings page). */
export type MemberBookingRow = {
  booking_id: string;
  court_id: string;
  court_name: string | null;
  starts_at: string;
  ends_at: string;
  /** R6 E6-10: the end it was sold to — `ends_at` is cut short by the no-show sweep. Absent from an older API: read `ends_at`. */
  sold_ends_at?: string;
  status: BookingRowStatus;
  charged_minutes: number;
  /** R6 E6-10: what this member is out on it, net of refunds, penalties and shares. Absent: read `charged_minutes`. */
  cost_minutes?: number;
  checked_in_at: string | null;
  cancelled_at: string | null;
  /**
   * Who pressed the button. `is_self` is the only inference the server makes: whether the
   * actor was an ADMIN is not claimed here (D2-B41), so the screen never says it either.
   */
  booked_by: { user_id: string | null; name: string | null; is_self: boolean };
  /**
   * C6 (review round 2, F3-8): `partner` for an accepted seat on somebody else's game — the desk's
   * record listed only the courts a member booked, so a weekly partner read as never playing.
   * Absent from an older API: read as `organiser`.
   */
  role?: "organiser" | "partner" | "payer";
  /** C6: whose booking it is. On an organiser row, the member themselves (`is_self`). */
  organiser?: { user_id: string | null; name: string | null; is_self: boolean } | null;
};

export type FingerprintEnrolment = { template_id: string; finger_label: string | null; enrolled_at: string };

export type MemberDetail = {
  user_id: string;
  membership_id: string | null;
  full_name: string | null;
  email: string;
  membership_number: string | null;
  status: MembershipStatus | null;
  account_status: string;
  /** Why the application was turned down, when it was (F3.10). Absent from an API that predates it. */
  rejection_reason?: string | null;
  /** Who approved or turned down the application, and when; null while nobody has. */
  review?: { reviewed_at: string; reviewed_by_user_id: string | null; reviewed_by_name: string | null } | null;
  email_verified: boolean;
  created_at: string;
  last_login_at: string | null;
  photo_url: string | null;
  is_admin: boolean;
  admin_source: AdminSource | null;
  /** D2: the member's active groups, in the club's order. */
  groups: MemberGroupChip[];
  /** D2: the top-up rate and peak standing those groups resolve to. Absent from an API that predates it. */
  tariff?: MemberTariff;
  balance_minutes: number;
  /**
   * D9 — what of the balance is held for partners (D11 §3a) and owed back to them (P11), as the
   * member's own wallet says it. Optional: an API that does not send them shows the balance alone.
   */
  held_minutes?: number;
  held_until?: string | null;
  /** The held credit per share deadline, soonest first, summing to `held_minutes`. */
  held_parts?: { minutes: number; until: string }[];
  owed_back_minutes?: number;
  passkey_count: number;
  fingerprints: { count: number; enrolments: FingerprintEnrolment[] };
  next_bookings: MemberBookingRow[];
  counts_30d: { bookings: number; no_shows: number; sessions_played: number };
};

export type BookingsWhen = "upcoming" | "past";

export type MemberBookingsPage = { when: BookingsWhen; items: MemberBookingRow[]; next_cursor: string | null };

/** One door scan by this member. `door` survives the board being deleted — every field nullable. */
export type MemberDoorRow = {
  at: string;
  delivered_at: string | null;
  /** The instant came from a board's own clock after an outage, so it may be minutes out. */
  time_uncertain: boolean;
  action: string;
  outcome: "released" | "refused";
  reason: string | null;
  /** The server's sentence for the outcome — rendered, never composed here from `reason`. */
  reason_text: string;
  offline: boolean;
  method: string | null;
  fingerprint: string | null;
  door: { id: string | null; name: string | null; gate_key: string | null; device_code?: string | null; removed: boolean };
};

export type MemberDoorsPage = {
  member: { user_id: string; name: string | null };
  items: MemberDoorRow[];
  next_cursor: string | null;
  total: number;
  range: { from: string; to: string };
  timezone: string;
  retention_days: number;
};

/** The club door log's own filter grammar (period · day · from/to are mutually exclusive). */
export type MemberDoorFilters = {
  period?: string;
  day?: string;
  from?: string;
  to?: string;
  door?: string;
  outcome?: "released" | "refused" | "offline" | "";
  reason?: string;
  cursor?: string;
  limit?: number;
};

export type AdminRoleResult = {
  user_id: string;
  is_admin: boolean;
  admin_source: AdminSource | null;
  changed: boolean;
};

/* ─────────────────────────────── files ─────────────────────────────── */

export type CsvFile = { blob: Blob; filename: string };

/**
 * A CSV fetched WITH the session's bearer token.
 *
 * <p>
 * A bare `<a href download>` navigates with no Authorization header, so the API cannot even
 * resolve a tenant and answers `400 tenant_unresolved` as JSON — the download starts, cancels
 * itself, and the page looks the same before and after. The wallet CSV and the door log both
 * shipped that once; every audited export here is fetched instead.
 * </p>
 */
async function fetchCsv(path: string, fallbackName: string): Promise<CsvFile> {
  const token = tokenStore.get();
  const res = await fetchWithTimeout(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const text = await res.text();
    let payload: unknown = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    throw new ApiError(res.status, payload);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="?([^"]+)"?/.exec(disposition);
  return { blob: await res.blob(), filename: match?.[1] ?? fallbackName };
}

/** Hands a fetched file to the browser's own save. */
export function saveFile({ blob, filename }: CsvFile): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/* ─────────────────────────────── the calls ─────────────────────────────── */

const base = (userId: string) => `/api/v1/admin/members/${encodeURIComponent(userId)}`;

export const memberDetailEndpoints = {
  /** Everything an admin needs on one screen about one person. Unaudited — it carries no door rows. */
  detail: (userId: string) => api.get<MemberDetail>(base(userId)),

  /** Upcoming soonest first; past most recent first. Every status, cancelled included. */
  bookings: (userId: string, page: { when: BookingsWhen; cursor?: string | null; limit?: number }) =>
    api.get<MemberBookingsPage>(`${base(userId)}/bookings${qs({ when: page.when, cursor: page.cursor, limit: page.limit })}`),

  /**
   * D9 — this member's door history. <b>Every successful read writes a change-record line</b>
   * naming who looked and at whom; the page says so before anything is read.
   */
  doors: (userId: string, filters: MemberDoorFilters = {}) =>
    api.get<MemberDoorsPage>(`${base(userId)}/doors${doorQuery(filters)}`),
  doorsCsvUrl: (userId: string, filters: MemberDoorFilters = {}) => `${base(userId)}/doors.csv${doorQuery(filters)}`,
  doorsCsv: (userId: string, filters: MemberDoorFilters = {}) =>
    fetchCsv(memberDetailEndpoints.doorsCsvUrl(userId, filters), "member-doors.csv"),

  /** The night trace's CSV, fetched with the token for the reason {@link fetchCsv} gives. */
  nightCsv: (userId: string, range: { day?: string }) =>
    fetchCsv(`${base(userId)}/trace.csv${qs({ day: range.day })}`, "member-night.csv"),

  /**
   * R20 — grant or revoke admin rights. `reason` is required both ways (review round 1, B10 —
   * the server answers 400 `reason_required` without it); `confirmSelf` is the
   * second yes an admin gives before removing their OWN rights.
   */
  setAdmin: (userId: string, body: { grant: boolean; reason?: string; confirmSelf?: boolean }) =>
    api.post<AdminRoleResult>(`${base(userId)}/admin`, {
      grant: body.grant,
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.confirmSelf ? { confirm_self: true } : {}),
    }),
};

function doorQuery(f: MemberDoorFilters): string {
  // `period` / `day` / from-to are mutually exclusive at the API (400 `range_conflict`), so the
  // page sends exactly one and this builder never merges them quietly.
  return qs({
    period: f.period, day: f.day, from: f.from, to: f.to,
    door: f.door, outcome: f.outcome, reason: f.reason,
    cursor: f.cursor, limit: f.limit,
  });
}
