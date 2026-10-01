import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import InviteDeepLinkPage from "../../../pages/InviteDeepLink";
import { renderPage, signIn, signOut, stubFetch, type FetchStub, type StubRoute } from "../../../test/harness";
import { INVITES_COPY, acceptLabel, askedAgainLine, invitedLine, signedInAsLine } from "../../../lib/playersCopy";
import LoginPage from "../../../pages/Login";
import { tokenStore } from "../../../lib/api";
import { LOGIN } from "../../../lib/authCopy";
import { ProfileProvider } from "../../../lib/profile";

/**
 * `/invites/:participantId` — the invite mail's link. Found in the member's open invites, it
 * lands on the actionable invite itself; gone, it says so with the way to Invites and Bookings.
 */
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { vi.unstubAllGlobals(); signOut(); });

const BOOKING = "b0000000-0000-0000-0000-000000000001";
const SEAT = "p0000000-0000-0000-0000-000000000003";

function invite(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  return {
    participant_id: SEAT, booking_id: BOOKING, status: "invited", seat: 3, team: "B", open_link: false,
    court_name: "Court 1", starts_at: at(24), ends_at: at(24.75),
    organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen", photo_url: null },
    players: 4, share_minutes: 25, to_pay_minutes: 25, needs_consent: false,
    balance_minutes: 100, spendable_minutes: 100, held_minutes: 0, balance_after_minutes: 75, short_by_minutes: 0,
    share_deadline: at(26.75), cap: null,
    ...overrides,
  };
}

/** The caller's own seat (`GET /me/invites/{id}`, B4): 404 — not this account's. */
const NOT_MY_SEAT: StubRoute = { path: `/api/v1/me/invites/${SEAT}`, status: 404, body: { error: "invite_not_found" } };

function openDeepLink(routes: StubRoute[], participantId = SEAT): FetchStub {
  const stub = stubFetch([
    ...routes,
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: { balance_minutes: 100, held_minutes: 0, spendable_minutes: 100, held_until: null, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
  ]);
  renderPage(<Routes><Route path="/invites/:participantId" element={<InviteDeepLinkPage />} /></Routes>, {
    initialEntries: [`/invites/${participantId}`], reactStrictMode: true,
  });
  return stub;
}

describe("the invite mail's deep link", () => {
  it("R4 M4-8: a partner who said yes and whose share went up reads \"Your share went up\", not an invitation", async () => {
    openDeepLink([
      { path: "/api/v1/me/invites", body: { items: [invite({ status: "accepted", needs_consent: true, share_minutes: 30, to_pay_minutes: 5 })], count: 1 } },
    ]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.askedAgainTitle })).toBeInTheDocument();
    expect(screen.getByText(askedAgainLine("Sam", 30))).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: INVITES_COPY.linkTitle })).toBeNull();
    expect(screen.queryByText(invitedLine("Sam", false))).toBeNull();
    expect(screen.getByRole("button", { name: acceptLabel(5) })).toBeInTheDocument();
  });

  it("lands on the invite it names, ready to accept by seat", async () => {
    let accepted = false;
    const stub = openDeepLink([
      { path: "/api/v1/me/invites", respond: () => (accepted ? { items: [], count: 0 }
        : { items: [invite({ participant_id: "other", booking_id: "b2" }), invite()], count: 2 }) },
      { method: "POST", path: `/api/v1/bookings/${BOOKING}/players/${SEAT}/accept`, respond: () => {
        accepted = true;
        return { participant_id: SEAT, booking_id: BOOKING, status: "accepted", share_minutes: 25, consented_minutes: 25, paid_minutes: 25, balance_minutes: 75 };
      } },
    ]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.linkTitle })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: acceptLabel(25) }));
    expect(await screen.findByText(INVITES_COPY.acceptedTitle)).toBeInTheDocument();
    // D6 — the heading follows the answer.
    expect(screen.getByRole("heading", { level: 1, name: INVITES_COPY.acceptedTitle })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: INVITES_COPY.linkTitle })).toBeNull();
    const posted = stub.calls.filter((c) => c.method === "POST" && c.path.endsWith("/accept"));
    expect(posted.map((c) => c.body)).toEqual([{ expectedShareMinutes: 25 }]);
    // The re-read no longer lists the seat, and the confirmation stays.
    expect(screen.queryByText(INVITES_COPY.deepLinkGone)).toBeNull();
  });

  it("an invite no longer waiting is a sentence with the way to Invites and Bookings", async () => {
    openDeepLink([{ path: "/api/v1/me/invites", body: { items: [invite({ participant_id: "other" })], count: 1 } }, NOT_MY_SEAT]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.deepLinkGone })).toBeInTheDocument();
    expect(screen.getByText(INVITES_COPY.deepLinkGoneHint)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: INVITES_COPY.toInvites })).toHaveAttribute("href", "/bookings/invites");
    expect(screen.getByRole("link", { name: INVITES_COPY.toBookings })).toHaveAttribute("href", "/bookings");
  });

  it("D5 — says which account is signed in, and signs out so the invited member can open it", async () => {
    const stub = stubFetch([
      { path: "/api/v1/me/invites", body: { items: [], count: 0 } },
      NOT_MY_SEAT,
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/me/profile", body: {
        user_id: "44444444-4444-4444-4444-444444444444", email: "olivia@club.review.test", is_admin: false, tenant_slug: "crusaders",
        full_name: "Olivia Newton", membership_number: "MEM-2002", photo_url: null, status: "active",
      } },
      { path: "/api/v1/wallet", body: { balance_minutes: 100, held_minutes: 0, spendable_minutes: 100, held_until: null, entries: [], total_entries: 0, offset: 0, limit: 10 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
      { method: "POST", path: "/api/v1/auth/logout", status: 204, body: "" },
      { method: "POST", path: "/api/v1/auth/login", body: { access_token: "sam.token", user_id: "77777777-7777-7777-7777-777777777777", is_admin: false } },
    ]);
    renderPage(
      <ProfileProvider>
        <Routes>
          <Route path="/invites/:participantId" element={<InviteDeepLinkPage />} />
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </ProfileProvider>,
      { initialEntries: [`/invites/${SEAT}`] },
    );
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.deepLinkGone })).toBeInTheDocument();
    expect(await screen.findByText(signedInAsLine("Olivia"))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: INVITES_COPY.signOutToOpen }));
    await waitFor(() => expect(tokenStore.get()).toBeNull());
    expect(stub.calls.some((c) => c.path === "/api/v1/auth/logout")).toBe(true);

    // The invited member signs in on /login and is taken back to the invite, not the landing.
    fireEvent.change(await screen.findByLabelText(LOGIN.email), { target: { value: "sam@club.review.test" } });
    fireEvent.change(screen.getByLabelText(LOGIN.password), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: LOGIN.submit }));
    await waitFor(() => expect(stub.calls.filter((c) => c.path === "/api/v1/me/invites").length).toBeGreaterThan(1));
  });
});


