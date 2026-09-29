import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import InviteDeepLinkPage from "../../../pages/InviteDeepLink";
import { renderPage, signIn, signOut, stubFetch, type FetchStub, type StubRoute } from "../../../test/harness";
import { INVITES_COPY, acceptLabel, signedInAsLine } from "../../../lib/playersCopy";
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
    players: 4, share_credits: 25, to_pay_credits: 25, needs_consent: false,
    balance_credits: 100, spendable_credits: 100, held_credits: 0, balance_after_credits: 75, short_by_credits: 0,
    share_deadline: at(26.75), cap: null,
    ...overrides,
  };
}

function openDeepLink(routes: StubRoute[], participantId = SEAT): FetchStub {
  const stub = stubFetch([
    ...routes,
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: { balance_credits: 100, held_credits: 0, spendable_credits: 100, held_until: null, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
  ]);
  renderPage(<Routes><Route path="/invites/:participantId" element={<InviteDeepLinkPage />} /></Routes>, {
    initialEntries: [`/invites/${participantId}`], reactStrictMode: true,
  });
  return stub;
}

describe("the invite mail's deep link", () => {
  it("lands on the invite it names, ready to accept by seat", async () => {
    let accepted = false;
    const stub = openDeepLink([
      { path: "/api/v1/me/invites", respond: () => (accepted ? { items: [], count: 0 }
        : { items: [invite({ participant_id: "other", booking_id: "b2" }), invite()], count: 2 }) },
      { method: "POST", path: `/api/v1/bookings/${BOOKING}/players/${SEAT}/accept`, respond: () => {
        accepted = true;
        return { participant_id: SEAT, booking_id: BOOKING, status: "accepted", share_credits: 25, consented_credits: 25, paid_credits: 25, balance_credits: 75 };
      } },
    ]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.linkTitle })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: acceptLabel(25) }));
    expect(await screen.findByText(INVITES_COPY.acceptedTitle)).toBeInTheDocument();
    // D6 — the heading follows the answer.
    expect(screen.getByRole("heading", { level: 1, name: INVITES_COPY.acceptedTitle })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: INVITES_COPY.linkTitle })).toBeNull();
    const posted = stub.calls.filter((c) => c.method === "POST" && c.path.endsWith("/accept"));
    expect(posted.map((c) => c.body)).toEqual([{ expectedShareCredits: 25 }]);
    // The re-read no longer lists the seat, and the confirmation stays.
    expect(screen.queryByText(INVITES_COPY.deepLinkGone)).toBeNull();
  });

  it("an invite no longer waiting is a sentence with the way to Invites and Bookings", async () => {
    openDeepLink([{ path: "/api/v1/me/invites", body: { items: [invite({ participant_id: "other" })], count: 1 } }]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.deepLinkGone })).toBeInTheDocument();
    expect(screen.getByText(INVITES_COPY.deepLinkGoneHint)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: INVITES_COPY.toInvites })).toHaveAttribute("href", "/bookings/invites");
    expect(screen.getByRole("link", { name: INVITES_COPY.toBookings })).toHaveAttribute("href", "/bookings");
  });

  it("D5 — says which account is signed in, and signs out so the invited member can open it", async () => {
    const stub = stubFetch([
      { path: "/api/v1/me/invites", body: { items: [], count: 0 } },
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/me/profile", body: {
        user_id: "44444444-4444-4444-4444-444444444444", email: "olivia@club.review.test", is_admin: false, tenant_slug: "crusaders",
        full_name: "Olivia Newton", membership_number: "MEM-2002", photo_url: null, status: "active",
      } },
      { path: "/api/v1/wallet", body: { balance_credits: 100, held_credits: 0, spendable_credits: 100, held_until: null, entries: [], total_entries: 0, offset: 0, limit: 10 } },
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


describe("R1 F2.7 / F2.8 — the mail's link after the invite moved on", () => {
  const NOTICES = { path: "/api/v1/me/notifications", body: { items: [
    { id: "n1", kind: "players.invited", headline: "Sam invited you", link: `/invites/${SEAT}`, booking_id: BOOKING, created_at: "2026-09-28T08:00:00Z", read_at: null },
  ], unread_count: 1, next_cursor: null } };
  const DETAIL = `/api/v1/bookings/${BOOKING}`;
  const detail = (status: string, seatStatus: string) => ({
    booking_id: BOOKING, status, players: [{ participant_id: SEAT, status: seatStatus }],
  });

  it("already said yes: \"You're in\" with the way to the booking — never 'sign out'", async () => {
    openDeepLink([{ path: "/api/v1/me/invites", body: { items: [], count: 0 } }, NOTICES, { path: DETAIL, body: detail("booked", "accepted") }]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.fateInTitle })).toBeInTheDocument();
    expect(screen.getByText(INVITES_COPY.fateInBody)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: INVITES_COPY.seeBooking })).toHaveAttribute("href", `/bookings/${BOOKING}`);
    expect(screen.queryByRole("button", { name: INVITES_COPY.signOutToOpen })).toBeNull();
  });

  it("the game was cancelled: it says so, with the way to the booking", async () => {
    openDeepLink([{ path: "/api/v1/me/invites", body: { items: [], count: 0 } }, NOTICES, { path: DETAIL, body: detail("cancelled", "invited") }]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.fateCancelledTitle })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: INVITES_COPY.seeBooking })).toHaveAttribute("href", `/bookings/${BOOKING}`);
    expect(screen.queryByRole("button", { name: INVITES_COPY.signOutToOpen })).toBeNull();
  });

  it("off the game (the booking is a 404 to them): says so, with no link to a page they cannot open", async () => {
    openDeepLink([
      { path: "/api/v1/me/invites", body: { items: [], count: 0 } }, NOTICES,
      { path: DETAIL, status: 404, body: { error: "booking_not_found" } },
    ]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.fateGoneTitle })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: INVITES_COPY.seeBooking })).toBeNull();
    expect(screen.queryByRole("button", { name: INVITES_COPY.signOutToOpen })).toBeNull();
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
