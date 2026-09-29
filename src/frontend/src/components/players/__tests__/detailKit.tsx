import { Route, Routes } from "react-router-dom";
import BookingDetailPage from "@/pages/BookingDetail";
import { renderPage, signIn, stubFetch, type StubRoute } from "@/test/harness";
import type { BookingDetail, DetailPlayer } from "@/lib/playersApi";

/**
 * The booking page's test kit: the backend's detail view field for field (a 100 cr court, four
 * players, an equal split — the same figures as `e2e/playersKit.ts`), the routes a signed-in
 * render needs, and a render at `/bookings/:bookingId` beside the pages its links lead to.
 */

export const ME = "44444444-4444-4444-4444-444444444444"; // the harness's signed-in user
export const SAM = "55555555-5555-5555-5555-555555555555";
export const ALEX = "66666666-6666-6666-6666-666666666666";
export const BOOKING = "b0000000-0000-0000-0000-000000000001";
export const DETAIL_PATH = `/api/v1/bookings/${BOOKING}`;
export const PID = {
  me: "p0000000-0000-0000-0000-000000000001",
  sam: "p0000000-0000-0000-0000-000000000002",
  alex: "p0000000-0000-0000-0000-000000000003",
  open: "p0000000-0000-0000-0000-000000000004",
};

// Wednesday 30 September 2026, 18:00–18:45 in Johannesburg (UTC+2).
export const STARTS = "2026-09-30T16:00:00Z";
export const ENDS = "2026-09-30T16:45:00Z";
export const DEADLINE = "2026-10-02T18:45:00Z";

export function seat(overrides: Partial<DetailPlayer> = {}): DetailPlayer {
  return {
    participant_id: PID.me, seat: 1, team: "A", kind: "organiser", user_id: ME, name: "Nomsa Khumalo", photo_url: null,
    status: "accepted", share_credits: 25, weight: 1, consented_credits: 0, paid_credits: 0, target_credits: 0, unpaid_credits: 0,
    needs_consent: false, settled_outside: false, lapsed: false, checked_in_at: null,
    invited_at: "2026-09-28T08:00:00Z", responded_at: "2026-09-28T08:00:00Z",
    ...overrides,
  };
}

export const SAM_SEAT = seat({
  participant_id: PID.sam, seat: 2, kind: "member", user_id: SAM, name: "Sam Petersen",
  consented_credits: 25, paid_credits: 25, target_credits: 25,
});
export const ALEX_SEAT = seat({
  participant_id: PID.alex, seat: 3, team: "B", kind: "member", user_id: ALEX, name: "Alex Naidoo", status: "invited", unpaid_credits: 25,
});
export const OPEN_SEAT = seat({ participant_id: PID.open, seat: 4, team: "B", kind: "open_link", user_id: null, name: null, status: "invited" });

export function detail(overrides: Partial<BookingDetail> = {}): BookingDetail {
  return {
    booking_id: BOOKING, court_id: "c0000000-0000-0000-0000-000000000001", court_name: "Court 1",
    starts_at: STARTS, ends_at: ENDS, sold_ends_at: ENDS, status: "booked", split_mode: "equal",
    viewer: { role: "organiser", participant_id: PID.me },
    organiser: { user_id: ME, name: "Nomsa Khumalo", photo_url: null },
    players: [seat(), SAM_SEAT, ALEX_SEAT, OPEN_SEAT],
    money: {
      price_credits: 100, organiser_owed_credits: 100, shares_received_credits: 25, organiser_net_credits: 75,
      unpaid_credits: 25, share_deadline: DEADLINE, is_split: true,
    },
    attendance: { checked_in_at: null, players_checked_in: 0 },
    permissions: {
      can_invite: true, can_change_split: true, can_cancel: true, can_accept: false, can_decline: false,
      can_withdraw: false, withdraw_closes_at: "2026-09-30T14:00:00Z",
    },
    ...overrides,
  };
}

/** Alex's view of the same game: a player, invited, able to accept or decline. */
export function playerView(overrides: Partial<BookingDetail> = {}): BookingDetail {
  return detail({
    viewer: { role: "player", participant_id: PID.alex },
    organiser: { user_id: SAM, name: "Sam Petersen", photo_url: null },
    permissions: {
      can_invite: false, can_change_split: false, can_cancel: false, can_accept: true, can_decline: true,
      can_withdraw: false, withdraw_closes_at: "2026-09-30T14:00:00Z",
    },
    ...overrides,
  });
}

/** An admin who is not on the game. Alex has said yes and not paid. */
export function adminView(overrides: Partial<BookingDetail> = {}): BookingDetail {
  return detail({
    viewer: { role: "admin", participant_id: null },
    organiser: { user_id: SAM, name: "Sam Petersen", photo_url: null },
    players: [seat({ user_id: SAM, name: "Sam Petersen" }), seat({ ...ALEX_SEAT, seat: 2, team: "A", status: "accepted", consented_credits: 25, target_credits: 25 })],
    permissions: {
      can_invite: false, can_change_split: false, can_cancel: false, can_accept: false, can_decline: false,
      can_withdraw: false, withdraw_closes_at: "2026-09-30T14:00:00Z",
    },
    ...overrides,
  });
}

/** P12 — a booking nobody can record a result on yet (§6.1). */
const NO_RESULT = {
  booking_id: BOOKING, result: null,
  permissions: { can_record: false, can_edit: false, can_confirm: false, can_dispute: false, can_withdraw: false },
  not_recordable_reason: "not_checked_in", record_closes_at: null, candidates: [], default_sides: { a: [], b: [] },
  default_format: "best_of_5",
};

/** The session and the shell reads every signed-in render makes, then the page's own routes. */
export function serve(options: { admin?: boolean; detail?: unknown; extra?: StubRoute[] } = {}) {
  const session = signIn({ isAdmin: options.admin ?? false });
  const detailRoute: StubRoute = options.detail && typeof options.detail === "object" && "path" in (options.detail as object)
    ? (options.detail as StubRoute)
    : { path: DETAIL_PATH, body: options.detail ?? detail() };
  return stubFetch([
    { path: "/api/v1/whoami", body: session },
    { path: "/api/v1/wallet", body: { balance_credits: 100, held_credits: 0, spendable_credits: 100, held_until: null, entries: [] } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 0 } },
    detailRoute,
    // P12 — the result card below attendance reads its own route. Answered with "not checked in",
    // so the detail's longer-prefix route never answers it with a booking by accident.
    { path: `${DETAIL_PATH}/result`, body: NO_RESULT },
    ...(options.extra ?? []),
  ]);
}

export function renderDetail() {
  return renderPage(
    <Routes>
      <Route path="/bookings/:bookingId" element={<BookingDetailPage />} />
      <Route path="/bookings" element={<p>The bookings grid</p>} />
      <Route path="/invites/:participantId" element={<p>The accept sheet</p>} />
    </Routes>,
    { initialEntries: [`/bookings/${BOOKING}`], reactStrictMode: true },
  );
}
