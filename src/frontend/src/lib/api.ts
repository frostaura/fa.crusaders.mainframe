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

// Paths that should not trigger session-expired handling on 401. Login itself returns 401 on bad
// credentials, and the unauthenticated whoami probe is allowed to come back 401.
const UNAUTH_BYPASS = ["/api/v1/auth/login", "/api/v1/auth/webauthn/login", "/api/v1/whoami"];

let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) { unauthorizedHandler = fn; }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const hadToken = !!tokenStore.get();
  const res = await fetch(path, {
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

export type WhoAmI = { tenant_slug: string; tenant_id: string; user_id: string | null; is_authenticated: boolean; is_admin: boolean };
export type LoginResponse = { access_token: string; user_id: string; is_admin: boolean };
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

/** A court box or gate controller, as the admin surface sees it. */
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
  mac_address: string | null;
  key_version: number;
  enabled: boolean;
  revoked_at: string | null;
  last_seen_at: string | null;
  last_ip_address: string | null;
  running_version: string | null;
  mega_version: string | null;
  ota_channel: string;
  pinned_version: string | null;
  /** A build this box installed and could never make a working call on. */
  failed_version: string | null;
  created_at: string;
};

/** A board announcing itself on the LAN that has not been claimed yet. */
export type DiscoveredBoard = {
  mac: string;
  address: string;
  hardware: string;
  firmware: string;
  mega_version: string | null;
  claimed: boolean;
  claimable: boolean;
  /** Null when there was nothing to verify. False means a board asserted an identity
   *  it could not prove, which is what a spoof AND a rotated key both look like. */
  signature_verified: boolean | null;
  device_id: string | null;
  tenant_slug: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

export type DiscoveryStatus = {
  state: string;
  listening: boolean;
  bound_endpoint: string | null;
  detail: string | null;
  packets_received: number;
  packets_accepted: number;
  packets_rejected: number;
  last_packet_at: string | null;
  started_at: string | null;
  announcers: number;
  capacity_reached: boolean;
  hint: string | null;
};

export type ClaimResult = {
  device: AdminDevice;
  device_key: string;
  key_version: number;
  board: DiscoveredBoard;
  note: string;
};

/** What manual registration hands back: the row, and the key that is never shown again. */
export type DeviceRegistration = {
  device: AdminDevice;
  device_key: string;
  key_version: number;
  note: string;
};

/** A court box's brain. Gates are modelled on the API but parked, so they are not offered here. */
export type DeviceHardware = "Esp8266" | "Mega2560" | "Esp32";
export type OtaChannel = "Stable" | "Canary" | "Pinned";

/**
 * Enum values as the API binds them. It configures no string-enum converter, so requests
 * carry the integer; responses spell the name out (`DeviceView`), which is what the types
 * above hold. Keep in step with `DeviceKind`, `DeviceHardware` and `OtaChannel` in the
 * backend domain.
 */
export const DEVICE_KIND_WIRE = { CourtBox: 0, Gate: 1 } as const;
export const DEVICE_HARDWARE_WIRE: Record<DeviceHardware, number> = { Mega2560: 0, Esp8266: 1, Esp32: 2 };
export const OTA_CHANNEL_WIRE: Record<OtaChannel, number> = { Stable: 0, Canary: 1, Pinned: 2 };

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

export type WalletReport = { from: string; to: string; top_ups_credits: number; spent_credits: number; refunds_credits: number; penalty_count: number; count: number };
export type DailyAdminPoint = { date: string; top_ups_credits: number; booking_charges_credits: number; refunds_credits: number; penalties_credits: number; bookings: number; no_shows: number };
export type DailyMePoint = { date: string; top_ups_credits: number; spent_credits: number; refunds_credits: number; bookings: number; balance_credits: number };
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
  const res = await fetch("/api/v1/uploads/photo", { method: "POST", body: fd });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

export const endpoints = {
  whoami: () => api.get<WhoAmI>("/api/v1/whoami"),
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

  wallet: () => api.get<WalletResponse>("/api/v1/wallet"),
  schedule: (date: string) => api.get<ScheduleDay>(`/api/v1/schedule?date=${date}`),
  book: (courtId: string, startsAt: string, sliceCount: number) =>
    api.post<{ booking_id: string; balance_after_credits: number }>("/api/v1/bookings/", { courtId, startsAt, sliceCount }),
  cancelBooking: (bookingId: string) => api.post<{ refunded_credits: number; penalty_credits: number }>(`/api/v1/bookings/${bookingId}/cancel`),

  adminMembers: (status?: string) => api.get<AdminMember[]>(`/api/v1/admin/members/${status ? `?status=${status}` : ""}`),
  adminApprove: (memberId: string) => api.post<{ approved: boolean }>(`/api/v1/admin/members/${memberId}/approve`),
  adminReject: (memberId: string, reason: string) => api.post<{ rejected: boolean }>(`/api/v1/admin/members/${memberId}/reject`, { reason }),
  adminAdjust: (userId: string, amountCredits: number, reason: string) =>
    api.post<{ entry_id: string; amount_credits: number; balance_after_credits: number }>(`/api/v1/admin/credit/${userId}/adjust`, { amountCredits, reason }),
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
  meQrGenerate: () => api.post<MyQrCode>("/api/v1/me/qr/generate"),
  courtQrMatch: (courtNumber: number, token: string) =>
    api.post<{ matched: boolean; user_id?: string; reason?: string }>(`/api/v1/court/${courtNumber}/qr/match`, { token }),

  // Top-up
  topupStart: (amountCredits: number) => api.post<{ topup_id: string; checkout_id: string; redirect_url: string }>("/api/v1/credit/topup", { amountCredits }),
  topupStatus: (topupId: string) => api.get<{ id: string; status: string; amount_zar: number; failure_reason: string | null }>(`/api/v1/credit/topup/${topupId}`),

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
  reportRevenue: (from?: string, to?: string) =>
    api.get<RevenueReport>(`/api/v1/admin/reports/revenue${qs({ from, to })}`),
  reportUtilisation: (from?: string, to?: string) =>
    api.get<{ from: string; to: string; by_court: { court_id: string; court_number: number; court_name: string; slices: number; bookings: number; revenue_credits: number }[] }>(`/api/v1/admin/reports/utilisation${qs({ from, to })}`),
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
  }),

  // Admin: devices.
  //
  // `court_numbers` is snake_case on every request that carries it — register, update
  // and claim — because the API pins that one property name (the rest bind from
  // camelCase case-insensitively). It is a list in relay order: [court on A, on B, …].
  //
  // Enums go over the wire as their integer values: the API configures no string-enum
  // converter, so a name like "Canary" does not bind. (It used to be sent as a name.)
  adminDevicesList: () => api.get<AdminDevice[]>("/api/v1/admin/devices/"),
  adminDeviceRegister: (req: { deviceCode: string; name: string; hardware: DeviceHardware; court_numbers: number[] }) =>
    api.post<DeviceRegistration>("/api/v1/admin/devices/", {
      deviceCode: req.deviceCode,
      name: req.name,
      kind: DEVICE_KIND_WIRE.CourtBox,
      hardware: DEVICE_HARDWARE_WIRE[req.hardware],
      court_numbers: req.court_numbers,
    }),
  adminDeviceUpdate: (id: string, req: { name?: string; enabled?: boolean; court_numbers?: number[]; otaChannel?: OtaChannel; pinnedVersion?: string | null }) =>
    api.patch<AdminDevice>(`/api/v1/admin/devices/${id}`, {
      ...req,
      ...(req.otaChannel !== undefined ? { otaChannel: OTA_CHANNEL_WIRE[req.otaChannel] } : {}),
    }),
  adminDeviceRevoke: (id: string) => api.post<{ revoked: true }>(`/api/v1/admin/devices/${id}/revoke`, {}),
  adminDeviceRotateKey: (id: string) =>
    api.post<{ device_key: string; key_version: number }>(`/api/v1/admin/devices/${id}/rotate-key`, {}),

  // Admin: connecting a board
  adminDevicesDiscovered: () => api.get<DiscoveredBoard[]>("/api/v1/admin/devices/discovered"),
  adminDiscoveryStatus: () => api.get<DiscoveryStatus>("/api/v1/admin/devices/discovery-status"),
  /**
   * Claims an announcing board. Every property here is pinned snake_case on the API
   * (`ClaimBoardRequest`), and the board is matched by its commitment to `claim_code`,
   * not by MAC — so the MAC the admin picked in the list is not sent. This used to send
   * `{ mac, claimCode, courtNumber }`, none of which bound to anything, so no claim from
   * this screen could ever have succeeded.
   */
  adminDeviceClaim: (req: { claimCode: string; deviceCode: string; name: string; court_numbers: number[] }) =>
    api.post<ClaimResult>("/api/v1/admin/devices/claim", {
      claim_code: req.claimCode,
      device_code: req.deviceCode,
      name: req.name,
      court_numbers: req.court_numbers,
    }),

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
    const res = await fetch("/api/v1/me/photo", {
      method: "POST",
      headers: tok ? { Authorization: `Bearer ${tok}` } : undefined,
      body: fd,
    });
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

function qs(o: Record<string, string | undefined>) {
  const p = Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join("&");
  return p ? `?${p}` : "";
}
