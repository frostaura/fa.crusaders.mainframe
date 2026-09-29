import { BOOKING, ME, PEOPLE, SAM, tomorrowAt } from "./playersKit";

/**
 * P12 — shared fixtures for the `play-*.spec.ts` specs: one singles game between Nomsa (the
 * signed-in member) and Sam, its result in each state, and "My game" as `GET /me/play` serves
 * it. The same people and figures as `src/components/play/__tests__/playKit.ts`, so a unit test
 * and a browser test describe the same game. Shapes are `docs/specs/play.md` §6, field for field.
 */

export { BOOKING, ME, SAM };
export const RESULT_ID = "r0000000-0000-0000-0000-0000000000a1";
export const RESULT_PATH = `/api/v1/bookings/${BOOKING}/result`;

export const NOMSA = { player_key: `u:${ME}`, kind: "member", user_id: ME, name: PEOPLE.me.name, photo_url: null };
export const SAM_P = { player_key: `u:${SAM}`, kind: "member", user_id: SAM, name: PEOPLE.sam.name, photo_url: null };

type Json = Record<string, unknown>;

const NO_HANDS = { can_record: false, can_edit: false, can_confirm: false, can_dispute: false, can_withdraw: false };

export function resultFixture(overrides: Json = {}): Json {
  return {
    result_id: RESULT_ID, booking_id: BOOKING, status: "pending", format: "best_of_5",
    games: [{ a: 11, b: 7 }, { a: 9, b: 11 }, { a: 11, b: 5 }, { a: 11, b: 8 }],
    games_won: { a: 3, b: 1 }, winner: "a",
    sides: { a: [NOMSA], b: [SAM_P] },
    submitted_by: { user_id: ME, name: PEOPLE.me.name },
    submitted_at: new Date().toISOString(), edited_at: null, version: 1,
    confirm_due_at: tomorrowAt(20), confirmed_at: null, auto_confirmed: false, confirmed_by: null,
    disputed_at: null, disputed_by: null, dispute_note: null, closed_at: null, closed_by_admin: false,
    viewer_side: "a", viewer_outcome: "won",
    ...overrides,
  };
}

export function viewFixture(overrides: Json = {}): Json {
  return {
    booking_id: BOOKING, timezone: "Africa/Johannesburg", result: null,
    permissions: { ...NO_HANDS, can_record: true },
    not_recordable_reason: null, record_closes_at: tomorrowAt(21),
    candidates: [NOMSA, SAM_P],
    default_sides: { a: [NOMSA.player_key], b: [SAM_P.player_key] },
    default_format: "best_of_5",
    ...overrides,
  };
}

/**
 * A tiny in-memory result server for one booking, shared by both players' pages: record,
 * confirm, dispute, withdraw — each answers with the result as it now stands, and the next read
 * from EITHER side agrees, with that side's own hand and outcome.
 */
export function resultServer() {
  const state: { result: Json | null } = { result: null };
  const perms = (viewer: Viewer): Json => {
    const r = state.result;
    if (!r || r.status === "voided" || r.status === "withdrawn") return { ...NO_HANDS, can_record: true };
    if (r.status !== "pending") return NO_HANDS;
    return viewer === "nomsa"
      ? { ...NO_HANDS, can_edit: true, can_withdraw: true }
      : { ...NO_HANDS, can_confirm: true, can_dispute: true };
  };
  const seen = (viewer: Viewer): Json | null => (state.result
    ? { ...state.result, viewer_side: viewer === "nomsa" ? "a" : "b", viewer_outcome: viewer === "nomsa" ? "won" : "lost" }
    : null);
  const move = (viewer: Viewer, patch: Json) => {
    state.result = { ...(state.result ?? {}), ...patch, version: Number(state.result?.version ?? 0) + 1 };
    return seen(viewer);
  };
  const routesFor = (viewer: Viewer) => [
    { path: RESULT_PATH, respond: () => viewFixture({ result: seen(viewer), permissions: perms(viewer) }) },
    {
      method: "POST", path: RESULT_PATH,
      respond: ({ body }: { body: unknown }) => {
        const sent = body as { format: string; games: { a: number; b: number }[] };
        state.result = resultFixture({ format: sent.format, games: sent.games, version: 1 });
        return seen(viewer);
      },
    },
    {
      method: "POST", path: `${RESULT_PATH}/confirm`,
      respond: () => move(viewer, { status: "confirmed", confirmed_by: { user_id: SAM, name: PEOPLE.sam.name }, confirm_due_at: null }),
    },
    {
      method: "POST", path: `${RESULT_PATH}/dispute`,
      respond: ({ body }: { body: unknown }) => move(viewer, {
        status: "disputed", disputed_by: { user_id: SAM, name: PEOPLE.sam.name }, dispute_note: (body as { note?: string }).note ?? null,
      }),
    },
    { method: "POST", path: `${RESULT_PATH}/withdraw`, respond: () => move(viewer, { status: "withdrawn" }) },
  ];
  return { state, routesFor };
}

type Viewer = "nomsa" | "sam";

const WEEKS = ["07-13", "07-20", "07-27", "08-03", "08-10", "08-17", "08-24", "08-31", "09-07", "09-14", "09-21", "09-28"];

export function myPlayFixture(overrides: Json = {}): Json {
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
    partners: [{ user_id: SAM, name: PEOPLE.sam.name, photo_url: null, sessions: 14 }],
    opponents: [{ user_id: SAM, name: PEOPLE.sam.name, photo_url: null, matches: 6, won: 4, lost: 2 }],
    form: [
      { result_id: "f1", booking_id: BOOKING, starts_at: tomorrowAt(18), outcome: "won" },
      { result_id: "f2", booking_id: BOOKING, starts_at: tomorrowAt(17), outcome: "lost" },
    ],
    badges: [
      { key: "first_session", name: "First court", description: "Played your first session at the club.", earned: true, awarded_at: "2026-03-02T05:31:00Z", progress: null },
      { key: "sessions_50", name: "Regular", description: "Played 50 sessions.", earned: true, awarded_at: "2026-08-14T05:31:00Z", progress: null },
      { key: "sessions_100", name: "Centurion", description: "Played 100 sessions.", earned: false, awarded_at: null, progress: { value: 58, target: 100 } },
      { key: "streak_12", name: "Twelve-week streak", description: "Played every week for 12 weeks.", earned: false, awarded_at: null, progress: { value: 11, target: 12 } },
      { key: "early_bird", name: "Early bird", description: "Played a session that started before 07:00.", earned: false, awarded_at: null, progress: null },
      { key: "night_owl", name: "Night owl", description: "Played a session that started at 21:00 or later.", earned: true, awarded_at: "2026-05-20T19:10:00Z", progress: null },
    ],
    ...overrides,
  };
}

export function celebrationFixture(overrides: Json = {}): Json {
  return {
    id: "c1", kind: "badge", badge: { key: "first_win", name: "First win", description: "Won a match." },
    month: null, goal_minutes: null, created_at: new Date().toISOString(), ...overrides,
  };
}
