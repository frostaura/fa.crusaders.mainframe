/**
 * Typed API client. Reads/writes the access token from localStorage so refresh-survives-reload.
 */

const TOKEN_KEY = "crusaders.mainframe.token";

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(public status: number, public payload: unknown) {
    super(`HTTP ${status}`);
  }
}

/**
 * The request never produced a response at all — the connection was refused, the network
 * dropped, or the server accepted the socket and never answered.
 *
 * <p>
 * This is a different thing from an {@link ApiError} and every screen has to be able to tell
 * them apart: an `ApiError` carries a decision the club made, a `NetworkError` carries the
 * absence of one. Without the distinction a stalled backend was indistinguishable from a
 * pending request, and the Book button sat on "Working…" with `aria-busy` forever — the
 * member could not tell whether they had been charged for a court.
 * </p>
 */
export class NetworkError extends Error {
  constructor(public kind: "timeout" | "unreachable", options?: { cause?: unknown }) {
    super(kind === "timeout" ? "The request timed out." : "The server could not be reached.", options);
    this.name = "NetworkError";
  }
}

/**
 * How long any single API call may take before we give up on it.
 *
 * <p>
 * A stalled upstream — a wedged gateway, a backend hung on a slow query, a phone whose mobile
 * data dropped mid-request — never closes the socket, so `fetch` alone waits indefinitely.
 * The ceiling has to sit above a slow-but-real club connection and well below a member's
 * patience; 20s clears the slowest real response measured against this API by an order of
 * magnitude.
 * </p>
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/** File uploads carry a phone photo over club WiFi, so they get their own, longer budget. */
export const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * `fetch` with a deadline. Rejects with a {@link NetworkError} rather than a bare
 * `DOMException`/`TypeError`, so callers have one type to catch and one place to ask
 * "was this the club refusing, or the club not answering?".
 */
export async function fetchWithTimeout(
  path: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await fetch(path, { ...init, signal: controller.signal });
  } catch (cause) {
    throw new NetworkError(timedOut ? "timeout" : "unreachable", { cause });
  } finally {
    clearTimeout(timer);
  }
}

// Paths that should not trigger session-expired handling on 401. Login itself returns 401 on bad
// credentials, and the unauthenticated whoami probe is allowed to come back 401.
const UNAUTH_BYPASS = ["/api/v1/auth/login", "/api/v1/auth/webauthn/login", "/api/v1/whoami"];

