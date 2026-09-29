import { signIn, stubFetch, type StubRoute } from "@/test/harness";
import type {
  AdminResult, BadgeView, BookingResultView, Celebration, MatchResult, MyPlay, ResultPlayer,
} from "@/lib/playApi";

/**
 * The play feature's test kit: the backend's shapes field for field (`play.md` §6), the people
 * of one singles game, and the routes a signed-in render needs. The same names and figures as
 * `e2e/playKit.ts`, so a unit test and a browser test describe the same game.
 */

export const ME = "44444444-4444-4444-4444-444444444444"; // the harness's signed-in user
export const SAM = "55555555-5555-5555-5555-555555555555";
export const BOOKING = "b0000000-0000-0000-0000-0000000000a1";
export const RESULT_ID = "r0000000-0000-0000-0000-0000000000a1";
export const RESULT_PATH = `/api/v1/bookings/${BOOKING}/result`;

export const NOMSA: ResultPlayer = { player_key: `u:${ME}`, kind: "member", user_id: ME, name: "Nomsa Khumalo", photo_url: null };
export const SAM_P: ResultPlayer = { player_key: `u:${SAM}`, kind: "member", user_id: SAM, name: "Sam Petersen", photo_url: null };
export const GUEST: ResultPlayer = { player_key: "g:p-guest", kind: "guest", user_id: null, name: "Jo (guest)", photo_url: null };

// Wednesday 30 September 2026, 18:00–18:45 in Johannesburg (UTC+2).
export const STARTS = "2026-09-30T16:00:00Z";

export function result(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    result_id: RESULT_ID, booking_id: BOOKING, status: "pending", format: "best_of_5",
    games: [{ a: 11, b: 7 }, { a: 9, b: 11 }, { a: 11, b: 5 }, { a: 11, b: 8 }],
    games_won: { a: 3, b: 1 }, winner: "a",
    sides: { a: [NOMSA], b: [SAM_P] },
    submitted_by: { user_id: ME, name: "Nomsa Khumalo" },
    submitted_at: "2026-09-30T17:00:00Z", edited_at: null, version: 1,
    confirm_due_at: "2026-10-02T17:00:00Z", confirmed_at: null, auto_confirmed: false, confirmed_by: null,
    disputed_at: null, disputed_by: null, dispute_note: null, closed_at: null, closed_by_admin: false,
    viewer_side: "a", viewer_outcome: "won",
    ...overrides,
  };
}

const NO_HANDS = { can_record: false, can_edit: false, can_confirm: false, can_dispute: false, can_withdraw: false };

export function view(overrides: Partial<BookingResultView> = {}): BookingResultView {
  return {
    booking_id: BOOKING, timezone: "Africa/Johannesburg", result: null,
    permissions: { ...NO_HANDS, can_record: true },
    not_recordable_reason: null, record_closes_at: "2026-10-07T16:45:00Z",
    candidates: [NOMSA, SAM_P],
    default_sides: { a: [NOMSA.player_key], b: [SAM_P.player_key] },
    default_format: "best_of_5",
    ...overrides,
  };
}

/** Sam's view of Nomsa's pending 3–1: the confirming side. */
export function samView(overrides: Partial<BookingResultView> = {}): BookingResultView {
  return view({
    result: result({ viewer_side: "b", viewer_outcome: "lost" }),
    permissions: { ...NO_HANDS, can_confirm: true, can_dispute: true },
    ...overrides,
  });
}

/** Nomsa's own view of her pending 3–1: the submitting side. */
export function submitterView(overrides: Partial<BookingResultView> = {}): BookingResultView {
  return view({ result: result(), permissions: { ...NO_HANDS, can_edit: true, can_withdraw: true }, ...overrides });
}

export function badge(overrides: Partial<BadgeView> = {}): BadgeView {
  return {
    key: "sessions_50", name: "Regular", description: "Played 50 sessions.", earned: true,
    awarded_at: "2026-08-14T05:31:00Z", progress: null, ...overrides,
  };
}

const WEEKS = ["07-13", "07-20", "07-27", "08-03", "08-10", "08-17", "08-24", "08-31", "09-07", "09-14", "09-21", "09-28"];

export function myPlay(overrides: Partial<MyPlay> = {}): MyPlay {
  return {
    as_of: "2026-09-29T17:02:11Z", timezone: "Africa/Johannesburg",
    settings: { monthly_goal_minutes: 600, celebrations_enabled: true },
    ring: { month: "2026-09", goal_minutes: 600, attended_minutes: 405, sessions: 9, reached: false },
    streak: {
      current_weeks: 6, longest_weeks: 11, rest_weeks_banked: 1, rest_every_weeks: 4, rest_cap: 2, this_week: "pending",
      weeks: WEEKS.map((d, i) => ({
        week_start: `2026-${d}`,
        state: i === 11 ? "pending" : i === 4 ? "rest" : i === 2 ? "paused" : i === 1 ? "missed" : "attended",
      })),
    },
    pause: { active: false, started_at: null, weeks_used_this_year: 2, weeks_per_year: 8 },
    stats: {
      sessions_attended: 58, minutes_on_court: 2610, minutes_this_year: 1980,
      matches_played: 21, matches_won: 12, matches_lost: 9, games_won: 47, games_lost: 39, win_rate_percent: 57,
    },
    partners: [{ user_id: SAM, name: "Sam Petersen", photo_url: null, sessions: 14 }],
    opponents: [{ user_id: SAM, name: "Sam Petersen", photo_url: null, matches: 6, won: 4, lost: 2 }],
    form: [
      { result_id: "f1", booking_id: BOOKING, starts_at: STARTS, outcome: "won" },
      { result_id: "f2", booking_id: BOOKING, starts_at: "2026-09-23T16:00:00Z", outcome: "lost" },
    ],
    badges: [
      badge(),
      badge({ key: "sessions_100", name: "Centurion", description: "Played 100 sessions.", earned: false, awarded_at: null, progress: { value: 58, target: 100 } }),
      badge({ key: "night_owl", name: "Night owl", description: "Played a session that started at 21:00 or later.", earned: false, awarded_at: null }),
    ],
    ...overrides,
  };
}

export function celebration(overrides: Partial<Celebration> = {}): Celebration {
  return {
    id: "c1", kind: "badge", badge: { key: "first_win", name: "First win", description: "Won a match." },
    month: null, goal_minutes: null, created_at: "2026-09-29T17:00:00Z", ...overrides,
  };
}

export function adminResult(overrides: Partial<AdminResult> = {}): AdminResult {
  const { viewer_side: _side, viewer_outcome: _outcome, ...rest } = result({
    status: "disputed", disputed_at: "2026-09-30T18:00:00Z", disputed_by: { user_id: SAM, name: "Sam Petersen" },
    dispute_note: "It was 3–2, not 3–1.",
  });
  void _side; void _outcome;
  return { ...rest, court_name: "Court 1", starts_at: STARTS, organiser: { user_id: ME, name: "Nomsa Khumalo" }, ...overrides };
}

/** The session and the shell's reads every signed-in render makes, then the page's own routes. */
export function serve(routes: StubRoute[] = [], options: { admin?: boolean } = {}) {
  const session = signIn({ isAdmin: options.admin ?? false });
  return stubFetch([
    { path: "/api/v1/whoami", body: session },
    { path: "/api/v1/wallet", body: { balance_credits: 100, held_credits: 0, spendable_credits: 100, held_until: null, entries: [] } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 0 } },
    ...routes,
  ]);
}
