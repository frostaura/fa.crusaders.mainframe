import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation, useNavigate } from "react-router-dom";
import InvitesPage from "./Invites";
import { SPLIT_PANE_COPY } from "../lib/inboxCopy";
import { refuse, renderPage, signIn, signOut, stubFetch, type FetchStub, type StubRoute } from "../test/harness";
import {
  INVITES_COPY, INVITE_REFUSAL, INVITE_UNSURE, OWED_BACK_EXPLAINER, PLAYERS_UNSURE, acceptLabel, askedAgainLine, owedBackLine, playersRefusal, shortByLine,
} from "../lib/playersCopy";
import { ApiError } from "../lib/api";
import { savePendingInvite } from "../lib/playersPending";

/**
 * Invites (`/bookings/invites`) and its accept sheet: the list and its three states, the figures
 * the sheet shows (on SPENDABLE minutes), what Accept sends, and every way it can be refused.
 */
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { vi.unstubAllGlobals(); signOut(); window.localStorage.clear(); });

const BOOKING = "b0000000-0000-0000-0000-000000000001";
const SEAT = "p0000000-0000-0000-0000-000000000003";
const ACCEPT = `/api/v1/bookings/${BOOKING}/players/${SEAT}/accept`;
const DECLINE = `/api/v1/bookings/${BOOKING}/players/${SEAT}/decline`;

function at(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
}

function invite(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participant_id: SEAT, booking_id: BOOKING, status: "invited", seat: 3, team: "B", open_link: false,
    court_name: "Court 1", starts_at: at(24), ends_at: at(24.75),
    organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen", photo_url: null },
    players: 4, share_minutes: 25, to_pay_minutes: 25, needs_consent: false,
    balance_minutes: 120, spendable_minutes: 100, held_minutes: 20, balance_after_minutes: 95, short_by_minutes: 0,
    share_deadline: at(26.75), cap: null,
    ...overrides,
  };
}

type Open = { invites?: unknown[]; routes?: StubRoute[]; invitesStatus?: number };

function openInvites({ invites = [invite()], routes = [], invitesStatus }: Open = {}): FetchStub {
  const stub = stubFetch([
    ...routes,
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", sequence: [
      { balance_minutes: 120, held_minutes: 20, spendable_minutes: 100, held_until: at(26.75), entries: [], total_entries: 0, offset: 0, limit: 10 },
      { balance_minutes: 95, held_minutes: 20, spendable_minutes: 75, held_until: at(26.75), entries: [], total_entries: 0, offset: 0, limit: 10 },
    ] },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/invites", status: invitesStatus, body: { items: invites, count: invites.length } },
  ]);
  renderPage(<InvitesPage />, { initialEntries: ["/bookings/invites"], reactStrictMode: true });
  return stub;
}

async function openSheet() {
  fireEvent.click(await screen.findByRole("button", { name: /Sam invited you to play/ }));
  return screen.findByRole("dialog", { name: INVITES_COPY.sheetTitle });
}

/** R1 F2.5 — the top-up carries the way back to the invite. */
const TOP_UP = `/wallet/buy?returnTo=${encodeURIComponent("/bookings/invites")}`;

const acceptCalls = (stub: FetchStub) => stub.calls.filter((c) => c.method === "POST" && c.path === ACCEPT);

