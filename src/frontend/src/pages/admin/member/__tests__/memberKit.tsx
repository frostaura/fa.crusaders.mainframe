import { Route, Routes } from "react-router-dom";
import { renderPage, signIn, stubFetch, type StubRoute } from "@/test/harness";
import type { MemberBookingRow, MemberDetail, MemberDoorRow, MemberDoorsPage } from "@/lib/memberDetailApi";
import MemberDetailLayout, {
  MemberAccess, MemberBookings, MemberDoors, MemberNightTab, MemberOverview, MemberWallet,
} from "../index";

/**
 * The member-detail test kit: fixtures shaped exactly like the merged backend's contracts, and a
 * render that mounts the page under the routes the integrator wires, so a tab is reached by its
 * URL the way an admin reaches it.
 */

export const MEMBER_ID = "11111111-1111-1111-1111-111111111111";
export const ADMIN_ID = "44444444-4444-4444-4444-444444444444"; // the harness's signed-in user
export const BASE = `/api/v1/admin/members/${MEMBER_ID}`;

export function bookingRow(overrides: Partial<MemberBookingRow> = {}): MemberBookingRow {
  return {
    booking_id: "b1",
    court_id: "c1",
    court_name: "Court 1",
    starts_at: "2099-09-23T16:00:00Z",
    ends_at: "2099-09-23T16:45:00Z",
    status: "booked",
    charged_credits: 24,
    checked_in_at: null,
    cancelled_at: null,
    booked_by: { user_id: MEMBER_ID, name: "Thandi Mokoena", is_self: true },
    ...overrides,
  };
}

export function detailFixture(overrides: Partial<MemberDetail> = {}): MemberDetail {
  return {
    user_id: MEMBER_ID,
    membership_id: "22222222-2222-2222-2222-222222222222",
    full_name: "Thandi Mokoena",
    email: "thandi@example.com",
    membership_number: "CR-0184",
    status: "Active",
    account_status: "Active",
    email_verified: true,
    created_at: "2026-03-01T08:00:00Z",
    last_login_at: "2026-09-22T17:30:00Z",
    photo_url: null,
    is_admin: false,
    admin_source: null,
    groups: [{ id: "g1", name: "League" }],
    balance_credits: 120,
    passkey_count: 1,
    fingerprints: { count: 1, enrolments: [{ template_id: "t1", finger_label: "right-index", enrolled_at: "2026-04-02T10:00:00Z" }] },
    next_bookings: [bookingRow()],
    counts_30d: { bookings: 6, no_shows: 1, sessions_played: 5 },
    ...overrides,
  };
}

export function doorRow(overrides: Partial<MemberDoorRow> = {}): MemberDoorRow {
  return {
    at: "2026-09-22T16:02:00Z",
    delivered_at: "2026-09-22T16:02:01Z",
    time_uncertain: false,
    action: "gate.released",
    outcome: "released",
    reason: null,
    reason_text: "Opened — a live booking",
    offline: false,
    method: "qr",
    fingerprint: null,
    door: { id: "d1", name: "Front door", gate_key: "front", removed: false },
    ...overrides,
  };
}

export function doorsPage(items: MemberDoorRow[], overrides: Partial<MemberDoorsPage> = {}): MemberDoorsPage {
  return {
    member: { user_id: MEMBER_ID, name: "Thandi Mokoena" },
    items,
    next_cursor: null,
    total: items.length,
    range: { from: "2026-09-16T00:00:00+02:00", to: "2026-09-23T10:00:00+02:00" },
    timezone: "Africa/Johannesburg",
    retention_days: 90,
    ...overrides,
  };
}

/** The routes every render needs: the session, and this member's detail. */
export function baseRoutes(detail: MemberDetail | null = detailFixture(), extra: StubRoute[] = []): StubRoute[] {
  return [
    { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
    { path: "/api/v1/wallet", body: { balance_credits: 0 } },
    { path: BASE, ...(detail ? { body: detail } : { status: 500, body: { error: "boom" } }) },
    ...extra,
  ];
}

export function serve(routes: StubRoute[]) {
  return stubFetch(routes);
}

/** Mounts the page at `path` under the routes App.tsx wires for P5. */
export function renderMember(path = `/admin/members/${MEMBER_ID}`) {
  return renderPage(
    <Routes>
      <Route path="/admin/members/:userId" element={<MemberDetailLayout />}>
        <Route index element={<MemberOverview />} />
        <Route path="wallet" element={<MemberWallet />} />
        <Route path="bookings" element={<MemberBookings />} />
        <Route path="doors" element={<MemberDoors />} />
        <Route path="night" element={<MemberNightTab />} />
        <Route path="access" element={<MemberAccess />} />
      </Route>
      <Route path="/bookings" element={<p>The bookings page</p>} />
      <Route path="/admin/members" element={<p>The members list</p>} />
    </Routes>,
    { initialEntries: [path] },
  );
}
