import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import InviteLinkPage from "./InviteLink";
import { refuse, renderPage, signIn, signOut, stubFetch, type FetchStub, type StubRoute } from "../test/harness";
import { ApiError } from "../lib/api";
import { INVITES_COPY, acceptLabel, invitedLine, playersRefusal } from "../lib/playersCopy";
import { pendingInvite, savePendingInvite } from "../lib/playersPending";

/**
 * `/j/:token` — a shared link, opened as a page: the same accept body as the sheet, answered
 * through the link's own routes, and every refusal on opening as a sentence with a way back.
 */
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { vi.unstubAllGlobals(); signOut(); window.localStorage.clear(); });

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const BOOKING = "b0000000-0000-0000-0000-000000000001";
const OPEN = `/api/v1/invites/${TOKEN}`;

function at(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
}

function invite(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participant_id: "p0000000-0000-0000-0000-000000000004", booking_id: BOOKING, status: "invited", seat: 4, team: "B",
    open_link: true, court_name: "Court 2", starts_at: at(24), ends_at: at(24.75),
    organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Nomsa Khumalo", photo_url: null },
    players: 3, share_minutes: 25, to_pay_minutes: 25, needs_consent: false,
    balance_minutes: 80, spendable_minutes: 80, held_minutes: 0, balance_after_minutes: 55, short_by_minutes: 0,
    share_deadline: at(26.75), cap: null,
    ...overrides,
  };
}

function openLink(routes: StubRoute[], token = TOKEN): FetchStub {
  const stub = stubFetch([
    ...routes,
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: { balance_minutes: 80, held_minutes: 0, spendable_minutes: 80, held_until: null, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
  ]);
  renderPage(<Routes><Route path="/j/:token" element={<InviteLinkPage />} /></Routes>, {
    initialEntries: [`/j/${token}`], reactStrictMode: true,
  });
  return stub;
}

describe("an open link", () => {
  it("reads as an invitation to take a seat, with the whole accept body", async () => {
    openLink([{ path: OPEN, body: invite() }]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.linkTitle })).toBeInTheDocument();
    expect(screen.getByText(invitedLine("Nomsa", true))).toBeInTheDocument();
    expect(screen.getByText(INVITES_COPY.balanceAfter).nextSibling).toHaveTextContent("55 minutes");
    // An open seat has no one to say no to: the link's decline answers 404 for it.
    expect(screen.queryByRole("button", { name: INVITES_COPY.decline })).toBeNull();
  });

  it("accepts through the link with the share it showed, then confirms", async () => {
    const stub = openLink([
      { path: OPEN, body: invite() },
      { method: "POST", path: `${OPEN}/accept`, body: {
        participant_id: "p4", booking_id: BOOKING, status: "accepted", share_minutes: 25, consented_minutes: 25, paid_minutes: 25, balance_minutes: 55,
      } },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: acceptLabel(25) }));
    expect(await screen.findByText(INVITES_COPY.acceptedTitle)).toBeInTheDocument();
    const sent = stub.calls.filter((c) => c.method === "POST" && c.path === `${OPEN}/accept`);
    expect(sent.map((c) => c.body)).toEqual([{ expectedShareMinutes: 25 }]);
    expect(screen.getByRole("link", { name: INVITES_COPY.seeBooking })).toHaveAttribute("href", `/bookings/${BOOKING}`);
  });

  it("a risen share on the link is shown, re-read and asked again", async () => {
    let raised = false;
    const stub = openLink([
      { path: OPEN, respond: () => (raised ? invite({ share_minutes: 34, to_pay_minutes: 34 }) : invite()) },
      { method: "POST", path: `${OPEN}/accept`, respond: () => { raised = true; return refuse(409, { error: "share_changed", share_minutes: 34 }); } },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: acceptLabel(25) }));
    expect(await screen.findByText(playersRefusal(new ApiError(409, { error: "share_changed", share_minutes: 34 })))).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: acceptLabel(34) })).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.method === "POST").filter((c) => c.path.endsWith("/accept"))).toHaveLength(1);
  });

  it("an addressed link can be declined through the link", async () => {
    const stub = openLink([
      { path: OPEN, body: invite({ open_link: false }) },
      { method: "POST", path: `${OPEN}/decline`, body: { participant_id: "p4", status: "declined" } },
    ]);
    expect(await screen.findByText(invitedLine("Nomsa", false))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: INVITES_COPY.decline }));
    fireEvent.click(screen.getByRole("button", { name: INVITES_COPY.declineConfirm }));
    expect(await screen.findByText(INVITES_COPY.declinedTitle)).toBeInTheDocument();
    // The confirmation stands although the link now answers "closed".
    expect(stub.calls.some((c) => c.path === `${OPEN}/decline`)).toBe(true);
  });
});