describe("R1 F2.7 / F2.8 — the mail's link after the invite moved on (asked of GET /me/invites/{id}, B4)", () => {
  const LIST = { path: "/api/v1/me/invites", body: { items: [], count: 0 } };
  const seat = (status: string, bookingStatus: string, extra: Record<string, unknown> = {}): StubRoute => ({
    path: `/api/v1/me/invites/${SEAT}`,
    body: {
      participant_id: SEAT, booking_id: BOOKING, status, lapsed: false, settled_outside: false, booking_status: bookingStatus,
      court_name: "Court 1", starts_at: "2026-10-01T08:00:00Z", ends_at: "2026-10-01T08:45:00Z",
      organiser_name: "Sam Petersen", share_minutes: 25, timezone: "Africa/Johannesburg", ...extra,
    },
  });

  it("already said yes: \"You're in\" with the way to the booking — never 'sign out'", async () => {
    const stub = openDeepLink([LIST, seat("accepted", "booked")]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.fateInTitle })).toBeInTheDocument();
    expect(screen.getByText(INVITES_COPY.fateInBody)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: INVITES_COPY.seeBooking })).toHaveAttribute("href", `/bookings/${BOOKING}`);
    expect(screen.queryByRole("button", { name: INVITES_COPY.signOutToOpen })).toBeNull();
    // Asked of the seat itself — the inbox and the booking are no longer read to guess it.
    expect(stub.calls.some((c) => c.path.startsWith("/api/v1/me/notifications"))).toBe(false);
  });

  it("the game was cancelled: it says so, with the way to the booking", async () => {
    openDeepLink([LIST, seat("invited", "cancelled")]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.fateCancelledTitle })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: INVITES_COPY.seeBooking })).toHaveAttribute("href", `/bookings/${BOOKING}`);
    expect(screen.queryByRole("button", { name: INVITES_COPY.signOutToOpen })).toBeNull();
  });

  it.each(["declined", "withdrawn", "removed", "lapsed"])("off the game (%s): says so, with no link to a page they cannot open", async (status) => {
    openDeepLink([LIST, seat(status, "booked")]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.fateGoneTitle })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: INVITES_COPY.seeBooking })).toBeNull();
    expect(screen.queryByRole("button", { name: INVITES_COPY.signOutToOpen })).toBeNull();
  });

  it("an accepted seat that lapsed is off the game, not in it", async () => {
    openDeepLink([LIST, seat("accepted", "booked", { lapsed: true })]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.fateGoneTitle })).toBeInTheDocument();
  });
});

describe("R1 F2.4 — the mail's link opened signed out", () => {
  it("says an invite is waiting and offers sign-in that returns here", async () => {
    stubFetch([]);
    renderPage(<Routes><Route path="/invites/:participantId" element={<InviteDeepLinkPage />} /></Routes>, {
      initialEntries: [`/invites/${SEAT}`],
    });
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.signedOutTitle })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: INVITES_COPY.signedOutSignIn })).toHaveAttribute("href", "/login");
    // An addressed invite is a member's: there is no "join the club" on it.
    expect(screen.queryByRole("link", { name: INVITES_COPY.signedOutJoin })).toBeNull();
  });
});