describe("the list", () => {
  it("shows each invite: who asked, the court, the players, your share and its state", async () => {
    openInvites({ invites: [invite(), invite({ participant_id: "p2", needs_consent: true, status: "accepted", share_minutes: 30, to_pay_minutes: 5 }),
      invite({ participant_id: "p3", status: "accepted", to_pay_minutes: 10 })] });
    const list = await screen.findByRole("list", { name: INVITES_COPY.listLabel });
    // Each card's open button (R5 §3.5: the card also carries its answers on a phone).
    const cards = Array.from(list.querySelectorAll<HTMLElement>("[data-invite]"));
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent("Sam invited you to play");
    expect(cards[0]).toHaveTextContent("Court 1");
    expect(cards[0]).toHaveTextContent("4 players");
    expect(cards[0]).toHaveTextContent("Your share 25 min");
    expect(cards[0]).toHaveTextContent(INVITES_COPY.statusWaiting);
    expect(cards[1]).toHaveTextContent(INVITES_COPY.statusAskedAgain);
    expect(cards[2]).toHaveTextContent("Accepted — 10 minutes still to pay");
    // First names between members — never the surname.
    expect(list).not.toHaveTextContent("Petersen");
  });

  it("R1 F2.5: an open seat from a link the member opened (short of minutes) is offered first, as a link back to it", async () => {
    savePendingInvite("tok123", "44444444-4444-4444-4444-444444444444");
    openInvites({ invites: [], routes: [
      { path: "/api/v1/invites/tok123", body: invite({ participant_id: "p-open", open_link: true }) },
    ] });
    const card = await screen.findByRole("link", { name: /Sam invited you to take a seat/ });
    expect(card).toHaveAttribute("href", "/j/tok123");
    expect(card).toHaveTextContent(INVITES_COPY.pendingFrom);
    expect(screen.queryByText(INVITES_COPY.emptyTitle)).toBeNull();
  });

  it("says plainly when nothing is waiting, and how invites arrive", async () => {
    openInvites({ invites: [] });
    expect(await screen.findByText(INVITES_COPY.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(INVITES_COPY.emptyHint)).toBeInTheDocument();
  });

  it("a failed read is a failure — never an empty list", async () => {
    openInvites({ invitesStatus: 500, invites: [] });
    expect(await screen.findByText(/Couldn't read your invites/)).toBeInTheDocument();
    expect(screen.queryByText(INVITES_COPY.emptyTitle)).toBeNull();
  });

  it("a dropped connection offers a retry, and the retry reads again", async () => {
    let fail = true;
    openInvites({ routes: [{ path: "/api/v1/me/invites", respond: () => {
      if (fail) throw new Error("offline");
      return { items: [invite()], count: 1 };
    } }] });
    const retry = await screen.findByRole("button", { name: "Try again" });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByRole("list", { name: INVITES_COPY.listLabel })).toBeInTheDocument();
  });

  it("shows a skeleton, not words, while it reads", async () => {
    openInvites();
    expect(document.querySelector('[data-state-block="loading"][aria-busy="true"]')).not.toBeNull();
    await screen.findByRole("list", { name: INVITES_COPY.listLabel });
  });

  it("has a Refresh icon button in the header", async () => {
    const stub = openInvites();
    await screen.findByRole("list", { name: INVITES_COPY.listLabel });
    const before = stub.calls.filter((c) => c.path === "/api/v1/me/invites").length;
    fireEvent.click(screen.getByRole("button", { name: INVITES_COPY.refresh }));
    await waitFor(() => expect(stub.calls.filter((c) => c.path === "/api/v1/me/invites").length).toBe(before + 1));
  });
});

/** The phone's Back, and where the router is — inside the page's router. */
function BackProbe() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return <><button type="button" onClick={() => navigate(-1)}>Phone back</button><output data-testid="where">{pathname}</output></>;
}

describe("Back with the accept sheet open (R1, F1.19's rule)", () => {
  function openWithBack() {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: { balance_minutes: 120, held_minutes: 20, spendable_minutes: 100, held_until: at(26.75), entries: [], total_entries: 0, offset: 0, limit: 10 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
      { path: "/api/v1/me/invites", body: { items: [invite()], count: 1 } },
    ]);
    renderPage(<><InvitesPage /><BackProbe /></>, { initialEntries: ["/bookings", "/bookings/invites"], reactStrictMode: true });
  }

  it("closes the sheet and stays on Invites", async () => {
    openWithBack();
    await openSheet();
    fireEvent.click(screen.getByRole("button", { name: "Phone back", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("where")).toHaveTextContent("/bookings/invites");
    expect(await screen.findByRole("list", { name: INVITES_COPY.listLabel })).toBeInTheDocument();
  });

  it("closed with its own button, a later Back leaves Invites as it would have", async () => {
    openWithBack();
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: INVITES_COPY.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/bookings/invites"));
    fireEvent.click(screen.getByRole("button", { name: "Phone back" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/bookings$/));
  });
});

/** The game's club day's grid, with this member's caps in its `rules` (R11 J11-3). */
const dayWithCaps = (rules: Record<string, unknown>): StubRoute => ({
  path: "/api/v1/schedule", body: { date: "2026-10-04", timezone: "Africa/Johannesburg", sliceMinutes: 15, courts: [], slots: [], rules },
});

describe("the accept sheet", () => {
  it("shows the game, your share, spendable, balance after, what is held and the deadline", async () => {
    openInvites({ routes: [dayWithCaps({ maxSlotsPerDay: 4, maxMinutesPerDay: 60 })] });
    const sheet = await openSheet();
    expect(sheet).toHaveTextContent("Court 1");
    expect(sheet).toHaveTextContent("Sam");
    expect(within(sheet).getByText(INVITES_COPY.yourShare).nextSibling).toHaveTextContent("25 minutes");
    // Spendable (100), not the raw balance (120): 100 − 25 = 75.
    expect(within(sheet).getByText(INVITES_COPY.availableNow).nextSibling).toHaveTextContent("1 hour 40 minutes");
    expect(within(sheet).getByText(INVITES_COPY.availableAfter).nextSibling).toHaveTextContent("1 hour 15 minutes");
    expect(sheet).toHaveTextContent("20 minutes held");
    expect(sheet).toHaveTextContent(/held until 48 hours after each game/);
    expect(sheet).toHaveTextContent(/lapses to Sam — no debt either way/);
    expect(await within(sheet).findByText(INVITES_COPY.capCounts)).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /^Close / })).toBeInTheDocument();
  });

  it("R11 J11-3: says nothing about a daily limit to a member who has none", async () => {
    const stub = openInvites({ routes: [dayWithCaps({ maxSlotsPerDay: 0, maxMinutesPerDay: 0 })] });
    const sheet = await openSheet();
    await waitFor(() => expect(stub.calls.some((c) => c.path.startsWith("/api/v1/schedule"))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(sheet).not.toHaveTextContent(INVITES_COPY.capCounts);
  });

  it("R11 J11-3: an unknown cap (the day could not be read) is not a limit either", async () => {
    openInvites({ routes: [{ path: "/api/v1/schedule", status: 503, body: {} }] });
    const sheet = await openSheet();
    await new Promise((r) => setTimeout(r, 100));
    expect(sheet).not.toHaveTextContent(INVITES_COPY.capCounts);
  });

  it("accepts with the share it SHOWED, applies the new balance and confirms calmly", async () => {
    let accepted = false;
    const stub = openInvites({
      routes: [
        { path: "/api/v1/me/invites", respond: () => (accepted ? { items: [], count: 0 } : { items: [invite()], count: 1 }) },
        { method: "POST", path: ACCEPT, respond: () => {
          accepted = true;
          return { participant_id: SEAT, booking_id: BOOKING, status: "accepted", share_minutes: 25, consented_minutes: 25, paid_minutes: 25, balance_minutes: 95 };
        } },
      ],
    });
    const sheet = await openSheet();
    const walletReads = () => stub.calls.filter((c) => c.path.split("?")[0] === "/api/v1/wallet").length;
    await waitFor(() => expect(walletReads()).toBeGreaterThan(0));
    const before = walletReads();
    fireEvent.click(within(sheet).getByRole("button", { name: acceptLabel(25) }));
    expect(await within(sheet).findByText(INVITES_COPY.acceptedTitle)).toBeInTheDocument();
    expect(acceptCalls(stub)).toHaveLength(1);
    expect(acceptCalls(stub)[0].body).toEqual({ expectedShareMinutes: 25 });
    expect(sheet).toHaveTextContent("25 minutes paid to Sam");
    expect(within(sheet).getByRole("link", { name: INVITES_COPY.seeBooking })).toHaveAttribute("href", `/bookings/${BOOKING}`);
    await waitFor(() => expect(walletReads()).toBeGreaterThan(before));
    // The list is read again — and the sheet keeps its confirmation although the seat left it.
    await waitFor(() => expect(screen.getByText(INVITES_COPY.emptyTitle)).toBeInTheDocument());
    expect(within(sheet).getByText(INVITES_COPY.acceptedTitle)).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: INVITES_COPY.done })).toBeInTheDocument();
  });

  it("a risen share is shown and asked again — never retried by itself", async () => {
    let raised = false;
    const stub = openInvites({
      routes: [
        // The organiser raised the share after the list was read: the next read has the new figure.
        { path: "/api/v1/me/invites", respond: () => ({ items: [raised ? invite({ share_minutes: 30, to_pay_minutes: 30 }) : invite()], count: 1 }) },
        { method: "POST", path: ACCEPT, respond: ({ body }) => {
          raised = true;
          return (body as { expectedShareMinutes: number }).expectedShareMinutes < 30
            ? refuse(409, { error: "share_changed", share_minutes: 30 })
            : { participant_id: SEAT, booking_id: BOOKING, status: "accepted", share_minutes: 30, consented_minutes: 30, paid_minutes: 30, balance_minutes: 90 };
        } },
      ],
    });
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: acceptLabel(25) }));
    const sentence = playersRefusal(new ApiError(409, { error: "share_changed", share_minutes: 30 }));
    expect(await within(sheet).findByText(sentence)).toBeInTheDocument();
    // The fresh figure reaches the label, and nothing was sent a second time.
    const again = await within(sheet).findByRole("button", { name: acceptLabel(30) });
    expect(acceptCalls(stub)).toHaveLength(1);
    fireEvent.click(again);
    expect(await within(sheet).findByText(INVITES_COPY.acceptedTitle)).toBeInTheDocument();
    expect(acceptCalls(stub).map((c) => c.body)).toEqual([{ expectedShareMinutes: 25 }, { expectedShareMinutes: 30 }]);
  });

  it("P11: owed back to partners comes off spendable, is named with its reason, and a negative spendable adds up", async () => {
    openInvites({ invites: [invite({ balance_minutes: 10, held_minutes: 0, owed_back_minutes: 16, spendable_minutes: -6, to_pay_minutes: 25 })] });
    const sheet = await openSheet();
    // −6 to spend and 25 to pay: 31 short, and the sheet's figures agree with each other.
    expect(within(sheet).getByText(INVITES_COPY.availableNow).nextSibling).toHaveTextContent("−6 min");
    const accept = within(sheet).getByRole("button", { name: acceptLabel(25) });
    expect(accept).toHaveAccessibleDescription(new RegExp(shortByLine(31).replace(/\./g, "\\.")));
    const owed = sheet.querySelector("[data-owed-back]");
    expect(owed).toHaveTextContent(owedBackLine(16));
    expect(owed).toHaveTextContent(OWED_BACK_EXPLAINER);
    expect(sheet.querySelector("[data-held]")).toBeNull();
  });

  it("says nothing about owing partners when nothing is owed", async () => {
    openInvites();
    const sheet = await openSheet();
    expect(sheet.querySelector("[data-owed-back]")).toBeNull();
  });

  it("short of spendable minutes: no Accept to press, the reason, and a Buy minutes", async () => {
    const stub = openInvites({ invites: [invite({ spendable_minutes: 10, balance_minutes: 30, to_pay_minutes: 25 })] });
    const sheet = await openSheet();
    const accept = within(sheet).getByRole("button", { name: acceptLabel(25) });
    expect(accept).toHaveAttribute("aria-disabled", "true");
    expect(accept).toHaveAccessibleDescription(new RegExp(shortByLine(15).replace(/\./g, "\\.")));
    expect(within(sheet).getByRole("link", { name: INVITES_COPY.buyMinutes })).toHaveAttribute("href", TOP_UP);
    // No "balance after" below zero — the accept never overdraws.
    expect(within(sheet).queryByText(INVITES_COPY.balanceAfter)).toBeNull();
    fireEvent.click(accept);
    expect(acceptCalls(stub)).toHaveLength(0);
  });

  it("a yes past the member's own daily limit is explained and cannot be pressed (D12)", async () => {
    const stub = openInvites({ invites: [invite({ cap: { cap: "slots", cap_slots: 4, booked_slots: 4, attempted_slots: 3, club_day: "2030-09-10" } })] });
    const sheet = await openSheet();
    expect(sheet).toHaveTextContent("Saying yes would take you past your limit of 4 slots a day on Tue 10 Sep.");
    expect(sheet).not.toHaveTextContent(INVITES_COPY.capCounts);
    const accept = within(sheet).getByRole("button", { name: acceptLabel(25) });
    expect(accept).toHaveAttribute("aria-disabled", "true");
    expect(accept).toHaveAccessibleDescription(/past your limit/);
    fireEvent.click(accept);
    expect(acceptCalls(stub)).toHaveLength(0);
  });

  it("R1 F2.14: a share of nothing names no deadline — nothing can lapse — on the card or the sheet", async () => {
    openInvites({ invites: [invite({ share_minutes: 0, to_pay_minutes: 0 })] });
    const card = await screen.findByRole("button", { name: /Sam invited you to play/ });
    expect(card).not.toHaveTextContent(/Pay by/);
    const sheet = await openSheet();
    expect(sheet.querySelector("[data-deadline]")).toBeNull();
    expect(sheet).not.toHaveTextContent(/lapses/);
  });

  it("an accepted seat asked again reads what is still to pay", async () => {
    openInvites({ invites: [invite({ status: "accepted", needs_consent: true, share_minutes: 30, to_pay_minutes: 5 })] });
    fireEvent.click(await screen.findByRole("button", { name: /Sam invited you to play/ }));
    const sheet = await screen.findByRole("dialog");
    // R4 M4-8 — they already said yes: the sheet says the share went up, not "Join this game?".
    expect(within(sheet).getByRole("heading", { name: INVITES_COPY.askedAgainTitle })).toBeInTheDocument();
    expect(within(sheet).queryByRole("heading", { name: INVITES_COPY.sheetTitle })).toBeNull();
    expect(within(sheet).getByText(askedAgainLine("Sam", 30))).toBeInTheDocument();
    expect(within(sheet).getByText(INVITES_COPY.toPayNow).nextSibling).toHaveTextContent("5 minutes");
    expect(within(sheet).getByRole("button", { name: acceptLabel(5) })).toBeInTheDocument();
    // Only an invited seat can be declined.
    expect(within(sheet).queryByRole("button", { name: INVITES_COPY.decline })).toBeNull();
  });

  it("declines, and says the organiser has been told", async () => {
    const stub = openInvites({ routes: [{ method: "POST", path: DECLINE, body: { participant_id: SEAT, status: "declined" } }] });
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: INVITES_COPY.decline }));
    fireEvent.click(within(sheet).getByRole("button", { name: INVITES_COPY.declineConfirm }));
    expect(await within(sheet).findByText(INVITES_COPY.declinedTitle)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST" && c.path === DECLINE)).toBe(true);
    expect(acceptCalls(stub)).toHaveLength(0);
  });

  it("R1 F2.6: Decline asks first — it is final — and keeping the invite sends nothing", async () => {
    const stub = openInvites({ routes: [{ method: "POST", path: DECLINE, body: { participant_id: SEAT, status: "declined" } }] });
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: INVITES_COPY.decline }));
    expect(stub.calls.some((c) => c.path === DECLINE)).toBe(false);
    expect(within(sheet).getByText(INVITES_COPY.declineFinal("Sam"))).toBeInTheDocument();
    // Accept is not offered beside a pending "decline for good" — one question at a time.
    expect(within(sheet).queryByRole("button", { name: acceptLabel(25) })).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: INVITES_COPY.declineKeep }));
    expect(within(sheet).getByRole("button", { name: acceptLabel(25) })).toBeInTheDocument();
    expect(within(sheet).queryByText(INVITES_COPY.declineFinal("Sam"))).toBeNull();
    expect(stub.calls.some((c) => c.path === DECLINE)).toBe(false);
  });

  const REFUSALS: [number, Record<string, unknown>][] = [
    [402, { error: "insufficient_balance", current_minutes: 10, required_minutes: 25 }],
    [409, { error: "partner_cap_exceeded", cap: "minutes", cap_minutes: 60, already_booked_minutes: 45, attempted_minutes: 45, club_day: "2030-09-10" }],
    [409, { error: "invite_closed" }],
    [409, { error: "already_in_booking" }],
    [409, { error: "player_previously_removed" }],
    [403, { error: "membership_inactive" }],
    [400, { error: "expected_share_required" }],
    [404, { error: "invite_not_found" }],
  ];

  it.each(REFUSALS)("a %i %o is a sentence, not a code", async (status, body) => {
    openInvites({ routes: [{ method: "POST", path: ACCEPT, status, body }] });
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: acceptLabel(25) }));
    const code = body.error as string;
    const expected = INVITE_REFUSAL[code] ?? playersRefusal(new ApiError(status, body));
    expect(await within(sheet).findByText(expected)).toBeInTheDocument();
    expect(sheet).not.toHaveTextContent(code);
    if (code === "insufficient_balance") {
      expect(within(sheet).getByRole("link", { name: INVITES_COPY.buyMinutes })).toHaveAttribute("href", TOP_UP);
    }
  });
});

