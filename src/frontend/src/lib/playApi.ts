import { api } from "./api";

/**
 * P12 — the play wire (D14 MVP): match results on a booking, the member's own "My game"
 * (stats, the weekly streak, the injury pause, the court-time ring, badges), the one-shot
 * celebrations, and the admin's results console.
 *
 * <p>
 * <b>The contract is `docs/specs/play.md` §6</b>, and the shapes below are its JSON field for
 * field. As with P11: requests are camelCase and answers snake_case; a refusal is always
 * <code>{ error, …figures }</code>, which `playCopy.playRefusal` turns into a sentence; times are
 * ISO-8601 UTC; money never appears on this wire at all.
 * </p>
 *
 * <p>
 * <b>Nothing here is ever about another member</b> beyond a result on a booking both played
 * (§10): every `/me/play*` read is the caller's own, and the admin summary is counts only.
 * </p>
 */

/* ─────────────────────────────── vocabulary ─────────────────────────────── */

export type ResultStatus = "pending" | "confirmed" | "disputed" | "voided" | "withdrawn";
export type MatchFormat = "best_of_3" | "best_of_5";
export const MATCH_FORMATS: readonly MatchFormat[] = ["best_of_5", "best_of_3"];
export type Side = "a" | "b";
export type Outcome = "won" | "lost";

/** `u:{userId}` for a member, `g:{participantId}` for a guest (§3.2). */
export type PlayerKey = string;

/** One game's score, side A first. */
export type GameScore = { a: number; b: number };

/** A player in a lineup or a candidate for one (§6.1). A guest has no user id and no photo. */
export type ResultPlayer = {
  player_key: PlayerKey;
  kind: "member" | "guest";
  user_id: string | null;
  name: string;
  photo_url: string | null;
};

export type NamedMember = { user_id: string; name: string };

/**
 * `result` (§6.1). `viewer_*` is null for someone not in the lineup (an organiser who sat out);
 * `viewer_outcome` is computed whatever the status — only a confirmed one counts, so the card says
 * it for `confirmed` alone. `confirm_due_at` is set only while `pending`.
 */
export type MatchResult = {
  result_id: string;
  booking_id: string;
  status: ResultStatus;
  format: MatchFormat;
  games: GameScore[];
  games_won: { a: number; b: number };
  winner: Side;
  sides: { a: ResultPlayer[]; b: ResultPlayer[] };
  submitted_by: NamedMember;
  submitted_at: string;
  edited_at: string | null;
  version: number;
  confirm_due_at: string | null;
  confirmed_at: string | null;
  auto_confirmed: boolean;
  confirmed_by: NamedMember | null;
  disputed_at: string | null;
  disputed_by: NamedMember | null;
  dispute_note: string | null;
  closed_at: string | null;
  closed_by_admin: boolean;
  viewer_side: Side | null;
  viewer_outcome: Outcome | null;
};

/** `not_started` (review round 1, B15): results open at the court time's start or the check-in, whichever is later. */
export type NotRecordableReason = "not_checked_in" | "not_started" | "window_closed" | "not_enough_players";

export type ResultPermissions = {
  can_record: boolean;
  can_edit: boolean;
  can_confirm: boolean;
  can_dispute: boolean;
  can_withdraw: boolean;
};

/**
 * `GET /api/v1/bookings/{id}/result`. `timezone` is the club's IANA zone — a cold entry point
 * (the confirm mail links here), so the API client learns the club's day from it.
 */
export type BookingResultView = {
  booking_id: string;
  timezone: string;
  result: MatchResult | null;
  permissions: ResultPermissions;
  not_recordable_reason: NotRecordableReason | null;
  record_closes_at: string | null;
  candidates: ResultPlayer[];
  default_sides: { a: PlayerKey[]; b: PlayerKey[] };
  default_format: MatchFormat;
};

/** The create body. The edit is the same without the key and with `expectedVersion`. */
export type ResultDraftBody = {
  format: MatchFormat;
  sideA: PlayerKey[];
  sideB: PlayerKey[];
  games: GameScore[];
};

/* ─────────────────────────────── My game ─────────────────────────────── */

export type PlaySettings = { monthly_goal_minutes: number | null; celebrations_enabled: boolean };

export type Ring = { month: string; goal_minutes: number; attended_minutes: number; sessions: number; reached: boolean };

export type WeekState = "attended" | "rest" | "paused" | "missed" | "pending";

export type Streak = {
  current_weeks: number;
  longest_weeks: number;
  rest_weeks_banked: number;
  rest_every_weeks: number;
  rest_cap: number;
  this_week: WeekState;
  /** The last 12 weeks, oldest first. */
  weeks: { week_start: string; state: WeekState }[];
};

export type Pause = { active: boolean; started_at: string | null; weeks_used_this_year: number; weeks_per_year: number };

export type PlayStatsFigures = {
  sessions_attended: number;
  minutes_on_court: number;
  minutes_this_year: number;
  matches_played: number;
  matches_won: number;
  matches_lost: number;
  games_won: number;
  games_lost: number;
  win_rate_percent: number | null;
};

export type Partner = { user_id: string; name: string; photo_url: string | null; sessions: number };
export type Opponent = { user_id: string; name: string; photo_url: string | null; matches: number; won: number; lost: number };
export type FormEntry = { result_id: string; booking_id: string; starts_at: string; outcome: Outcome };