describe("a link that cannot be opened", () => {
  const CASES: [string, number, Record<string, unknown>, string][] = [
    ["not for you, or no longer working", 404, { error: "invite_not_found" }, INVITES_COPY.linkNotFound],
    ["closed", 409, { error: "invite_closed", booking_id: BOOKING }, INVITES_COPY.linkClosed],
    ["already on the game", 409, { error: "already_in_booking", booking_id: BOOKING }, INVITES_COPY.linkAlreadyIn],
    ["taken off the game", 409, { error: "player_previously_removed", booking_id: BOOKING }, INVITES_COPY.linkRemoved],
  ];

  it.each(CASES)("%s: a sentence page with a way back", async (_name, status, body, sentence) => {
    openLink([{ path: OPEN, status, body }]);
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: INVITES_COPY.refusedTitle })).toBeInTheDocument();
    const gone = document.querySelector("[data-invite-gone]") as HTMLElement;
    expect(within(gone).getByRole("link", { name: INVITES_COPY.toInvites })).toHaveAttribute("href", "/bookings/invites");
    expect(within(gone).getByRole("link", { name: INVITES_COPY.toBookings })).toHaveAttribute("href", "/bookings");
    const booking = within(gone).queryByRole("link", { name: INVITES_COPY.seeBooking });
    if (body.error === "already_in_booking") expect(booking).toHaveAttribute("href", `/bookings/${BOOKING}`);
    else expect(booking).toBeNull();
    expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
  });
});

describe("R2 F2-6 — the claimer's own link after the organiser cancelled", () => {
  function claimedDetail(overrides: Record<string, unknown> = {}) {
    return {
      booking_id: BOOKING, court_id: "c1", court_name: "Court 2", starts_at: at(24), ends_at: at(24.75), sold_ends_at: at(24.75),
      status: "cancelled", split_mode: "equal", viewer: { role: "player", participant_id: "p-eve" },
      organiser: { user_id: "u-nomsa", name: "Nomsa Khumalo", photo_url: null },
      players: [{
        participant_id: "p-eve", seat: 4, team: "B", kind: "member", user_id: "44444444-4444-4444-4444-444444444444", name: "Eve",
        photo_url: null, status: "accepted", share_minutes: 10, weight: 1, consented_minutes: 10, paid_minutes: 0, target_minutes: 0,
        unpaid_minutes: 0, needs_consent: false, settled_outside: false, lapsed: false, checked_in_at: null, invited_at: null, responded_at: null,
      }],
      money: { price_minutes: 40, organiser_owed_minutes: 0, shares_received_minutes: 0, organiser_net_minutes: 0, unpaid_minutes: 0, share_deadline: at(26), is_split: true },
      attendance: { checked_in_at: null, players_checked_in: 0 },
      permissions: { can_invite: false, can_change_split: false, can_cancel: false, can_accept: false, can_decline: false, can_withdraw: false, withdraw_closes_at: at(20) },
      ...overrides,
    };
  }

  it("says the game was cancelled and that the share is back — not 'can't be opened'", async () => {
    openLink([
      { path: OPEN, status: 409, body: { error: "invite_closed", booking_id: BOOKING } },
      { path: `/api/v1/bookings/${BOOKING}`, body: claimedDetail() },
    ]);
    expect(await screen.findByText(INVITES_COPY.linkCancelledBack("10 minutes"))).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: INVITES_COPY.fateCancelledTitle })).toBeInTheDocument();
    expect(screen.queryByText(INVITES_COPY.refusedTitle)).toBeNull();
    expect(screen.getByRole("link", { name: INVITES_COPY.seeBooking })).toHaveAttribute("href", `/bookings/${BOOKING}`);
  });

  it("a closed link on a game still on keeps the general sentence", async () => {
    openLink([
      { path: OPEN, status: 409, body: { error: "invite_closed", booking_id: BOOKING } },
      { path: `/api/v1/bookings/${BOOKING}`, body: claimedDetail({ status: "booked" }) },
    ]);
    expect(await screen.findByText(INVITES_COPY.linkClosed)).toBeInTheDocument();
  });
});

const ME = "44444444-4444-4444-4444-444444444444"; // the harness's signed-in user