/**
 * R2 F2-1 — an accept whose reply was lost after the club had taken the money. The seat's own
 * record is read back (`GET /me/invites/{pid}`) and believed; the wallet is read again either way.
 */
describe("an accept whose reply was lost (R2 F2-1)", () => {
  const MY_SEAT = `/api/v1/me/invites/${SEAT}`;
  function seatRecord(status: string) {
    return {
      participant_id: SEAT, booking_id: BOOKING, status, lapsed: false, settled_outside: false, booking_status: "booked",
      court_name: "Court 1", starts_at: at(24), ends_at: at(24.75), organiser_name: "Sam Petersen", share_minutes: 25,
      timezone: "Africa/Johannesburg",
    };
  }

  it("the club took it: says you're in, with the figure shown, and re-reads the wallet", async () => {
    const stub = openInvites({ routes: [
      // The action happened; only the reply was lost.
      { method: "POST", path: ACCEPT, status: 504, body: { error: "gateway_timeout" } },
      { path: MY_SEAT, body: seatRecord("accepted") },
    ] });
    const sheet = await openSheet();
    const walletReads = () => stub.calls.filter((c) => c.path.split("?")[0] === "/api/v1/wallet").length;
    await waitFor(() => expect(walletReads()).toBeGreaterThan(0));
    const before = walletReads();
    fireEvent.click(within(sheet).getByRole("button", { name: acceptLabel(25) }));
    expect(await within(sheet).findByText(INVITES_COPY.acceptedTitle)).toBeInTheDocument();
    expect(sheet).toHaveTextContent("25 minutes paid to Sam");
    expect(within(sheet).getByText(INVITE_UNSURE.provenNote)).toBeInTheDocument();
    expect(sheet).not.toHaveTextContent(/Couldn't accept/);
    expect(stub.calls.some((c) => c.path === MY_SEAT)).toBe(true);
    await waitFor(() => expect(walletReads()).toBeGreaterThan(before));
  });

  it("the club did not take it: says so — nothing taken — and Accept is offered again", async () => {
    openInvites({ routes: [
      { method: "POST", path: ACCEPT, status: 502, body: { error: "bad_gateway" } },
      { path: MY_SEAT, body: seatRecord("invited") },
    ] });
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: acceptLabel(25) }));
    expect(await within(sheet).findByText(INVITE_UNSURE.checked)).toBeInTheDocument();
    expect(await within(sheet).findByRole("button", { name: acceptLabel(25) })).toBeInTheDocument();
  });

  it("the seat cannot be read either: says it can't tell, never 'couldn't accept'", async () => {
    openInvites({ routes: [
      { method: "POST", path: ACCEPT, respond: () => { throw new Error("offline"); } },
      { path: MY_SEAT, status: 503, body: { error: "unavailable" } },
    ] });
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: acceptLabel(25) }));
    expect(await within(sheet).findByText(INVITE_UNSURE.unchecked)).toBeInTheDocument();
    expect(sheet).not.toHaveTextContent(/Couldn't accept/);
  });
});

