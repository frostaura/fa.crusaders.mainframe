import { api, type BulkBookItemBody, type MemberBulkBookResponse } from "./api";

/**
 * P11 — the players-and-splits wire (D11–D13): the players on a booking and who pays what,
 * invites and links, recent partners, favourites and the opt-in directory, the member's own
 * inbox, the social preferences, and the admin's god mode over a booking's seats.
 *
 * <p>
 * <b>Requests are camelCase and answers snake_case</b>, as every POST in this API is. A refusal
 * is always <code>{ error, …figures }</code> with a stable code; `playersCopy.playersRefusal`
 * turns every one of them into a sentence. The normative catalogue is the backend's
 * `docs/specs/players-and-splits.md` §7; the shapes below are its view records, field for field.
 * </p>
 *
 * <p>
 * <b>A separate module from `lib/api.ts`</b> so a feature this size does not add a thousand
 * lines to the one file every lane touches; it rides the same `api` client, so timeouts, the
 * 401 handler and the club-zone sniffing apply unchanged.
 * </p>
 */

/* ─────────────────────────────── vocabulary ─────────────────────────────── */

/** How a price is divided. Seat 1 (the organiser) always takes the remainder. */
export type SplitMode = "equal" | "ratio" | "amount";
export const SPLIT_MODES: readonly SplitMode[] = ["equal", "ratio", "amount"];

/** A seat's state. Only `invited` and `accepted` are LIVE — they hold the seat. */
export type ParticipantStatus = "invited" | "accepted" | "declined" | "withdrawn" | "removed" | "lapsed";

/** Who a seat is. Seat 1 is always the organiser. */
export type ParticipantKind = "organiser" | "member" | "guest" | "open_link";

/** Seats 1–2 are team A, 3–4 team B. */
export type Team = "A" | "B";

export type BookingStatusWord = "booked" | "cancelled" | "no_show" | "completed" | "blocked";

/** The most seats a booking has — the database's own ceiling. */
export const MAX_SEATS = 4;

/** A member as another member may see them: id, name, photo. Nothing else, ever. */
export type PublicMember = { user_id: string; name: string; photo_url: string | null };

/* ─────────────────────────────── requests ─────────────────────────────── */

/**
 * One player to add: a member by id, a named guest, or an open link seat — exactly one of the
 * three. `weight` is read by a ratio split (0–100), `amount` by an amount split (≥ 0, ≤ 2 dp).
 */
export type PlayerSpec = {
  userId?: string;
  guestName?: string;
  link?: boolean;
  /** 2–4. Omitted, the server takes the lowest free seat. */
  seat?: number;
  weight?: number;
  amount?: number;
};

/** The players a booking is made with, or added to an existing one. */
export type PlayersPayload = {
  players: PlayerSpec[];
  splitMode?: SplitMode;
  /** Seat 1's weight in a ratio split. */
  organiserWeight?: number;
};

export type SplitPreviewRequest = {
  priceMinutes: number;
  splitMode: SplitMode;
  organiserWeight?: number;
  players: PlayerSpec[];
};

/* ─────────────────────────────── answers ─────────────────────────────── */

export type SplitPreviewShare = { seat: number; team: Team; share_minutes: number; weight: number };
export type SplitPreview = { price_minutes: number; shares: SplitPreviewShare[] };

/** A seat as the add answers it. `invite_token` is shown ONCE — it is stored only hashed. */
export type AddedParticipant = {
  participant_id: string;
  seat: number;
  user_id: string | null;
  guest_name: string | null;
  status: ParticipantStatus;
  share_minutes: number;
  invite_token: string | null;
  invite_path: string | null;
};

export type AddPlayersAnswer = { booking_id: string; participants: AddedParticipant[] };

/**
 * A booking made with players. `players_error` is set when the booking stood but the players
 * could not be added (a race in the gap) — the organiser adds them from the booking's page.
 */
export type BookWithPlayersAnswer = {
  booking_id: string;
  balance_after_minutes: number;
  players?: AddPlayersAnswer | null;
  players_error?: string | null;
};

export type BulkWithPlayersAnswer = MemberBulkBookResponse & {
  players?: { booking_id: string; players: AddPlayersAnswer | null; players_error: string | null }[];
};

