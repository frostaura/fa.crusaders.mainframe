import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import InviteDeepLinkPage from "../../../pages/InviteDeepLink";
import { renderPage, signIn, signOut, stubFetch, type FetchStub, type StubRoute } from "../../../test/harness";
import { INVITES_COPY, acceptLabel } from "../../../lib/playersCopy";

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
});
