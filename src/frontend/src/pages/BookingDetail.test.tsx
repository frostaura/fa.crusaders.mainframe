import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut, unreachable } from "@/test/harness";
import {
  DETAIL_ADMIN, DETAIL_ATTENDANCE, DETAIL_CANCEL, DETAIL_COPY, DETAIL_MONEY, DETAIL_PLAYER, PLAYERS_REFUSAL, STATUS_WORD,
} from "@/lib/playersCopy";
import {
  ALEX_SEAT, DETAIL_PATH, OPEN_SEAT, PID, SAM_SEAT, adminView, detail, playerView, renderDetail, seat, serve,
} from "@/components/players/__tests__/detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * The booking's own page, in each of its states: the organiser's, a player's, an admin's, the
 * 404 every former player reads, and a failed read. Every render is in StrictMode.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const chip = (name: RegExp) => screen.getByRole("listitem", { name });

describe("booking detail — the organiser's view", () => {
  it("names the court and time in the club's zone, with the way back to Bookings", async () => {
    serve();
    renderDetail();
    expect(await screen.findByRole("heading", { level: 1, name: "Court 1 · Wed 30 Sep, 18:00–18:45" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: DETAIL_COPY.back })).toHaveAttribute("href", "/bookings");
    expect(screen.getByRole("button", { name: DETAIL_COPY.refresh })).toBeInTheDocument();
    expect(screen.getByText(DETAIL_COPY.organisedByYou)).toBeInTheDocument();
  });

  it("puts four seats in two teams, each chip a first name and a status word", async () => {
    serve();
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    expect(chip(/^Nomsa \(you\), Organiser$/)).toBeInTheDocument();
    expect(chip(/^Sam, Paid$/)).toBeInTheDocument();
    expect(chip(/^Alex, Invited$/)).toBeInTheDocument();
    expect(chip(new RegExp(`^Open seat, ${STATUS_WORD.open_link}$`))).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: DETAIL_COPY.teamA })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: DETAIL_COPY.teamB })).toBeInTheDocument();
    // Never the surname, never an email: the grid's own rule.
    expect(screen.queryByText(/Petersen|Naidoo/)).not.toBeInTheDocument();
  });

  it("shows the money: the price, what was covered, shares in, and who has not paid — without debt words", async () => {
    serve();
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    const money = screen.getByRole("region", { name: DETAIL_MONEY.title });
    expect(within(money).getByText(DETAIL_MONEY.deadline("Fri 2 Oct, 20:45"))).toBeInTheDocument();
    expect(within(money).getByText(DETAIL_MONEY.received).nextSibling).toHaveTextContent("25 min");
    expect(within(money).getByText(DETAIL_MONEY.net(null)).nextSibling).toHaveTextContent("1 h 15 min");
    expect(within(money).getByText(DETAIL_MONEY.paidRow("25 min", "25 min"))).toBeInTheDocument();
    expect(within(money).getByText(DETAIL_MONEY.unpaidSentence("Alex", "Fri 2 Oct, 20:45", DETAIL_MONEY.toYou))).toBeInTheDocument();
    expect(money).not.toHaveTextContent(/debt|owe/i);
  });

  it("R1 F2.2: 'Shares not paid yet' is the server's unpaid figure — open link seats included (contract §4)", async () => {
    // Alex (member, 25) and the open seat (25) are both unpaid: the server says 50, and so does the page.
    serve({ detail: detail({ money: { ...detail().money, unpaid_minutes: 50 } }) });
    renderDetail();
    const money = await screen.findByRole("region", { name: DETAIL_MONEY.title });
    expect(within(money).getByText(DETAIL_MONEY.stillToCome).nextSibling).toHaveTextContent("50 min");
  });

  it("marks who has checked in, per seat and in total", async () => {
    serve({ detail: detail({
      players: [seat({ checked_in_at: "2026-09-30T15:58:00Z" }), SAM_SEAT, ALEX_SEAT, OPEN_SEAT],
      attendance: { checked_in_at: "2026-09-30T15:58:00Z", players_checked_in: 1 },
    }) });
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    expect(within(chip(/^Nomsa/)).getByText(DETAIL_COPY.checkedIn)).toBeInTheDocument();
    expect(screen.getByText(DETAIL_ATTENDANCE.checkedInAt("17:58"))).toBeInTheDocument();
    expect(screen.getByText(DETAIL_ATTENDANCE.count(1, 4))).toBeInTheDocument();
  });

  it("warns that partners are refunded and a late penalty is the organiser's alone, beside Cancel", async () => {
    serve();
    renderDetail();
    const section = await screen.findByRole("region", { name: DETAIL_CANCEL.title });
    expect(section).toHaveTextContent(DETAIL_CANCEL.partnersBack);
    expect(section).toHaveTextContent(DETAIL_CANCEL.penaltyYours);
    expect(within(section).getByRole("button", { name: DETAIL_CANCEL.open })).toBeInTheDocument();
  });

  it("opens the grid's own cancel sheet with the server's quote", async () => {
    serve({ extra: [{
      path: `${DETAIL_PATH}/cancellation-quote`,
      body: { bookingId: "x", amountChargedMinutes: 100, refundMinutes: 100, penaltyMinutes: 0, penaltyPct: 30, penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false },
    }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_CANCEL.open }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveAttribute("data-sheet", "cancel");
  });

  it("shows the former players to the organiser, apart from the four seats", async () => {
    serve({ detail: detail({ players: [seat(), SAM_SEAT, ALEX_SEAT, OPEN_SEAT, seat({ participant_id: "p-jo", seat: 3, team: "B", kind: "member", user_id: "u-jo", name: "Jo van Wyk", status: "declined" })] }) });
    renderDetail();
    await screen.findByRole("heading", { name: DETAIL_COPY.formerTitle });
    expect(chip(/^Jo, Declined$/)).toBeInTheDocument();
    expect(chip(/^Alex, Invited$/)).toBeInTheDocument();
  });

  it("offers no god mode to a member", async () => {
    serve();
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("region", { name: DETAIL_ADMIN.title })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Admin actions/ })).not.toBeInTheDocument();
  });
});