/** One seat on the booking detail. */
export type DetailPlayer = {
  participant_id: string | null;
  seat: number;
  team: Team;
  kind: ParticipantKind;
  user_id: string | null;
  name: string | null;
  photo_url: string | null;
  status: ParticipantStatus;
  share_minutes: number;
  weight: number;
  consented_minutes: number;
  paid_minutes: number;
  target_minutes: number;
  unpaid_minutes: number;
  /**
   * R2 F2-4 — share credits that came BACK to this seat (paid_minutes nets them out, so a
   * cancelled game read "paid 0"). Optional: an older server does not send it.
   */
  returned_minutes?: number;
  needs_consent: boolean;
  settled_outside: boolean;
  lapsed: boolean;
  checked_in_at: string | null;
  invited_at: string | null;
  responded_at: string | null;
};

/** R7 E7-5 — `payer`: paid for it at the court box; sees it read-only. */
export type ViewerRole = "organiser" | "player" | "admin" | "payer";

/** `GET /api/v1/bookings/{id}` — the booking as its players see it. */
export type BookingDetail = {
  booking_id: string;
  court_id: string;
  court_name: string | null;
  starts_at: string;
  ends_at: string;
  sold_ends_at: string;
  /** R9 J9-5 — the desk made this booking for the member (absent on an older server: read as false). */
  booked_by_club?: boolean;
  status: BookingStatusWord;
  /** R13 C13-1 — on a cancelled booking, who cancelled it ("member": the organiser; "club": an admin or the system). Null otherwise; absent on an older server. */
  cancelled_by?: "member" | "club" | null;
  /** R13 C13-1 — "displaced": the system cancelled and refunded it because an earlier booking's late check-in held the court. */
  cancel_cause?: "displaced" | null;
  /** R13 C13-1 — the admin's recorded reason on a club cancel; null otherwise. */
  cancel_reason?: string | null;
  split_mode: SplitMode;
  viewer: { role: ViewerRole; participant_id: string | null };
  organiser: { user_id: string | null; name: string | null; photo_url: string | null };
  players: DetailPlayer[];
  money: {
    price_minutes: number;
    organiser_owed_minutes: number;
    shares_received_minutes: number;
    organiser_net_minutes: number;
    /**
     * Every seat still owing, INCLUDING open link seats nobody has claimed yet (R1 contract §4).
     * The page shows this figure as it is — never a sum of the member seats it can see.
     */
    unpaid_minutes: number;
    share_deadline: string;
    is_split: boolean;
    /**
     * R5 M5-3 / M5-7 — on a cancelled or no-show game, the refund and the penalty rows posted on
     * the payer's wallet for it. Optional: until the API sends them they are read off the ledger's
     * shape (a refund of the whole charge, the penalty what the payer is left paying).
     */
    refunded_minutes?: number;
    penalty_minutes?: number;
    /** R6 E6-2 — whoever took the charge over at the court box (D10); null when the organiser paid. */
    paid_by?: { user_id: string; name: string | null; photo_url: string | null } | null;
    /** R6 E6-2 — what they paid; 0 when nobody did. */
    paid_by_minutes?: number;
  };
  /** R6 E6-6 — a no-show refunded in full because no box was reachable; not held against the member. */
  refunded_for_outage?: boolean;
  attendance: { checked_in_at: string | null; players_checked_in: number };
  permissions: {
    can_invite: boolean;
    can_change_split: boolean;
    can_cancel: boolean;
    can_accept: boolean;
    can_decline: boolean;
    can_withdraw: boolean;
    withdraw_closes_at: string;
  };
  /** The club's IANA zone — a cold entry point from a mail, so it names the club's day itself. Absent from an older API. */
  timezone?: string;
};

/** The cap a yes would break (D12): slots or minutes, with the club day's figures. */
export type PartnerCap =
  | { cap: "slots"; cap_slots: number; booked_slots: number; attempted_slots: number; club_day: string }
  | { cap: "minutes"; cap_minutes: number; already_booked_minutes: number; attempted_minutes: number; club_day: string }
  | { cap: string };

/**
 * `GET /api/v1/invites/{token}/preview` — ANONYMOUS (review round 1, B4). What a signed-out person
 * holding a shared link may see: exactly the invite mail's facts, no ids, no other players.
 * One `404 invite_not_found` for every way the seat is not open.
 */
export type InvitePreview = {
  organiser_first_name: string | null;
  court_name: string | null;
  starts_at: string;
  ends_at: string;
  share_minutes: number;
  timezone: string;
};

/**
 * `GET /api/v1/me/invites/{participantId}` — the caller's OWN seat in any state, with the
 * booking's status (review round 1, B4): what the mail's link says once the invite moved on.
 * Anybody else's seat is `404 invite_not_found`.
 */
