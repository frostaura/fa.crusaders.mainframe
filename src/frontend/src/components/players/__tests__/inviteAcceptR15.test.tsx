import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import InviteDeepLinkPage from "../../../pages/InviteDeepLink";
import { renderPage, signIn, signOut, stubFetch, type StubRoute } from "../../../test/harness";
import { acceptLabel, acceptedLine } from "../../../lib/playersCopy";

/**
 * R15 J15-11 — "Accept and pay 10 minutes" on a share that went up from 20 to 30 confirmed "30
 * minutes paid to Sam": the seat's total, said as what this press paid. It says the 10, with the
 * 30 beside it.
 */
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { vi.unstubAllGlobals(); signOut(); });

const BOOKING = "b0000000-0000-0000-0000-000000000001";
const SEAT = "p0000000-0000-0000-0000-000000000003";

function invite(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  return {
    participant_id: SEAT, booking_id: BOOKING, status: "accepted", seat: 3, team: "B", open_link: false,
    court_name: "Court 1", starts_at: at(24), ends_at: at(24.75),
    organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen", photo_url: null },
    players: 4, share_minutes: 30, to_pay_minutes: 10, needs_consent: true, consented_minutes: 20,
    balance_minutes: 100, spendable_minutes: 100, held_minutes: 0, balance_after_minutes: 90, short_by_minutes: 0,
    share_deadline: at(26.75), cap: null,
    ...overrides,
  };
}

function open(routes: StubRoute[]) {
  stubFetch([
    ...routes,
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: { balance_minutes: 100, held_minutes: 0, spendable_minutes: 100, held_until: null, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
  ]);
  renderPage(<Routes><Route path="/invites/:participantId" element={<InviteDeepLinkPage />} /></Routes>, { initialEntries: [`/invites/${SEAT}`] });
}

describe("R15 J15-11 — the accept's confirmation", () => {
  it("a share up from 20 to 30: '10 minutes paid to Sam — 30 minutes in all'", async () => {
    let accepted = false;
    open([
      { path: "/api/v1/me/invites", respond: () => ({ items: accepted ? [] : [invite()], count: accepted ? 0 : 1 }) },
      { method: "POST", path: `/api/v1/bookings/${BOOKING}/players/${SEAT}/accept`, respond: () => {
        accepted = true;
        return { participant_id: SEAT, booking_id: BOOKING, status: "accepted", share_minutes: 30, consented_minutes: 30, paid_minutes: 30, balance_minutes: 90 };
      } },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: acceptLabel(10) }));
    expect(await screen.findByText(acceptedLine(10, "Sam", 30), { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/^30 minutes paid to Sam/)).toBeNull();
  });

  it("a first accept of 25: '25 minutes paid to Sam'", async () => {
    let accepted = false;
    open([
      { path: "/api/v1/me/invites", respond: () => ({ items: accepted ? [] : [invite({ status: "invited", needs_consent: false, consented_minutes: 0, share_minutes: 25, to_pay_minutes: 25 })], count: accepted ? 0 : 1 }) },
      { method: "POST", path: `/api/v1/bookings/${BOOKING}/players/${SEAT}/accept`, respond: () => {
        accepted = true;
        return { participant_id: SEAT, booking_id: BOOKING, status: "accepted", share_minutes: 25, consented_minutes: 25, paid_minutes: 25, balance_minutes: 75 };
      } },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: acceptLabel(25) }));
    expect(await screen.findByText(acceptedLine(25, "Sam"), { exact: false })).toBeInTheDocument();
  });
});