let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) { unauthorizedHandler = fn; }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const hadToken = !!tokenStore.get();
  const res = await fetchWithTimeout(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(tokenStore.get() ? { authorization: `Bearer ${tokenStore.get()}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && hadToken && !UNAUTH_BYPASS.some((p) => path.startsWith(p))) {
    // Session expired or revoked — drop the token and let the AuthProvider redirect to /login.
    tokenStore.clear();
    unauthorizedHandler?.();
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
};

// ---- Typed endpoints ----

export type WhoAmI = {
  tenant_slug: string; tenant_id: string; user_id: string | null; is_authenticated: boolean; is_admin: boolean;
  /**
   * Set while an admin-issued temporary password is still in force. It is on the bootstrap
   * probe and not only on the login response because the browser reloads: without it a member
   * who refreshes mid-forced-change renders the app and then meets a 403 on every screen
   * instead of the one screen they need.
   */
  must_change_password?: boolean;
};
export type LoginResponse = { access_token: string; user_id: string; is_admin: boolean; must_change_password?: boolean };

/**
 * The stable snake_case code the API puts on a refusal. Never shown to a member — every screen
 * maps it to a sentence — but the mapping has to start somewhere, and reading `err.payload.error`
 * off `unknown` at four call sites is how a screen ends up mapping every 400 to one message.
 */
export function errorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const payload = err.payload as { error?: unknown } | null;
  return typeof payload?.error === "string" ? payload.error : null;
}
/**
 * Every ledger entry type the backend can emit.
 *
 * A real union rather than `string`, so adding a type on the backend without
 * teaching the frontend about it is a compile error here rather than a silent
 * gap in the admin filter. It was `string`, and the filter list below was a
 * hand-maintained array that had no relationship to it — nothing connected the
 * two, so a new type appeared in the ledger and was unfilterable, with no
 * warning anywhere.
 *
 * Keep in step with `LedgerEntryType` in the backend domain. The backend's
 * LedgerEntryTypeCoverageTests pins the member count, so the two cannot drift
 * far without something going red.
 */
export type LedgerEntryType =
  | "TopUp"
  | "BookingCharge"
  | "CancellationRefund"
  | "NoShowPenalty"
  | "LateCancellationPenalty"
  | "AdminAdjustment"
  | "PaymentReversal"
  | "LightsPurchase";

/** The filter list, derived from the union so the two cannot disagree. */
export const LEDGER_ENTRY_TYPES: readonly LedgerEntryType[] = [
  "AdminAdjustment",
  "BookingCharge",
  "CancellationRefund",
  "LateCancellationPenalty",
  "LightsPurchase",
  "NoShowPenalty",
  "PaymentReversal",
  "TopUp",
];

export type LedgerRow = {
  id: string;
  at: string;
  from: string;
  to: string;
  amountCredits: number;
  signedAmountCredits: number;
  type: LedgerEntryType;
  comment: string;
  subjectUserId: string;
  subjectName: string;
  actorUserId: string;
  actorName: string;
  relatedBookingId: string | null;
};

export type WalletResponse = {
  balance_credits: number;
  entries: LedgerRow[];
  /** Every movement the member has ever had; `entries` is one page of them. */
  total_entries: number;
  offset: number;
  limit: number;
};
export type ScheduleSlot = {
  courtId: string; courtNumber: number;
  startsAtUtc: string; endsAtUtc: string;
  status: string;
  ownerUserId: string | null;
  ownerFirstName: string | null;
  ownerPhotoUrl: string | null;
  isMine: boolean;
  bookingId: string | null;
  blockLabel: string | null;
};
export type ScheduleCourt = { id: string; courtNumber: number; name: string; slicePriceCredits: number };
export type ScheduleDay = {
  date: string; timezone: string; sliceMinutes: number;
  dayStartMinute: number; dayEndMinute: number; advanceBookingDays: number;
  courts: ScheduleCourt[]; slots: ScheduleSlot[]
};

export type AdminSettings = {
  slice_minutes: number;
  slice_price_credits: number;
  advance_booking_days: number;
  day_start_minute: number;
  day_end_minute: number;
  penalty_pct: number;
  grace_window_minutes: number;
  penalty_window_minutes: number;
  timezone: string;

  /** What each of a court box's eight buttons does, by physical position. */
  button_map: string[];

  // The nine keys the engine has always read and this API never showed. Until they
  // were surfaced the only way to change one was to hand-edit a JSON column on a
  // live money system.
  credits_per_zar_regular: number;
  credits_per_zar_league: number;
  topup_block_zar: number;
  topup_max_zar_per_member: number;
  member_per_day_max_minutes: number;
  peak_hours: string;
  peak_advance_hours_for_regular: number;
  retention_years: number;
  no_show_lookback_days: number;

  // The six court-box and identification numbers (WI-2). Served by GET /admin/settings
  // since the programme added them, but until now absent from this type, the save
  // mapper and the Settings page — so an admin could see none of them and change none
  // of them. Bounds are the API's (AdminConfigEndpoints.ValidateDeviceNumbers).
  /** 1–90. The relay bank's hard cap is 90; a setting above it sells minutes the lights cannot deliver. */
  walk_up_max_minutes: number;
  /**
   * 15–300. The box clamps its own cadence to this range, so a value outside it is not
   * what the fleet runs — and the Devices page derives "offline" from three missed
   * beats of it (review finding 22).
   */
  heartbeat_seconds: number;
  /** 1–1440. How far ahead of a booking a scan may activate it. */
  activation_forward_window_minutes: number;
  /** 0–1440, and never more than the forward window. */
  activation_cue_window_minutes: number;
  /** 15–3600. How long an ident code (walk-up / pay-for-someone) lives. */
  qr_lifetime_seconds: number;
  /** 5–1440. How far ahead the box's offline roster reaches. */
  roster_window_minutes: number;
};

/**
 * What a settings save may carry. The eight booking fields are required because every
 * form shows them; everything else is optional, and omitting it means unchanged.
 */
export type AdminSettingsSave =
  Pick<AdminSettings, "slice_minutes" | "slice_price_credits" | "advance_booking_days"
    | "day_start_minute" | "day_end_minute" | "penalty_pct" | "grace_window_minutes"
    | "penalty_window_minutes">
  & Partial<Omit<AdminSettings, "timezone">>;

/**
 * A court box, as the admin surface sees it.
 *
 * <p>
 * There is no per-device key here any more, and no claim, revoke or rotate. One static
 * API key per tenant authenticates every box, and a box that presents it and a device
 * code the club has never seen registers itself on that first heartbeat. What is left on
 * this row is identity the box reported and configuration an admin owns.
 * </p>
 */
export type AdminDevice = {
  id: string;
  device_code: string;
  name: string;
  kind: string;
  hardware: string;
  /**
   * The courts this box drives, in relay order: index 0 is relay A, index 3 is relay D.
   * One box, up to four courts — a court box is not "the box for court N" any more.
   * Empty for a gate.
   */
  court_numbers: number[];
  gate_key: string | null;
  /** Read-only identity the box reported. Nothing is authenticated against it. */
  mac_address: string | null;
  enabled: boolean;
  last_seen_at: string | null;
  last_ip_address: string | null;
  running_version?: string | null;
  mega_version?: string | null;
  created_at: string;
  /**
   * True until an admin edits this row.
   *
   * <p>
   * A box registers itself on its first heartbeat, which means it arrives named
   * `box-xxxxxx` and driving whatever courts the API defaulted it to — almost certainly
   * the wrong ones. The badge this drives is the only thing standing between that and a
   * league night where button 1 lights the wrong court, so it stays up until somebody
   * has actually looked.
   * </p>
   */
  auto_registered: boolean;
  /**
   * This box's own button map, or null to use the club's. Optional because the field
   * is landing on the API alongside this screen: the per-box editor renders only when
   * the payload actually carries it, so an older API simply shows no override.
   */
  button_map?: string[] | null;
  /**
   * The interval this box is actually running, seconds — the tenant setting after the
   * firmware's own 15-300 clamp. Never read the raw tenant setting as if it were what
   * the box runs: a club that sets 600 has boxes calling in every 300, and the
   * difference is the whole of "the entire fleet reads offline" (review finding 22).
   */
  effective_heartbeat_seconds?: number;
  /**
   * How long since the last beat before this box is offline, seconds. The API's own
   * arithmetic, so the screen and the fleet agree; absent, the screen derives it from
   * the cadence above rather than from a frozen literal.
   */
  offline_after_seconds?: number;
};

/**
 * The club's one device API key.
 *
 * <p>
 * Static, per tenant, and flashed into every box's `secrets.h`. It is not shown once and
 * then derived away — the API can and does hand it back on every GET, because a club
 * that adds a ninth box next season has to be able to read it again. That is the trade
 * this contract makes: a key an admin can always retrieve, in exchange for no claim
 * codes, no discovery listener and no per-device key to lose.
 * </p>
 */
export type DeviceApiKey = {
  api_key: string;
  regenerated_at: string;
};

/**
 * The code a member's phone shows the court box.
 *
 * `code` is the entire QR payload — twelve characters of Crockford base32, and nothing
 * else, because the box's scanner pipeline carries at most 24 bytes and poisons anything
 * longer. It used to be a JWT, which could never cross that pipeline at all.
 *
 * `kind` says what presenting it does: a `booking` code names the member's upcoming
 * booking (and lives until it ends plus the grace window), an `ident` code only says who
 * they are — for a walk-up, or for paying at somebody else's court — and lives for the
 * tenant's `qr_lifetime_seconds`.
 */
/** What the member can ask the generate endpoint for. Omitted means "you decide". */
export type MyQrKind = "ident";

export type MyQrCode = {
  code: string;
  kind: "booking" | "ident";
  expires_in_seconds: number;
  /** Booking codes only. */
  booking_id?: string;
  /** Booking codes only; null if the court row has since gone. */
  court_number?: number | null;
  /** Booking codes only. UTC. */
  starts_at?: string;
};

export type AdminCourt = {
  id: string;
  court_number: number;
  name: string;
  court_type: string;
  slice_price_credits: number;
  is_active: boolean;
};
export type MyProfile = {
  user_id: string;
  email: string;
  is_admin: boolean;
  tenant_slug: string;
  full_name: string | null;
  membership_number: string | null;
  photo_url: string | null;
  status: string | null;
  must_change_password?: boolean;
};

export type AdminMember = {
  membership_id: string; user_id: string; email: string;
  full_name: string; membership_number: string; photo_url: string | null;
  status: string; created_at: string; rejection_reason: string | null;
  member_class?: "Regular" | "LeagueOrSenior";   // Phase 8.1
  balance_credits: number;
};

// Phase 8 — per-member spend drill-down (blueprint C.3).
export type MemberSpendMonth = {
  month: string;
  top_ups_credits: number;   // credits added to the wallet
  top_ups_zar: number;       // actual rand paid, for reconciliation
  spent_credits: number;
  refunds_credits: number;
  penalties_credits: number;
  adjustments_credits: number;
  net_credits: number;
  movement_count: number;
};
export type MemberSpendReport = {
  from: string; to: string;
  member: { membership_id: string; user_id: string; full_name: string; membership_number: string; member_class: "Regular" | "LeagueOrSenior" };
  totals: { top_ups_credits: number; top_ups_zar: number; spent_credits: number; refunds_credits: number; penalties_credits: number; net_credits: number; movement_count: number };
  monthly: MemberSpendMonth[];
};

export type WebhookEndpointDto = {
  id: string;
  owner_kind: "Tenant" | "User";
  url_template: string;
  event_filter: string;
  enabled: boolean;
  description: string | null;
  failure_count: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  secret: string | null; // only present on create
};

export type WebhookDeliveryDto = {
  Id: string;
  EventType: string;
  Url: string;
  ResponseStatus: number | null;
  LatencyMs: number;
  Attempt: number;
  FinalState: "pending" | "delivered" | "failed" | "abandoned";
  CreatedAt: string;
  ResponseBodyExcerpt: string | null;
};

export type BiometricTemplateRow = {
  template_id: string;
  finger_label: string | null;
  created_at: string;
};
export type BiometricEnrollmentRow = {
  user_id: string;
  full_name: string;
  email: string;
  photo_url: string | null;
  membership_number: string;
  templates: BiometricTemplateRow[];
};

export type WebAuthnCredentialRow = {
  id: string;
  label: string;
  transports: string | null;
  created_at: string;
  last_used_at: string | null;
};

/**
 * What the club will take for a top-up, and at what rate — read from `tenant_settings`
 * rather than hardcoded on the screen.
 *
 * The screen carried `MIN_ZAR = 100`, `MAX_ZAR = 1000`, `BLOCK_ZAR = 100` and two literal
 * conversion rates, so an admin who changed any of them left it quoting 60% more credits
 * than the member would get, offering amounts the club had stopped accepting and refusing
 * amounts it did accept — disagreeing with the server in both directions at once.
 */
export type TopUpOptions = {
  block_zar: number;
  min_zar: number;
  max_zar: number;
  presets_zar: number[];
  conversion_rate: number;
  member_class: "Regular" | "LeagueOrSenior";
};

/**
 * One court's row in the utilisation report.
 *
 * `revenue_credits` is what the club KEPT, summed off the ledger rows naming each booking
 * — the settlement model's `Owed`. It used to be the price quoted at booking, so a
 * no-showed 50-credit court counted as 50 of revenue when the club's take was the 15
 * penalty. `quoted_credits` keeps the old figure under a name that says what it is.
 *
 * `booked_minutes` exists because `slices` mixes units: a 60-minute walk-up is one slice,
 * the same as a 15-minute booking.
 */
export type UtilisationRow = {
  court_id: string; court_number: number; court_name: string;
  slices: number;
  booked_minutes: number;
  bookings: number;
  revenue_credits: number;
  quoted_credits: number;
};

/** One form field of the signed PayFast checkout, in the order the signature covers. */
export type PayFastFormField = { name: string; value: string };

/**
 * A registered top-up. `form_fields` **is** the payment: PayFast has no server-side
 * checkout registration, so the browser POSTs this signed form to `redirect_url`.
 * Following `redirect_url` as a GET — which is what the page used to do — reaches PayFast
 * with no merchant id, no amount and no signature.
 */
export type TopUpStart = {
  topup_id: string;
  checkout_id: string;
  redirect_url: string;
  form_fields: PayFastFormField[];
  quoted_credits: number;
  conversion_rate: number;
};

/** A stable snake_case code, never an internal string — see `TOPUP_FAILURE_COPY`. */
export type TopUpStatus = {
  id: string;
  status: "Pending" | "Completed" | "Failed" | "Cancelled";
  amount_zar: number;
  conversion_rate: number | null;
  failure_code: string | null;
};

/**
 * A member's own period summary.
 *
 * Every bucket a movement can land in, because the page has to reconcile: it reported
 * top-ups, spend, refunds and a penalty COUNT and nothing else, so a member with 2,500
 * credits of admin adjustments read "0 in, 950 out, 100 back" beside a header saying
 * 1,635 and no way to see where the gap came from. `net_movement_credits` is the sum,
 * and over a range covering the whole ledger it is the balance.
 */
export type WalletReport = {
  from: string; to: string;
  top_ups_credits: number;
  spent_credits: number;
  refunds_credits: number;
  /** The penalty TOTAL `reporting.md` asks for, beside the count that was already here. */
  penalties_credits: number;
  adjustments_credits: number;
  reversals_credits: number;
  net_movement_credits: number;
  penalty_count: number;
  /** Attendance — `CheckedInAt`, the source of truth the settlement model hangs off. */
  attended_bookings: number;
  minutes_on_court: number;
  count: number;
};
export type DailyAdminPoint = { date: string; top_ups_credits: number; booking_charges_credits: number; refunds_credits: number; penalties_credits: number; bookings: number; no_shows: number };
export type DailyMePoint = { date: string; top_ups_credits: number; spent_credits: number; refunds_credits: number; bookings: number; attended: number; minutes_on_court: number; balance_credits: number };
/**
 * Club revenue over a window, in BOTH units, because they are not interchangeable.
 *
 * The `_zar` fields are what members actually paid, from `LedgerEntry.ZarPaid`. The
 * `_credits` fields are what those payments became at each member's class rate. The API
 * used to send credits under the `_zar` names and this page printed them with a rand sign,
 * so R1000 of income was reported as R1600 (Regular) or R2400 (League).
 */
export type RevenueReport = {
  from: string;
  to: string;
  gross_topups_zar: number;
  reversals_zar: number;
  net_zar: number;
  gross_topups_credits: number;
  reversals_credits: number;
  net_credits: number;
};

export async function uploadPhoto(file: File): Promise<{ url: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetchWithTimeout("/api/v1/uploads/photo", { method: "POST", body: fd }, UPLOAD_TIMEOUT_MS);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

export const endpoints = {
  whoami: () => api.get<WhoAmI>("/api/v1/whoami"),
  /**
   * Ends the session on the server as well as in this browser.
   *
   * <p>
   * Deleting the stored token is not a sign-out — a JWT is a bearer credential and keeps
   * working wherever else it reached until it expires. This is what makes the credential stop.
   * </p>
   */
  logout: () => api.post<void>("/api/v1/auth/logout"),
  /**
   * A one-minute, stream-only credential for the wallet SSE connection.
   *
   * <p>
   * `EventSource` cannot send an Authorization header, so something has to travel in the URL,
   * where every proxy logs it. The full access token used to; this is the thing that is worth
   * nothing to whoever reads that log ten minutes later.
   * </p>
   */
  walletStreamTicket: () => api.post<{ ticket: string; expires_in_seconds: number }>("/api/v1/wallet/stream-ticket"),
  register: (req: { email: string; password: string; fullName: string; membershipNumber: string; photoUrl?: string }) =>
    api.post<{ user_id: string; status: string }>("/api/v1/auth/register", {
      email: req.email,
      password: req.password,
      fullName: req.fullName,
      membershipNumber: req.membershipNumber,
      photoUrl: req.photoUrl ?? null,
    }),
  verifyEmail: (token: string) => api.post<{ verified: boolean }>(`/api/v1/auth/verify-email/${token}`),
  login: (email: string, password: string) => api.post<LoginResponse>("/api/v1/auth/login", { email, password }),
  refresh: () => api.post<LoginResponse>("/api/v1/auth/refresh"),
  devAdminLogin: () => api.post<LoginResponse>("/api/v1/auth/dev/admin-login"),

  // WebAuthn / passkeys
  webauthnLoginOptions: () => api.post<{ flowId: string; options: unknown }>("/api/v1/auth/webauthn/login/options", {}),
  webauthnLogin: (flowId: string, response: unknown) =>
    api.post<LoginResponse>("/api/v1/auth/webauthn/login", { flowId, response }),
  webauthnList: () => api.get<WebAuthnCredentialRow[]>("/api/v1/me/webauthn/credentials"),
  webauthnRegisterOptions: (label: string) =>
    api.post<{ flowId: string; options: unknown }>("/api/v1/me/webauthn/register/options", { label }),
  webauthnRegister: (flowId: string, response: unknown, transports: string[] | null) =>
    api.post<{ id: string; label: string }>("/api/v1/me/webauthn/register", { flowId, response, transports }),
  webauthnDelete: (id: string) => api.del<void>(`/api/v1/me/webauthn/credentials/${id}`),
  magicLink: (token: string) => api.post<LoginResponse>(`/api/v1/auth/magic-link/${token}`),
  forgotPassword: (email: string) => api.post<{ ok: boolean }>("/api/v1/auth/forgot-password", { email }),
  resetPassword: (token: string, newPassword: string) => api.post<{ reset: boolean }>("/api/v1/auth/reset-password", { token, newPassword }),
  /**
   * Re-sends the address-confirmation email. Answers 200 whatever the address is, so a caller
   * cannot use it to find out who is registered — which is also why the screen's confirmation
   * says "if that address is registered" rather than claiming a mail was sent.
   */
  resendVerification: (email: string) => api.post<{ ok: boolean }>("/api/v1/auth/resend-verification", { email }),
  /** The signed-in member replacing their own password — and, in doing so, retiring a temporary one. */
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ changed: boolean }>("/api/v1/me/password", { currentPassword, newPassword }),

  wallet: (limit?: number, offset?: number) => api.get<WalletResponse>(`/api/v1/wallet${qs({ limit, offset })}`),
  schedule: (date: string) => api.get<ScheduleDay>(`/api/v1/schedule?date=${date}`),
  book: (courtId: string, startsAt: string, sliceCount: number) =>
    api.post<{ booking_id: string; balance_after_credits: number }>("/api/v1/bookings/", { courtId, startsAt, sliceCount }),
  cancelBooking: (bookingId: string) => api.post<{ refunded_credits: number; penalty_credits: number }>(`/api/v1/bookings/${bookingId}/cancel`),

  adminMembers: (status?: string) => api.get<AdminMember[]>(`/api/v1/admin/members/${status ? `?status=${status}` : ""}`),
  adminApprove: (memberId: string) => api.post<{ approved: boolean }>(`/api/v1/admin/members/${memberId}/approve`),
  adminReject: (memberId: string, reason: string) => api.post<{ rejected: boolean }>(`/api/v1/admin/members/${memberId}/reject`, { reason }),
  /**
   * A manual credit movement. `relatedBookingId` is optional and OMITTED when not given:
   * an adjustment that names a booking is what lets a late box upload recognise that the
   * desk already compensated the member for a wrongly-swept no-show, and audit instead of
   * refunding twice (`BookingService.ReverseNoShowAsync`). One without it is plain money.
   */
  adminAdjust: (userId: string, amountCredits: number, reason: string, relatedBookingId?: string) =>
    api.post<{ entry_id: string; amount_credits: number; balance_after_credits: number }>(`/api/v1/admin/credit/${userId}/adjust`, {
      amountCredits,
      reason,
      ...(relatedBookingId ? { relatedBookingId } : {}),
    }),
  adminResetMemberPassword: (memberId: string) =>
    api.post<{ temp_password: string; email_sent_to: string; advice: string }>(`/api/v1/admin/members/${memberId}/reset-password`),

  // Phase 8.1 — class assignment (Regular / LeagueOrSenior). Drives the credits-per-rand top-up rate
  // and the peak-hours league exclusivity rule.
  adminSetMemberClass: (memberId: string, memberClass: "Regular" | "LeagueOrSenior") =>
    api.post<{ member_class: string; changed: boolean; previous?: string }>(`/api/v1/admin/members/${memberId}/class`, { memberClass }),

  // Phase 8 — per-member spend drill-down (blueprint C.3).
  adminMemberSpend: (memberId: string, from?: string, to?: string) =>
    api.get<MemberSpendReport>(`/api/v1/admin/members/${memberId}/spend${qs({ from, to })}`),

  // Phase 8.6 — PIN identification (self-service + admin reset).
  meSetPin: (pin: string) => api.post<{ pin_set: boolean }>("/api/v1/me/pin", { pin }),
  meClearPin: () => api.del<void>("/api/v1/me/pin"),
  adminSetMemberPin: (memberId: string, pin: string) =>
    api.post<{ pin_set: boolean }>(`/api/v1/admin/members/${memberId}/pin`, { pin }),
  courtPinMatch: (courtNumber: number, pin: string) =>
    api.post<{ matched: boolean; user_id: string | null }>(`/api/v1/court/${courtNumber}/pin/match`, { pin }),

  // Phase 8.6 — QR identification (third leg of the triple-stack). See MyQrCode.
  /**
   * The member's court code.
   *
   * <p>
   * With no `kind` the server decides: a booking code when one of the member's bookings
   * is inside the roster window, an ident code otherwise. That default is right for the
   * common case and wrong for the one that costs the club money — a member with a
   * booking two hours out cannot walk up to a free court or pay for a friend, because a
   * booking code is refused at every court but its own and the resolver takes nothing
   * else. `kind: "ident"` asks for the walk-up code explicitly, whatever bookings exist.
   * </p>
   */
  meQrGenerate: (kind?: MyQrKind) => api.post<MyQrCode>(`/api/v1/me/qr/generate${qs({ kind })}`),
  courtQrMatch: (courtNumber: number, token: string) =>
    api.post<{ matched: boolean; user_id?: string; reason?: string }>(`/api/v1/court/${courtNumber}/qr/match`, { token }),

  // Top-up
  /**
   * What the club will take, and at what rate — every number the top-up screen used to
   * hardcode. See `TopUpOptions`.
   */
  topupOptions: () => api.get<TopUpOptions>("/api/v1/credit/topup/options"),
  /**
   * Registers a top-up and returns the SIGNED FORM the browser must POST to PayFast.
   *
   * The argument is **rand**. This posted `amountCredits` against a server record of
   * `AmountZar`, so the amount bound to 0, the positivity guard fired, and no member
   * could top up at all — the screen told them their amount was a bad multiple of R100.
   */
  topupStart: (amountZar: number) => api.post<TopUpStart>("/api/v1/credit/topup", { amountZar }),
  topupStatus: (topupId: string) => api.get<TopUpStatus>(`/api/v1/credit/topup/${topupId}`),

  // Webhooks (admin)
  adminWebhooksList: () => api.get<WebhookEndpointDto[]>("/api/v1/admin/webhooks/"),
  adminWebhooksCreate: (req: { urlTemplate: string; eventFilter?: string; description?: string }) =>
    api.post<WebhookEndpointDto>("/api/v1/admin/webhooks/", req),
  adminWebhooksDelete: (id: string) => api.del<void>(`/api/v1/admin/webhooks/${id}`),
  adminWebhookDeliveries: (id: string) => api.get<WebhookDeliveryDto[]>(`/api/v1/admin/webhooks/${id}/deliveries`),

  // Biometric (admin)
  adminBiometricEnroll: (userId: string, fingerLabel?: string) =>
    api.post<{ template_id: string }>("/api/v1/admin/biometric/enroll", { userId, fingerLabel: fingerLabel ?? null, consentReceiptHash: "v1" }),
  adminBiometricEnrollments: () =>
    api.get<BiometricEnrollmentRow[]>("/api/v1/admin/biometric/enrollments"),
  adminBiometricRemoveTemplate: (templateId: string) =>
    api.del<void>(`/api/v1/admin/biometric/templates/${templateId}`),
  courtBiometricMatch: (courtNumber: number) =>
    api.post<{ matched: boolean; user_id: string | null; confidence: number; latency_ms: number }>(`/api/v1/court/${courtNumber}/biometric/match`),

  // Reports
  reportWallet: (from?: string, to?: string) =>
    api.get<WalletReport>(`/api/v1/reports/me/wallet${qs({ from, to })}`),
  walletCsvUrl: (from?: string, to?: string) => `/api/v1/reports/me/wallet.csv${qs({ from, to })}`,
  /**
   * Fetches the wallet CSV **with the session's bearer token** and hands back a blob the
   * page can save.
   *
   * The control was a plain `<a href download>`, so the browser navigated to the endpoint
   * on its own with no Authorization header: the API could not even resolve a tenant and
   * answered `400 tenant_unresolved` as JSON. The download started and cancelled itself —
   * no file, no toast, no console error, the page identical before and after.
   */
  walletCsv: async (from?: string, to?: string): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetchWithTimeout(endpoints.walletCsvUrl(from, to), {
      headers: { ...(tokenStore.get() ? { authorization: `Bearer ${tokenStore.get()}` } : {}) },
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename="?([^"]+)"?/.exec(disposition);
    return { blob: await res.blob(), filename: match?.[1] ?? "wallet.csv" };
  },
  reportRevenue: (from?: string, to?: string) =>
    api.get<RevenueReport>(`/api/v1/admin/reports/revenue${qs({ from, to })}`),
  reportUtilisation: (from?: string, to?: string) =>
    api.get<{ from: string; to: string; by_court: UtilisationRow[] }>(`/api/v1/admin/reports/utilisation${qs({ from, to })}`),
  reportNoShows: (from?: string, to?: string) =>
    api.get<{ from: string; to: string; total: number; no_show: number; no_show_pct: number }>(`/api/v1/admin/reports/no-shows${qs({ from, to })}`),
  reportDailyAdmin: (from?: string, to?: string) =>
    api.get<DailyAdminPoint[]>(`/api/v1/admin/reports/daily${qs({ from, to })}`),
  reportDailyMe: (from?: string, to?: string) =>
    api.get<DailyMePoint[]>(`/api/v1/reports/me/daily${qs({ from, to })}`),

  // Admin: tenant-wide config
  adminSettingsGet: () => api.get<AdminSettings>("/api/v1/admin/settings/"),
  /**
   * Saves settings.
   *
   * Everything past the eight booking fields is optional and OMITTED WHEN UNDEFINED,
   * because the API reads an absent key as "unchanged". That is what lets the booking
   * form, the economics form and the button-map editor be three screens without any
   * of them reverting the others' work on save.
   */
  adminSettingsSave: (req: AdminSettingsSave) => api.put<{ saved: true }>("/api/v1/admin/settings/", {
    sliceMinutes: req.slice_minutes,
    slicePriceCredits: req.slice_price_credits,
    advanceBookingDays: req.advance_booking_days,
    dayStartMinute: req.day_start_minute,
    dayEndMinute: req.day_end_minute,
    penaltyPct: req.penalty_pct,
    graceWindowMinutes: req.grace_window_minutes,
    penaltyWindowMinutes: req.penalty_window_minutes,
    ...(req.button_map !== undefined ? { buttonMap: req.button_map } : {}),
    ...(req.credits_per_zar_regular !== undefined ? { creditsPerZarRegular: req.credits_per_zar_regular } : {}),
    ...(req.credits_per_zar_league !== undefined ? { creditsPerZarLeague: req.credits_per_zar_league } : {}),
    ...(req.topup_block_zar !== undefined ? { topupBlockZar: req.topup_block_zar } : {}),
    ...(req.topup_max_zar_per_member !== undefined ? { topupMaxZarPerMember: req.topup_max_zar_per_member } : {}),
    ...(req.member_per_day_max_minutes !== undefined ? { memberPerDayMaxMinutes: req.member_per_day_max_minutes } : {}),
    ...(req.peak_hours !== undefined ? { peakHours: req.peak_hours } : {}),
    ...(req.peak_advance_hours_for_regular !== undefined ? { peakAdvanceHoursForRegular: req.peak_advance_hours_for_regular } : {}),
    ...(req.retention_years !== undefined ? { retentionYears: req.retention_years } : {}),
    ...(req.no_show_lookback_days !== undefined ? { noShowLookbackDays: req.no_show_lookback_days } : {}),
    ...(req.walk_up_max_minutes !== undefined ? { walkUpMaxMinutes: req.walk_up_max_minutes } : {}),
    ...(req.heartbeat_seconds !== undefined ? { heartbeatSeconds: req.heartbeat_seconds } : {}),
    ...(req.activation_forward_window_minutes !== undefined ? { activationForwardWindowMinutes: req.activation_forward_window_minutes } : {}),
    ...(req.activation_cue_window_minutes !== undefined ? { activationCueWindowMinutes: req.activation_cue_window_minutes } : {}),
    ...(req.qr_lifetime_seconds !== undefined ? { qrLifetimeSeconds: req.qr_lifetime_seconds } : {}),
    ...(req.roster_window_minutes !== undefined ? { rosterWindowMinutes: req.roster_window_minutes } : {}),
  }),

  // Admin: devices.
  //
  // `court_numbers` is snake_case on every request that carries it, because the API pins
  // that one property name (the rest bind from camelCase case-insensitively). It is a
  // list in relay order: [court on A, on B, …].
  //
  // Discovery, claim, manual registration, key rotation and revocation are gone: boxes
  // authenticate with the tenant's one static API key and register themselves on their
  // first heartbeat. What is left is the list, the edit and the delete.
  adminDevicesList: () => api.get<AdminDevice[]>("/api/v1/admin/devices/"),
  /**
   * `button_map` is this box's override and the API binds it three-valued
   * (`UpdateDeviceRequest` takes it as a bare JsonElement, pinned snake_case like
   * `court_numbers`): a list sets one, `null` goes back to the club's map, and an ABSENT
   * key leaves it alone. The spread below keeps that contract — a caller that does not
   * mention `button_map` sends no such key, and JSON.stringify drops an `undefined` one.
   */
  adminDeviceUpdate: (id: string, req: { name?: string; enabled?: boolean; court_numbers?: number[]; button_map?: string[] | null }) =>
    api.patch<AdminDevice>(`/api/v1/admin/devices/${id}`, { ...req }),
  /**
   * Forgets a box. It is not a revocation and does not lock anything out: the box still
   * holds the club's API key, so it registers itself again on its next heartbeat — as a
   * fresh, auto-registered row with default courts. Deleting is for a box that is
   * genuinely gone, or for starting its configuration over.
   */
  adminDeviceDelete: (id: string) => api.del<{ deleted: true }>(`/api/v1/admin/devices/${id}`),

  // Admin: the club's one device API key.
  adminDeviceApiKey: () => api.get<DeviceApiKey>("/api/v1/admin/devices/api-key"),
  /** The old key stops working immediately, so every box has to be reflashed with this one. */
  adminDeviceApiKeyRegenerate: () => api.post<DeviceApiKey>("/api/v1/admin/devices/api-key/regenerate", {}),

  // Admin: courts
  adminCourtsList: () => api.get<AdminCourt[]>("/api/v1/admin/courts/"),
  adminCourtsCreate: (req: { name: string; courtType?: string; slicePriceCredits: number }) =>
    api.post<{ id: string; court_number: number }>("/api/v1/admin/courts/", { name: req.name, courtType: req.courtType ?? "Squash", slicePriceCredits: req.slicePriceCredits }),
  adminCourtsUpdate: (id: string, req: { name?: string; slicePriceCredits?: number; isActive?: boolean }) =>
    api.patch<{ saved: true }>(`/api/v1/admin/courts/${id}`, req),
  adminCourtsDelete: (id: string) => api.del<{ deactivated: true }>(`/api/v1/admin/courts/${id}`),

  // Profile (authenticated user)
  meProfile: () => api.get<MyProfile>("/api/v1/me/profile"),
  meUpdateProfile: (req: { fullName?: string; photoUrl?: string }) =>
    api.put<{ full_name: string; photo_url: string | null }>("/api/v1/me/profile", req),
  meUploadPhoto: async (file: File): Promise<{ photo_url: string }> => {
    const fd = new FormData();
    fd.append("file", file);
    const tok = tokenStore.get();
    const res = await fetchWithTimeout("/api/v1/me/photo", {
      method: "POST",
      headers: tok ? { Authorization: `Bearer ${tok}` } : undefined,
      body: fd,
    }, UPLOAD_TIMEOUT_MS);
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res.json();
  },

  // Admin: full ledger
  adminLedger: (params: { from?: string; to?: string; userId?: string; type?: string; limit?: number } = {}) =>
    api.get<LedgerRow[]>(`/api/v1/admin/ledger/${qs({
      from: params.from, to: params.to, userId: params.userId, type: params.type,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
    })}`),
};

function qs(o: Record<string, string | number | undefined>) {
  const p = Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  return p ? `?${p}` : "";
}