export type MySeat = {
  participant_id: string;
  booking_id: string;
  status: ParticipantStatus;
  lapsed: boolean;
  settled_outside: boolean;
  booking_status: "booked" | "cancelled" | "no_show" | "completed" | "blocked";
  court_name: string | null;
  starts_at: string;
  ends_at: string;
  organiser_name: string | null;
  share_minutes: number;
  timezone: string;
  /** R15 J15-1 (BE15b) — the club, not the organiser, put this member on the game. Absent: an older API. */
  added_by_club?: boolean;
  /** R15 J15-1 (BE15b) — on a removed seat: whose act it was. Null / absent: not removed, no record, or an older API. */
  removed_by?: SeatRemovedBy | null;
};

/** R15 J15-1 — who took a member off a game: the club (an admin) or the organiser. */
export type SeatRemovedBy = "club" | "organiser";

/** R15 J15-1 — a removal's actor as the wire says it; anything else (or nothing) is unknown. */
export function removedByOf(raw: unknown): SeatRemovedBy | null {
  return raw === "club" || raw === "organiser" ? raw : null;
}

/**
 * One invite, as the accept sheet reads it — also the answer to opening a link.
 *
 * <p>
 * <b>`balance_minutes` is the RAW balance</b> (contract update, 2026-09-28): the backend makes it
 * mean the raw balance everywhere, with `spendable_minutes` and `held_minutes` always beside
 * it. Every "balance after" and "enough to accept" figure is built on `spendable_minutes` —
 * use {@link inviteMoney}, never `balance_minutes` or the server's `balance_after_minutes`.
 * </p>
 */
export type Invite = {
  participant_id: string;
  booking_id: string;
  status: ParticipantStatus;
  seat: number;
  team: Team;
  open_link: boolean;
  court_name: string | null;
  starts_at: string;
  ends_at: string;
  organiser: { user_id: string | null; name: string | null; photo_url: string | null };
  /** How many live seats the game has. */
  players: number;
  share_minutes: number;
  to_pay_minutes: number;
  needs_consent: boolean;
  /**
   * R14 J14-9 — what the seat last said yes to. 0 with `needs_consent`: the club accepted the seat
   * without asking, so nothing was agreed and nothing "went up". Absent (an older API): read as agreed.
   */
  consented_minutes?: number;
  balance_minutes: number;
  /** What the accept checks: the balance less what is held. Optional only for an older API. */
  spendable_minutes?: number;
  held_minutes: number;
  /** P11 — owed back to the member's own partners, paid from their next credit. Absent: 0. */
  owed_back_minutes?: number;
  balance_after_minutes: number;
  short_by_minutes: number;
  share_deadline: string;
  cap: PartnerCap | null;
  /** The club's IANA zone — the link view is opened cold from a mail. Absent from an older API. */
  timezone?: string;
  /** R15 J15-1 (BE15b) — the club put this member on the game, not the organiser. Absent: an older API (read as the organiser). */
  added_by_club?: boolean;
};

/**
 * The accept sheet's figures, on the SPENDABLE credits. Against an older API that sent no
 * `spendable_minutes`, the spendable figure is the balance less what is held.
 */
export function inviteMoney(
  invite: Pick<Invite, "balance_minutes" | "spendable_minutes" | "held_minutes" | "owed_back_minutes" | "to_pay_minutes">,
) {
  const held = invite.held_minutes ?? 0;
  const owedBack = invite.owed_back_minutes ?? 0;
  // P11: spendable is balance − held − owed back, and may be negative.
  const spendable = typeof invite.spendable_minutes === "number" ? invite.spendable_minutes : invite.balance_minutes - held - owedBack;
  const toPay = invite.to_pay_minutes;
  return { spendable, toPay, after: spendable - toPay, shortBy: Math.max(0, toPay - spendable), held, owedBack };
}

export type AcceptAnswer = {
  participant_id: string;
  booking_id: string;
  status: ParticipantStatus;
  share_minutes: number;
  consented_minutes: number;
  paid_minutes: number;
  /** The RAW balance after; `spendable_minutes` beside it where the server sends it. */
  balance_minutes: number;
  spendable_minutes?: number;
  held_minutes?: number;
  owed_back_minutes?: number;
};

export type SeatAnswer = { participant_id: string; status: ParticipantStatus };
/**
 * P11 — an admin remove or settle-outside. `return_waiting` is true when the partner's return
 * could not be paid because the organiser's balance could not cover it: NO money has moved yet,
 * and `return_minutes` is what goes back once it is covered. Absent from an older API.
 */
