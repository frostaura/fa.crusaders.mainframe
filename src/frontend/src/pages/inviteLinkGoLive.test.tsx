import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import InviteLinkPage from "./InviteLink";
import { refuse, renderPage, signIn, signOut, stubFetch, type StubRoute } from "../test/harness";
import { INVITES_COPY, acceptLabel } from "../lib/playersCopy";

/**
 * BM-10 (go-live) — an open-seat link opened by a member already on that game says so before any
 * Accept is offered; and an accept refused `already_in_booking` drops Accept for the way to the game.
 */
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { vi.unstubAllGlobals(); signOut(); window.localStorage.clear(); });

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const BOOKING = "b0000000-0000-0000-0000-000000000001";
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const INVITE = {
  participant_id: "p0000000-0000-0000-0000-000000000004", booking_id: BOOKING, status: "invited", seat: 4, team: "B",
  open_link: true, court_name: "Court 2", starts_at: at(24), ends_at: at(24.75),
  organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Nomsa Khumalo", photo_url: null },
  players: 3, share_minutes: 25, to_pay_minutes: 25, needs_consent: false,
  balance_minutes: 80, spendable_minutes: 80, held_minutes: 0, balance_after_minutes: 55, short_by_minutes: 0, share_deadline: at(26.75), cap: null,
};
const game = (bookingId: string, role: string) => ({ booking_id: bookingId, court_name: "Court 2", starts_at: at(24), ends_at: at(24.75), role, status: "booked", players: [] });

function openLink(routes: StubRoute[]) {
  const stub = stubFetch([
    ...routes,
    { path: `/api/v1/invites/${TOKEN}`, body: INVITE },
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: { balance_minutes: 80, held_minutes: 0, spendable_minutes: 80, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
  ]);
  renderPage(<Routes><Route path="/j/:token" element={<InviteLinkPage />} /></Routes>, { initialEntries: [`/j/${TOKEN}`] });
  return stub;
}

describe("an open-seat link for a game the member is already on (BM-10)", () => {
  it.each(["organiser", "partner"])("as the %s: 'already on this game', no Accept, a way to the game", async (role) => {
    openLink([{ path: "/api/v1/me/bookings/upcoming", body: { items: [game(BOOKING, role)] } }]);
    expect(await screen.findByText(INVITES_COPY.linkAlreadyIn, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: acceptLabel(25) })).toBeNull();
    expect(screen.getByRole("link", { name: INVITES_COPY.seeBooking })).toHaveAttribute("href", `/bookings/${BOOKING}`);
  });

  it("another game in the member's list (or only a box payment on this one) still offers the seat", async () => {
    openLink([{ path: "/api/v1/me/bookings/upcoming", body: { items: [game("other", "organiser"), game(BOOKING, "payer")] } }]);
    expect(await screen.findByRole("button", { name: acceptLabel(25) }, { timeout: 4000 })).toBeInTheDocument();
  });

  it("an unreadable games list never holds the link back — and the accept's refusal drops Accept", async () => {
    openLink([
      { path: "/api/v1/me/bookings/upcoming", status: 500, body: { error: "unavailable" } },
      { method: "POST", path: `/api/v1/invites/${TOKEN}/accept`, respond: () => refuse(409, { error: "already_in_booking", booking_id: BOOKING }) },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: acceptLabel(25) }, { timeout: 4000 }));
    expect(await screen.findByText(INVITES_COPY.linkAlreadyIn, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: acceptLabel(25) })).toBeNull();
  });
});