describe("the sheet's structure and focus (R2 F2-10, F2-11)", () => {
  it("F2-10: Decline's question opens on 'Keep the invite' — a second Enter never declines — and keeping returns to Decline", async () => {
    openInvites({ routes: [{ method: "POST", path: DECLINE, body: { participant_id: SEAT, status: "declined" } }] });
    const sheet = await openSheet();
    const decline = within(sheet).getByRole("button", { name: INVITES_COPY.decline });
    decline.focus();
    fireEvent.click(decline);
    expect(within(sheet).getByRole("button", { name: INVITES_COPY.declineKeep })).toHaveFocus();
    fireEvent.click(within(sheet).getByRole("button", { name: INVITES_COPY.declineKeep }));
    expect(within(sheet).getByRole("button", { name: INVITES_COPY.decline })).toHaveFocus();
  });

  it("F2-11: every child of the facts list is a dt/dd group — no stray wrapper, no avatar straight in the dl", async () => {
    openInvites();
    const sheet = await openSheet();
    const lists = sheet.querySelectorAll("dl");
    expect(lists.length).toBeGreaterThan(0);
    for (const dl of lists) {
      for (const child of Array.from(dl.children)) {
        if (child.tagName === "DT" || child.tagName === "DD") continue;
        expect(child.tagName).toBe("DIV");
        expect(Array.from(child.children).map((c) => c.tagName)).toEqual(["DT", "DD"]);
      }
    }
    expect(within(sheet).getByText(INVITES_COPY.organiser).nextElementSibling).toHaveTextContent("Sam");
  });
});