describe("booking detail — a player's view", () => {
  it("shows their share and a link to review it — never a second accept sheet", async () => {
    serve({ detail: playerView() });
    renderDetail();
    const mine = await screen.findByRole("region", { name: DETAIL_PLAYER.title });
    expect(within(mine).getByText(DETAIL_PLAYER.toPay).nextSibling).toHaveTextContent("25 min");
    const review = within(mine).getByRole("link", { name: DETAIL_PLAYER.review });
    expect(review).toHaveAttribute("href", `/invites/${PID.alex}`);
    expect(within(mine).getByRole("button", { name: DETAIL_PLAYER.decline })).toBeInTheDocument();
    expect(screen.getByText(DETAIL_COPY.organisedBy("Sam"))).toBeInTheDocument();
    // A player has no organiser's hand.
    expect(screen.queryByRole("button", { name: /^Remind / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: DETAIL_CANCEL.open })).not.toBeInTheDocument();
  });

  it("sees co-players' paid and unpaid figures, and whose cover an unpaid share lapses to", async () => {
    const jo = seat({ ...SAM_SEAT, participant_id: "p-jo", seat: 4, team: "B", user_id: "u-jo", name: "Jo van Wyk", paid_minutes: 0, unpaid_minutes: 25 });
    serve({ detail: playerView({ players: [seat({ user_id: "u-sam", name: "Sam Petersen" }), SAM_SEAT, ALEX_SEAT, jo] }) });
    renderDetail();
    const money = await screen.findByRole("region", { name: DETAIL_MONEY.title });
    expect(within(money).getByText(DETAIL_MONEY.paidRow("25 min", "25 min"))).toBeInTheDocument();
    expect(within(money).getByText(DETAIL_MONEY.unpaidRow("25 min"))).toBeInTheDocument();
    expect(within(money).getByText(DETAIL_MONEY.unpaidSentence("Jo", "Fri 2 Oct, 20:45", "Sam"))).toBeInTheDocument();
    expect(within(money).getByText(DETAIL_MONEY.organiserPaid("Sam"))).toBeInTheDocument();
    // Their own unpaid share is said to them in their own panel, not in the third person.
    expect(within(money).queryByText(DETAIL_MONEY.unpaidSentence("Alex", "Fri 2 Oct, 20:45", "Sam"))).not.toBeInTheDocument();
  });

  it("says when pulling out closes, beside the button", async () => {
    serve({ detail: playerView({
      players: [seat({ user_id: "u-sam", name: "Sam Petersen" }), SAM_SEAT, { ...ALEX_SEAT, status: "accepted", paid_minutes: 25, unpaid_minutes: 0 }, OPEN_SEAT],
      permissions: { ...playerView().permissions, can_accept: false, can_decline: false, can_withdraw: true },
    }) });
    renderDetail();
    expect(await screen.findByText(DETAIL_PLAYER.withdrawUntil("Wed 30 Sep, 16:00"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: DETAIL_PLAYER.withdraw })).toBeInTheDocument();
    expect(screen.getByText(DETAIL_PLAYER.paidAll)).toBeInTheDocument();
  });
});

describe("booking detail — an admin's view", () => {
  it("offers god mode on each partner seat and the add, and says it lands in the change log", async () => {
    serve({ admin: true, detail: adminView() });
    renderDetail();
    const god = await screen.findByRole("region", { name: DETAIL_ADMIN.title });
    expect(god).toHaveTextContent(DETAIL_ADMIN.description);
    expect(within(god).getByRole("button", { name: DETAIL_ADMIN.add })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: DETAIL_ADMIN.menu("Alex") })).toBeInTheDocument();
    // The organiser's own seat has nothing for god mode to do.
    expect(screen.queryByRole("button", { name: DETAIL_ADMIN.menu("Sam") })).not.toBeInTheDocument();
  });
});

describe("booking detail — not there, or not yours", () => {
  it("answers a 404 with the sentence and the way back, never a retry", async () => {
    serve({ detail: { path: DETAIL_PATH, status: 404, body: { error: "booking_not_found" } } });
    renderDetail();
    expect(await screen.findByText(PLAYERS_REFUSAL.booking_not_found)).toBeInTheDocument();
    expect(screen.getByText(DETAIL_COPY.notFoundTitle)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: DETAIL_COPY.backToBookings })).toHaveAttribute("href", "/bookings");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("says a failed read as a failure, with a retry that reads again", async () => {
    const stub = serve({ detail: unreachable(DETAIL_PATH) });
    renderDetail();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't read this booking/);
    const before = stub.calls.filter((c) => c.path === DETAIL_PATH).length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(stub.calls.filter((c) => c.path === DETAIL_PATH).length).toBeGreaterThan(before));
  });

  it("shows a skeleton, never 'Loading…', while it reads", async () => {
    serve();
    renderDetail();
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
    expect(document.querySelector("[data-state-block='loading'][aria-busy='true']")).not.toBeNull();
    await screen.findByRole("heading", { level: 1, name: /Court 1/ });
  });
});