export type ReturnAnswer = SeatAnswer & { return_waiting?: boolean; return_minutes?: number | null };
export type NudgeAnswer = { participant_id: string; nudges_left: number };
export type LinkAnswer = { participant_id: string; invite_token: string; invite_path: string };

export type SplitChange = {
  mode: SplitMode;
  seats: { participantId: string; weight?: number; amount?: number }[];
};
export type SplitChangeAnswer = {
  booking_id: string;
  split_mode: SplitMode;
  shares: { participant_id: string; seat: number; share_minutes: number; weight: number; needs_consent: boolean }[];
};

export type RecentPartner = PublicMember & { last_played_at: string; games: number };

/* ─────────────────────────────── the inbox ─────────────────────────────── */

export type MemberNotificationKind =
  | "players.invited"
  | "players.share_moved"
  | "players.reminder"
  | "players.lapsed"
  | "players.game_cancelled"
  | "players.game_changed"
  | "players.response"
  | "players.return_waiting"
  | "players.club_seat"
  | (string & {});

export type MemberNotification = {
  id: string;
  kind: MemberNotificationKind;
  headline: string;
  /** An app path (`/bookings/{id}`, `/invites/{pid}`), or null. */
  link: string | null;
  booking_id: string | null;
  created_at: string;
  read_at: string | null;
  /**
   * R2 F2-5 — set when the notice no longer asks anything (a "result to confirm" whose result was
   * confirmed, disputed, edited, withdrawn or voided). Absent from an older API: the row then reads
   * as before.
   */
  resolved_at?: string | null;
};

export type MemberNotificationPage = {
  items: MemberNotification[];
  unread_count: number;
  next_cursor: string | null;
  /** The club's IANA zone. Absent from an older API. */
  timezone?: string;
};

/* ─────────────────────────────── preferences (D13) ─────────────────────────────── */

/** The social half of `/me/preferences`. Both off by default; both opt-in. */
export type SocialPrefs = {
  findable: boolean;
  show_in_leaderboards: boolean;
};

/* ─────────────────────────────── admin (god mode) ─────────────────────────────── */

export type AdminAddPlayer = { userId?: string; guestName?: string; accepted?: boolean; reason?: string };
export type CollectAnswer = { participant_id: string; collected_minutes: number; balance_after_minutes: number };

/* ─────────────────────────────── routes ─────────────────────────────── */

const seat = (bookingId: string, participantId: string) =>
  `/api/v1/bookings/${bookingId}/players/${participantId}`;
const adminSeat = (bookingId: string, participantId: string) =>
  `/api/v1/admin/bookings/${bookingId}/players/${participantId}`;

function notificationsPath(cursor?: string | null, limit = 20): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return `/api/v1/me/notifications?${params.toString()}`;
}