/**
 * R3 I-3 — a decline whose reply was lost after the club had recorded it. The seat's own record
 * is read back and believed: declined is said as declined (Accept no longer offered); still
 * invited says nothing changed.
 */
describe("a decline whose reply was lost (R3 I-3)", () => {
  const MY_SEAT = `/api/v1/me/invites/${SEAT}`;
  function seatRecord(status: string) {
    return {
      participant_id: SEAT, booking_id: BOOKING, status, lapsed: false, settled_outside: false, booking_status: "booked",
      court_name: "Court 1", starts_at: at(24), ends_at: at(24.75), organiser_name: "Sam Petersen", share_minutes: 25,
      timezone: "Africa/Johannesburg",
    };
  }

  async function declineForGood(sheet: HTMLElement) {
    fireEvent.click(within(sheet).getByRole("button", { name: INVITES_COPY.decline }));
    fireEvent.click(await within(sheet).findByRole("button", { name: INVITES_COPY.declineConfirm }));
  }

  it("the club recorded it: says you said no, and stops offering Accept", async () => {
    let status = "invited";
    openInvites({ routes: [
      { method: "POST", path: DECLINE, respond: () => { status = "declined"; return refuse(504, { error: "gateway_timeout" }); } },
      { path: MY_SEAT, respond: () => seatRecord(status) },
    ] });
    const sheet = await openSheet();
    await declineForGood(sheet);
    expect(await within(sheet).findByText(INVITE_UNSURE.declineProvenNote)).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: acceptLabel(25) })).toBeNull();
    expect(sheet).not.toHaveTextContent(/Couldn't decline/);
  });

  it("the club did not record it: says you're still invited, nothing changed", async () => {
    openInvites({ routes: [
      { method: "POST", path: DECLINE, respond: () => refuse(504, { error: "gateway_timeout" }) },
      { path: MY_SEAT, body: seatRecord("invited") },
    ] });
    const sheet = await openSheet();
    await declineForGood(sheet);
    expect(await within(sheet).findByText(PLAYERS_UNSURE.decline.checked)).toBeInTheDocument();
  });
});