export type BadgeView = {
  key: string;
  name: string;
  description: string;
  earned: boolean;
  awarded_at: string | null;
  progress: { value: number; target: number } | null;
};

/** `GET /api/v1/me/play` — the whole section in one read. */
export type MyPlay = {
  as_of: string;
  timezone: string;
  settings: PlaySettings;
  ring: Ring | null;
  streak: Streak;
  pause: Pause;
  stats: PlayStatsFigures;
  partners: Partner[];
  opponents: Opponent[];
  form: FormEntry[];
  badges: BadgeView[];
};

/** A row of `GET /me/play/results`: the result, and where and when it was played. */
export type MyResultRow = MatchResult & { court_name: string | null; starts_at: string };
export type MyResultsPage = { timezone: string; items: MyResultRow[]; next_cursor: string | null };

export type CelebrationKind = "badge" | "goal_reached";
export type Celebration = {
  id: string;
  kind: CelebrationKind;
  badge: { key: string; name: string; description: string } | null;
  month: string | null;
  goal_minutes: number | null;
  created_at: string;
};

/** `GET /me/play/celebrations` — unseen, oldest first, at most 10, with the club's zone. */
export type CelebrationsPage = { timezone: string; items: Celebration[] };

/* ─────────────────────────────── admin ─────────────────────────────── */

/** `admin_result` (§6.3): the result without `viewer_*`, with where, when and whose booking. */
export type AdminResult = Omit<MatchResult, "viewer_side" | "viewer_outcome"> & {
  court_name: string | null;
  starts_at: string;
  organiser: { user_id: string | null; name: string | null };
};

export type AdminResultsFilter = "disputed" | "pending" | "confirmed" | "voided" | "withdrawn" | "all";
export type AdminResultsPage = { items: AdminResult[]; next_cursor: string | null; count: number };

/** `GET /admin/members/{userId}/play` — counts only (§6.3, §14 Q3). */
export type AdminMemberPlay = {
  sessions_attended: number;
  minutes_this_month: number;
  minutes_all_time: number;
  current_streak_weeks: number;
  matches_played: number;
  matches_won: number;
  matches_lost: number;
  open_disputes: number;
  badges_earned: number;
};

/* ─────────────────────────────── routes ─────────────────────────────── */

const result = (bookingId: string) => `/api/v1/bookings/${encodeURIComponent(bookingId)}/result`;

function paged(path: string, params: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

export const playEndpoints = {
  /* results on a booking (§6.1) */
  bookingResult: (bookingId: string) => api.get<BookingResultView>(result(bookingId)),
  record: (bookingId: string, body: ResultDraftBody & { idempotencyKey: string }) =>
    api.post<MatchResult>(result(bookingId), body),
  edit: (bookingId: string, body: ResultDraftBody & { expectedVersion: number }) =>
    api.put<MatchResult>(result(bookingId), body),
  confirm: (bookingId: string, expectedVersion: number) =>
    api.post<MatchResult>(`${result(bookingId)}/confirm`, { expectedVersion }),
  dispute: (bookingId: string, expectedVersion: number, note?: string) =>
    api.post<MatchResult>(`${result(bookingId)}/dispute`, note ? { expectedVersion, note } : { expectedVersion }),
  withdraw: (bookingId: string, expectedVersion: number) =>
    api.post<MatchResult>(`${result(bookingId)}/withdraw`, { expectedVersion }),

  /* My game (§6.2) */
  myPlay: () => api.get<MyPlay>("/api/v1/me/play"),
  /** Absent = unchanged; `monthlyGoalMinutes: null` removes the goal. */
  saveSettings: (patch: { monthlyGoalMinutes?: number | null; celebrationsEnabled?: boolean }) =>
    api.put<PlaySettings>("/api/v1/me/play/settings", patch),
  startPause: () => api.post<Pause>("/api/v1/me/play/pause", {}),
  endPause: () => api.del<Pause>("/api/v1/me/play/pause"),
  myResults: (cursor?: string | null, limit = 20) => api.get<MyResultsPage>(paged("/api/v1/me/play/results", { cursor, limit })),
  celebrations: () => api.get<CelebrationsPage>("/api/v1/me/play/celebrations"),
  celebrationsSeen: (ids: string[]) => api.post<{ seen: number }>("/api/v1/me/play/celebrations/seen", { ids }),

  /* admin (§6.3) — every write lands in the change record */
  adminResults: (status: AdminResultsFilter, cursor?: string | null, limit = 50) =>
    api.get<AdminResultsPage>(paged("/api/v1/admin/play/results", { status, cursor, limit })),
  adminDisputedCount: () => api.get<{ count: number }>("/api/v1/admin/play/results/disputed/count"),
  adminVoid: (resultId: string, reason: string) =>
    api.post<AdminResult>(`/api/v1/admin/play/results/${encodeURIComponent(resultId)}/void`, { reason }),
  adminUphold: (resultId: string, reason: string) =>
    api.post<AdminResult>(`/api/v1/admin/play/results/${encodeURIComponent(resultId)}/uphold`, { reason }),
  adminMemberPlay: (userId: string) =>
    api.get<AdminMemberPlay>(`/api/v1/admin/members/${encodeURIComponent(userId)}/play`),
};