describe("R1 F2.3 / F2.4 — opened signed out", () => {
  const PREVIEW = `/api/v1/invites/${TOKEN}/preview`;
  const FACTS = {
    organiser_first_name: "Nomsa", court_name: "Court 2",
    starts_at: "2026-10-01T16:00:00Z", ends_at: "2026-10-01T16:45:00Z",
    share_minutes: 25, timezone: "Africa/Johannesburg",
  };

  function openSignedOut(routes: StubRoute[] = [{ path: PREVIEW, body: FACTS }]) {
    stubFetch(routes);
    renderPage(
      <Routes>
        <Route path="/j/:token" element={<InviteLinkPage />} />
        <Route path="/login" element={<FromProbe />} />
        <Route path="/register" element={<p>The join page</p>} />
      </Routes>,
      { initialEntries: [`/j/${TOKEN}`], reactStrictMode: true },
    );
  }

  it("shows the anonymous preview's facts (B4) — who, where, when, the share — and nothing else", async () => {
    openSignedOut();
    const facts = await screen.findByText(INVITES_COPY.previewInvited("Nomsa"));
    const box = facts.closest("[data-invite-preview]") as HTMLElement;
    // 18:00 in the club's zone (UTC+2), whatever zone the test runner is in.
    expect(box).toHaveTextContent("Court 2 · Thu 1 Oct, 18:00–18:45");
    expect(box).toHaveTextContent(`${INVITES_COPY.yourShare} 25 min`);
    // R2 F2-7 — the facts are on screen: the subtitle never says "sign in to see" them.
    expect(screen.getByText(INVITES_COPY.signedOutBodyShown)).toBeInTheDocument();
    expect(screen.queryByText(INVITES_COPY.signedOutBody)).toBeNull();
    expect(screen.getByRole("link", { name: INVITES_COPY.signedOutJoin })).toHaveAttribute("href", "/register");
  });

  it("a link the club no longer answers (404) says it is closed, offers no joining and forgets the link", async () => {
    savePendingInvite(TOKEN, null);
    openSignedOut([{ path: PREVIEW, status: 404, body: { error: "invite_not_found" } }]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.signedOutGoneTitle })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: INVITES_COPY.signedOutJoin })).toBeNull();
    await waitFor(() => expect(pendingInvite("u-new-member")).toBeNull());
  });

  it("a preview that cannot be read (offline) still says an invite is waiting and offers both ways in", async () => {
    openSignedOut([]);
    expect(await screen.findByRole("heading", { level: 1, name: INVITES_COPY.signedOutTitle })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: INVITES_COPY.signedOutSignIn })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: INVITES_COPY.signedOutJoin })).toHaveAttribute("href", "/register");
    expect(screen.getByText(INVITES_COPY.signedOutJoinHint)).toBeInTheDocument();
  });

  it("signing in carries the link through /login and back", async () => {
    openSignedOut();
    fireEvent.click(await screen.findByRole("link", { name: INVITES_COPY.signedOutSignIn }));
    expect(await screen.findByTestId("from")).toHaveTextContent(`/j/${TOKEN}`);
  });

  it("keeps the link for whoever signs in next — so joining the club does not lose it", async () => {
    openSignedOut();
    await screen.findByRole("heading", { level: 1, name: INVITES_COPY.signedOutTitle });
    expect(pendingInvite("u-new-member")?.token).toBe(TOKEN);
  });
});

describe("R1 F2.5 / F2.7 — the link is remembered until it is answered", () => {
  it("opened and not answered (short of minutes), it is kept for this member", async () => {
    openLink([{ path: OPEN, body: invite({ spendable_minutes: 5, balance_minutes: 5 }) }]);
    await screen.findByText(invitedLine("Nomsa", true));
    await waitForPending(TOKEN);
    expect(pendingInvite(ME)?.userId).toBe(ME);
    expect(screen.getByRole("link", { name: INVITES_COPY.buyMinutes }).getAttribute("href"))
      .toBe(`/wallet/buy?returnTo=${encodeURIComponent(`/j/${TOKEN}`)}`);
  });

  it("an accept forgets it", async () => {
    savePendingInvite(TOKEN, ME);
    openLink([
      { path: OPEN, body: invite() },
      { method: "POST", path: `${OPEN}/accept`, body: {
        participant_id: "p4", booking_id: BOOKING, status: "accepted", share_minutes: 25, consented_minutes: 25, paid_minutes: 25, balance_minutes: 55,
      } },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: acceptLabel(25) }));
    expect(await screen.findByText(INVITES_COPY.acceptedTitle)).toBeInTheDocument();
    expect(pendingInvite(ME)).toBeNull();
  });

  it("a link this account opened before, now gone, says so — never 'sign out'", async () => {
    savePendingInvite(TOKEN, ME);
    openLink([{ path: OPEN, status: 404, body: { error: "invite_not_found" } }]);
    expect(await screen.findByText(INVITES_COPY.linkNoLongerOpen)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: INVITES_COPY.signOutToOpen })).toBeNull();
    expect(pendingInvite(ME)).toBeNull();
  });
});

async function waitForPending(token: string) {
  await waitFor(() => expect(pendingInvite(ME)?.token).toBe(token));
}

function FromProbe() {
  const state = useLocation().state as { from?: { pathname?: string } } | null;
  return <output data-testid="from">{state?.from?.pathname ?? ""}</output>;
}