/** R3 I-9 — answering an invite marks its notice read on the server; the bell asks for the count again. */
describe("answering reads the unread count again (R3 I-9)", () => {
  const UNREAD = "/api/v1/me/notifications/unread-count";

  it("after an accept", async () => {
    const stub = openInvites({ routes: [
      { path: UNREAD, body: { unread_count: 0 } },
      { method: "POST", path: ACCEPT, body: { participant_id: SEAT, booking_id: BOOKING, status: "accepted", share_minutes: 25, consented_minutes: 25, paid_minutes: 25, balance_minutes: 95 } },
    ] });
    const sheet = await openSheet();
    const reads = () => stub.calls.filter((c) => c.path === UNREAD).length;
    const before = reads();
    fireEvent.click(within(sheet).getByRole("button", { name: acceptLabel(25) }));
    expect(await within(sheet).findByText(INVITES_COPY.acceptedTitle)).toBeInTheDocument();
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("after a decline", async () => {
    const stub = openInvites({ routes: [
      { path: UNREAD, body: { unread_count: 0 } },
      { method: "POST", path: DECLINE, body: { participant_id: SEAT, status: "declined" } },
    ] });
    const sheet = await openSheet();
    const reads = () => stub.calls.filter((c) => c.path === UNREAD).length;
    const before = reads();
    fireEvent.click(within(sheet).getByRole("button", { name: INVITES_COPY.decline }));
    fireEvent.click(await within(sheet).findByRole("button", { name: INVITES_COPY.declineConfirm }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });
});

/**
 * R4 (I4-1's rule, the integration leftover) — an answer on its way keeps the accept sheet open.
 * Accept moves money: a Cancel, Escape or Back pressed on a slow reply used to close the sheet in
 * silence and the share was taken a moment later. Now each is refused, said as waiting, and the
 * sheet closes as ever once the club has answered.
 */
describe("an answer on its way keeps the sheet open", () => {
  it("refuses Cancel, Escape and Back while Accept is in flight; says it is waiting; closes once answered", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: { balance_minutes: 120, held_minutes: 20, spendable_minutes: 100, held_until: at(26.75), entries: [], total_entries: 0, offset: 0, limit: 10 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
      { path: "/api/v1/me/invites", body: { items: [invite()], count: 1 } },
    ]);
    // The accept's reply is held until the test lets it go.
    const stubbed = globalThis.fetch;
    let land: () => void = () => undefined;
    const landed = new Promise<void>((resolve) => { land = resolve; });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input.toString();
      if ((init?.method ?? "GET").toUpperCase() === "POST" && path === ACCEPT) {
        return landed.then(() => new Response(JSON.stringify({ participant_id: SEAT, status: "accepted", paid_minutes: 25 }), { status: 200 }));
      }
      return stubbed(input, init);
    });
    renderPage(<><InvitesPage /><BackProbe /></>, { initialEntries: ["/bookings", "/bookings/invites"], reactStrictMode: true });
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: acceptLabel(25) }));
    expect(await within(sheet).findByText(INVITES_COPY.sending)).toBeInTheDocument();

    fireEvent.click(within(sheet).getByRole("button", { name: INVITES_COPY.cancel }));
    fireEvent.keyDown(sheet, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Phone back", hidden: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("dialog", { name: INVITES_COPY.sheetTitle })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/bookings/invites");

    land();
    await waitFor(() => expect(within(sheet).queryByText(INVITES_COPY.sending)).toBeNull());
    fireEvent.click(within(sheet).getByRole("button", { name: INVITES_COPY.done }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("R5 §3.5 — the answers on the card at phone width", () => {
  it("Decline on the card opens the sheet on 'Decline for good?', focus on the safe answer; nothing is sent", async () => {
    const stub = openInvites();
    const card = await screen.findByRole("group", { name: SPLIT_PANE_COPY.cardActionsLabel("Sam") });
    fireEvent.click(within(card).getByRole("button", { name: SPLIT_PANE_COPY.cardDecline }));
    const sheet = await screen.findByRole("dialog", { name: INVITES_COPY.sheetTitle });
    const keep = await within(sheet).findByRole("button", { name: INVITES_COPY.declineKeep });
    await waitFor(() => expect(keep).toHaveFocus());
    expect(within(sheet).getByRole("button", { name: INVITES_COPY.declineConfirm })).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST" && c.path === DECLINE)).toBe(false);
  });

  it("Accept on the card opens the sheet with the money stated first — nothing is sent until Accept & pay", async () => {
    const stub = openInvites();
    const card = await screen.findByRole("group", { name: SPLIT_PANE_COPY.cardActionsLabel("Sam") });
    fireEvent.click(within(card).getByRole("button", { name: SPLIT_PANE_COPY.cardAccept }));
    const sheet = await screen.findByRole("dialog", { name: INVITES_COPY.sheetTitle });
    expect(within(sheet).getByRole("button", { name: acceptLabel(25) })).toBeInTheDocument();
    expect(acceptCalls(stub)).toHaveLength(0);
  });

  it("an accepted seat with a share still to pay offers Accept only — it can no longer be declined", async () => {
    openInvites({ invites: [invite({ status: "accepted", to_pay_minutes: 10 })] });
    const card = await screen.findByRole("group", { name: SPLIT_PANE_COPY.cardActionsLabel("Sam") });
    expect(within(card).queryByRole("button", { name: SPLIT_PANE_COPY.cardDecline })).toBeNull();
    expect(within(card).getByRole("button", { name: SPLIT_PANE_COPY.cardAccept })).toBeInTheDocument();
  });
});

