import { SESSION_ADMIN, type ApiRoute } from "./fixtures";

/**
 * P11 — shared fixtures for the `players-*.spec.ts` specs: a member session, the people on a
 * split booking, and the routes every signed-in screen asks for once the bell and the invites
 * badge are in the shell. Figures follow `docs/specs/players-and-splits.md` (backend) exactly —
 * a 100 cr court, four players, an equal split: partners 25 each, the organiser the remainder.
 *
 * Read-only for the lanes: a spec that needs a different figure builds it with the overrides.
 */

export const ME = "44444444-4444-4444-4444-444444444444";
export const SAM = "55555555-5555-5555-5555-555555555555";
export const ALEX = "66666666-6666-6666-6666-666666666666";
export const JO = "77777777-7777-7777-7777-777777777777";
export const BOOKING = "b0000000-0000-0000-0000-000000000001";
export const COURT = "c0000000-0000-0000-0000-000000000001";

export const SESSION_MEMBER = { ...SESSION_ADMIN, user_id: ME, is_admin: false };
export const SESSION_ADMIN_P11 = { ...SESSION_ADMIN, user_id: ME, is_admin: true };

export const PROFILE_ME = {
  user_id: ME, email: "nomsa@club.review.test", is_admin: false, tenant_slug: "crusaders",
  full_name: "Nomsa Khumalo", membership_number: "P-1", photo_url: null, status: "Active",
  held_credits: 0, held_until: null,
};

export const PEOPLE = {
  me: { user_id: ME, name: "Nomsa Khumalo", photo_url: null },
  sam: { user_id: SAM, name: "Sam Petersen", photo_url: null },
  alex: { user_id: ALEX, name: "Alex Naidoo", photo_url: null },
  jo: { user_id: JO, name: "Jo van Wyk", photo_url: null },
} as const;

/** Tomorrow at 18:00 club time (UTC+2), as the API writes an instant. */
export function tomorrowAt(hour = 18, minutes = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour - 2, minutes, 0, 0);
  return d.toISOString();
}

type Seat = Record<string, unknown>;

export function seat(overrides: Seat = {}): Seat {
  return {
    participant_id: "p0000000-0000-0000-0000-000000000001", seat: 1, team: "A", kind: "organiser",
    user_id: ME, name: PEOPLE.me.name, photo_url: null, status: "accepted",
    share_credits: 25, weight: 1, consented_credits: 0, paid_credits: 0, target_credits: 0, unpaid_credits: 0,
    needs_consent: false, settled_outside: false, lapsed: false, checked_in_at: null,
    invited_at: new Date().toISOString(), responded_at: new Date().toISOString(),
    ...overrides,
  };
}

/** The organiser's view of a four-player equal split: Sam in and paid, Alex invited, an open link seat. */
export function detailFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const starts = tomorrowAt(18);
  const ends = tomorrowAt(18, 45);
  return {
    booking_id: BOOKING, court_id: COURT, court_name: "Court 1",
    starts_at: starts, ends_at: ends, sold_ends_at: ends, status: "booked", split_mode: "equal",
    viewer: { role: "organiser", participant_id: "p0000000-0000-0000-0000-000000000001" },
    organiser: PEOPLE.me,
    players: [
      seat(),
      seat({ participant_id: "p0000000-0000-0000-0000-000000000002", seat: 2, kind: "member", user_id: SAM, name: PEOPLE.sam.name,
        status: "accepted", consented_credits: 25, paid_credits: 25, target_credits: 25 }),
      seat({ participant_id: "p0000000-0000-0000-0000-000000000003", seat: 3, team: "B", kind: "member", user_id: ALEX, name: PEOPLE.alex.name,
        status: "invited", unpaid_credits: 25 }),
      seat({ participant_id: "p0000000-0000-0000-0000-000000000004", seat: 4, team: "B", kind: "open_link", user_id: null, name: null,
        status: "invited" }),
    ],
    money: {
      price_credits: 100, organiser_owed_credits: 100, shares_received_credits: 25, organiser_net_credits: 75,
      unpaid_credits: 25, share_deadline: tomorrowAt(20, 45), is_split: true,
    },
    attendance: { checked_in_at: null, players_checked_in: 0 },
    permissions: {
      can_invite: true, can_change_split: true, can_cancel: true, can_accept: false, can_decline: false,
      can_withdraw: false, withdraw_closes_at: tomorrowAt(16),
    },
    ...overrides,
  };
}

/** Alex's invite to the booking above, as the accept sheet reads it. */
export function inviteFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participant_id: "p0000000-0000-0000-0000-000000000003", booking_id: BOOKING, status: "invited",
    seat: 3, team: "B", open_link: false, court_name: "Court 1",
    starts_at: tomorrowAt(18), ends_at: tomorrowAt(18, 45),
    organiser: PEOPLE.me, players: 4, share_credits: 25, to_pay_credits: 25, needs_consent: false,
    balance_credits: 120, spendable_credits: 100, held_credits: 20, balance_after_credits: 75, short_by_credits: 0,
    share_deadline: tomorrowAt(20, 45), cap: null,
    ...overrides,
  };
}

/**
 * What every signed-in member screen asks for once P11 is in the shell: who am I, my profile,
 * my wallet (with the held figures), the bell's unread count and the invites badge.
 */
export function memberShellRoutes(options: { unread?: number; invites?: unknown[]; admin?: boolean; wallet?: Record<string, unknown> } = {}): ApiRoute[] {
  const invites = options.invites ?? [];
  return [
    { path: "/api/v1/whoami", body: options.admin ? SESSION_ADMIN_P11 : SESSION_MEMBER },
    { path: "/api/v1/me/profile", body: { ...PROFILE_ME, is_admin: Boolean(options.admin) } },
    {
      path: "/api/v1/wallet",
      body: {
        balance_credits: 120, held_credits: 20, spendable_credits: 100, held_until: tomorrowAt(20, 45),
        entries: [], total_entries: 0, offset: 0, limit: 100, ...(options.wallet ?? {}),
      },
    },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/notifications/unread-count", body: { unread_count: options.unread ?? 0 } },
    { path: "/api/v1/me/invites", body: { items: invites, count: invites.length } },
    { path: "/api/v1/me/door", body: { doors: true, doors_shut: "none" } },
    // P12 — the celebration overlay asks on every signed-in screen; none waiting by default.
    { path: "/api/v1/me/play/celebrations", body: { items: [] } },
  ];
}