export const playersEndpoints = {
  /* booking with players — the same routes a plain booking uses, with the players payload */
  bookWithPlayers: (body: { courtId: string; startsAt: string; sliceCount: number } & PlayersPayload) =>
    api.post<BookWithPlayersAnswer>("/api/v1/bookings/", body),
  /**
   * The member bulk route with the players payload, applied to every booked item. All-or-nothing:
   * the split is checked against EVERY item's price before anything is booked.
   */
  bulkWithPlayers: (body: { idempotencyKey: string; items: BulkBookItemBody[] } & PlayersPayload) =>
    api.post<BulkWithPlayersAnswer>("/api/v1/bookings/bulk", body),
  splitPreview: (body: SplitPreviewRequest) => api.post<SplitPreview>("/api/v1/players/split-preview", body),

  /* the detail and the organiser's hand */
  detail: (bookingId: string) => api.get<BookingDetail>(`/api/v1/bookings/${bookingId}`),
  add: (bookingId: string, body: PlayersPayload) => api.post<AddPlayersAnswer>(`/api/v1/bookings/${bookingId}/players`, body),
  remove: (bookingId: string, participantId: string) => api.del<SeatAnswer>(seat(bookingId, participantId)),
  nudge: (bookingId: string, participantId: string) => api.post<NudgeAnswer>(`${seat(bookingId, participantId)}/nudge`),
  /** Rotates: the previous link for this seat stops working. */
  link: (bookingId: string, participantId: string) => api.post<LinkAnswer>(`${seat(bookingId, participantId)}/link`),
  changeSplit: (bookingId: string, body: SplitChange) => api.put<SplitChangeAnswer>(`/api/v1/bookings/${bookingId}/split`, body),

  /* the partner's hand — accept names the share the partner was SHOWN */
  accept: (bookingId: string, participantId: string, expectedShareMinutes: number) =>
    api.post<AcceptAnswer>(`${seat(bookingId, participantId)}/accept`, { expectedShareMinutes }),
  decline: (bookingId: string, participantId: string) => api.post<SeatAnswer>(`${seat(bookingId, participantId)}/decline`),
  withdraw: (bookingId: string, participantId: string) => api.post<SeatAnswer>(`${seat(bookingId, participantId)}/withdraw`),

  /* invites */
  myInvites: () => api.get<{ items: Invite[]; count: number; timezone?: string }>("/api/v1/me/invites"),
  invite: (token: string) => api.get<Invite>(`/api/v1/invites/${encodeURIComponent(token)}`),
  invitePreview: (token: string) => api.get<InvitePreview>(`/api/v1/invites/${encodeURIComponent(token)}/preview`),
  mySeat: (participantId: string) => api.get<MySeat>(`/api/v1/me/invites/${encodeURIComponent(participantId)}`),
  acceptLink: (token: string, expectedShareMinutes: number) =>
    api.post<AcceptAnswer>(`/api/v1/invites/${encodeURIComponent(token)}/accept`, { expectedShareMinutes }),
  declineLink: (token: string) => api.post<SeatAnswer>(`/api/v1/invites/${encodeURIComponent(token)}/decline`),

  /* partners */
  recent: () => api.get<{ items: RecentPartner[] }>("/api/v1/me/partners/recent"),
  favourites: () => api.get<{ items: PublicMember[] }>("/api/v1/me/partners/favourites"),
  star: (userId: string) => api.put<{ user_id: string; favourite: boolean }>(`/api/v1/me/partners/favourites/${userId}`),
  unstar: (userId: string) => api.del<{ user_id: string; favourite: boolean }>(`/api/v1/me/partners/favourites/${userId}`),
  /** ≥ 2 characters; `400 query_too_short`, `429 directory_rate_limited`. */
  directory: (q: string) => api.get<{ items: PublicMember[] }>(`/api/v1/members/directory?q=${encodeURIComponent(q)}`),

  /* the member's inbox */
  notifications: (cursor?: string | null, limit?: number) => api.get<MemberNotificationPage>(notificationsPath(cursor, limit)),
  unreadCount: () => api.get<{ unread_count: number }>("/api/v1/me/notifications/unread-count"),
  markRead: (id: string) => api.post<{ id: string; read: boolean }>(`/api/v1/me/notifications/${id}/read`),
  markAllRead: () => api.post<{ marked: number }>("/api/v1/me/notifications/read-all"),

  /* D13 — the social preferences, off by default */
  socialPrefs: () => api.get<Partial<SocialPrefs>>("/api/v1/me/preferences"),
  saveSocialPrefs: (patch: Partial<SocialPrefs>) => api.put<Partial<SocialPrefs>>("/api/v1/me/preferences", patch),

  /* admin — every one lands in the change log, and all but the add need a reason */
  adminAdd: (bookingId: string, body: AdminAddPlayer) =>
    api.post<AddPlayersAnswer>(`/api/v1/admin/bookings/${bookingId}/players`, body),
  /**
   * After the share deadline, remove and settle-outside may need to take a partner below zero
   * too (a return the organiser cannot cover): they answer `400 overdraft_not_authorised`, which
   * the screen treats as a request to show the god-mode overdraft confirmation and resend with
   * `allowNegativeBalance`.
   */
  adminRemove: (bookingId: string, participantId: string, reason: string, allowNegativeBalance = false) =>
    api.post<ReturnAnswer>(`${adminSeat(bookingId, participantId)}/remove`, { reason, allowNegativeBalance }),
  adminAccept: (bookingId: string, participantId: string, reason: string) =>
    api.post<SeatAnswer>(`${adminSeat(bookingId, participantId)}/accept`, { reason }),
  adminSettleOutside: (bookingId: string, participantId: string, reason: string, allowNegativeBalance = false) =>
    api.post<ReturnAnswer>(`${adminSeat(bookingId, participantId)}/settle-outside`, { reason, allowNegativeBalance }),
  /** The only path that may take a partner below zero. `allowNegativeBalance` is sent on purpose. */
  adminCollect: (bookingId: string, participantId: string, reason: string) =>
    api.post<CollectAnswer>(`${adminSeat(bookingId, participantId)}/collect`, { reason, allowNegativeBalance: true }),
};
