import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { minutesSpoken } from "@/lib/minutes";
import { DETAIL_ACTIONS, DETAIL_ADMIN, DETAIL_CANCELLED, DETAIL_COPY, PLAYERS_UNSURE } from "@/lib/playersCopy";
import { ALEX_SEAT, DETAIL_PATH, ME, PID, SAM, SAM_SEAT, adminView, detail, playerView, renderDetail, seat, serve } from "./detailKit";

/**
 * Review round 18, lane FE18m — the booking page.
 *
 * <ul>
 *   <li><b>J18-6 / E18-5</b> — a cancelled game told a partner "any share you'd paid went back to you"
 *   when they had paid the organiser by hand (nothing moved in the app) or had paid nothing on a game
 *   that had started.</li>
 *   <li><b>J18-7</b> — the organiser's own seat on a solo or club-made booking has no participant id,
 *   so it never read "(you)".</li>
 *   <li><b>L18-7</b> — a cancelled game nobody scanned drew two empty wrappers (a 96px gap).</li>
 *   <li><b>L18-8</b> — an admin was offered "Add a player" and seat menus on a cancelled game (409).</li>
 *   <li><b>X18-1</b> — a reminder answered `503 conflict_retry` said "The club didn't answer".</li>
 * </ul>
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const cancelledShare = () => document.querySelector("[data-cancelled-share]");

function partnerOnCancelled(me: Partial<typeof ALEX_SEAT>, startedAt: string | null = null) {
  return playerView({
    status: "cancelled", cancelled_by: "club",
    players: [seat({ user_id: SAM, name: "Sam Petersen" }), seat({ ...ALEX_SEAT, status: "accepted", unpaid_minutes: 0, ...me })],
    attendance: { checked_in_at: startedAt, players_checked_in: startedAt ? 1 : 0 },
    permissions: { ...playerView().permissions, can_accept: false, can_decline: false },
  });
}

describe("J18-6 / E18-5 — a cancelled game says what became of THIS seat's share", () => {
  it("paid the organiser by hand: nothing moved in the app — never 'went back to you'", async () => {
    serve({ detail: partnerOnCancelled({ settled_outside: true, paid_minutes: 0 }) });
    renderDetail();
    await waitFor(() => expect(cancelledShare()).toHaveTextContent(DETAIL_CANCELLED.partnerByHand("Sam")));
    expect(cancelledShare()).not.toHaveTextContent(/went back/);
  });

  it("paid nothing on a game that had started: nothing moved", async () => {
    serve({ detail: partnerOnCancelled({ paid_minutes: 0 }, "2026-09-30T16:02:00Z") });
    renderDetail();
    await waitFor(() => expect(cancelledShare()).toHaveTextContent(DETAIL_CANCELLED.partnerStartedNothing));
    expect(cancelledShare()).not.toHaveTextContent(/went back/);
  });

  it("paid nothing on a game that never started: nothing to pay, and no claim that anything went back", async () => {
    serve({ detail: partnerOnCancelled({ paid_minutes: 0 }) });
    renderDetail();
    await waitFor(() => expect(cancelledShare()).toHaveTextContent(DETAIL_CANCELLED.partnerNothing));
    expect(cancelledShare()).not.toHaveTextContent(/went back/);
  });

  it("a share that DID go back is said with its figure", async () => {
    serve({ detail: partnerOnCancelled({ paid_minutes: 0, returned_minutes: 25 }) });
    renderDetail();
    await waitFor(() => expect(cancelledShare()?.textContent?.replace(/\u00a0/g, " ")).toBe(DETAIL_CANCELLED.partnerBack(minutesSpoken(25))));
  });
});

describe("J18-7 — the organiser's own seat reads '(you)' when it has no participant id", () => {
  it("a solo booking: the seat says (you)", async () => {
    const solo = detail({
      viewer: { role: "organiser", participant_id: null },
      players: [seat({ participant_id: null, user_id: ME })],
      money: { ...detail().money, is_split: false, shares_received_minutes: 0, organiser_net_minutes: 100, unpaid_minutes: 0 },
    });
    serve({ detail: solo });
    renderDetail();
    expect(await screen.findAllByText(DETAIL_COPY.you("Nomsa"))).not.toHaveLength(0);
  });

  it("a club-made split booking (organiser seat without an id): the chip AND the Who's paid line say (you)", async () => {
    const clubMade = detail({
      viewer: { role: "organiser", participant_id: null }, booked_by_club: true,
      players: [seat({ participant_id: null }), SAM_SEAT, ALEX_SEAT],
    });
    serve({ detail: clubMade });
    renderDetail();
    await waitFor(() => expect(screen.getAllByText(DETAIL_COPY.you("Nomsa")).length).toBeGreaterThanOrEqual(2));
  });

  it("another member's seat without a participant id is not (you)", async () => {
    serve({ detail: detail({ players: [seat(), seat({ ...SAM_SEAT, participant_id: null })] }) });
    renderDetail();
    await screen.findAllByText(DETAIL_COPY.you("Nomsa"));
    expect(screen.queryByText(DETAIL_COPY.you("Sam"))).toBeNull();
  });
});

describe("L18-7 / L18-8 — a cancelled game draws nothing empty and offers the admin nothing refused", () => {
  const cancelledOwn = detail({
    status: "cancelled", cancelled_by: "member",
    permissions: { ...detail().permissions, can_invite: false, can_cancel: false, can_change_split: false },
  });

  it("the organiser's cancelled game: no empty court column, no empty cancel wrapper", async () => {
    serve({ detail: cancelledOwn });
    renderDetail();
    await screen.findByText(DETAIL_CANCELLED.byYou);
    expect(document.querySelector("[data-detail-court]")).toBeNull();
    expect(document.querySelector("[data-detail-cancel]")).toBeNull();
  });

  it("a game still on keeps both", async () => {
    serve({ detail: detail() });
    renderDetail();
    await screen.findByRole("button", { name: DETAIL_ACTIONS.nudgeFor("Alex") });
    expect(document.querySelector("[data-detail-court]")).not.toBeNull();
    expect(document.querySelector("[data-detail-cancel]")).not.toBeNull();
  });

  it("an admin on a cancelled game: no 'Add a player', no seat menus, no empty admin block", async () => {
    serve({ admin: true, detail: adminView({ status: "cancelled", cancelled_by: "club" }) });
    renderDetail();
    await screen.findByText(DETAIL_CANCELLED.byClub);
    expect(screen.queryByRole("button", { name: DETAIL_ADMIN.add })).toBeNull();
    expect(screen.queryByRole("button", { name: DETAIL_ADMIN.menu("Alex") })).toBeNull();
    expect(document.querySelector("[data-detail-admin]")).toBeNull();
  });

  it("an admin on a game still on keeps them", async () => {
    serve({ admin: true, detail: adminView() });
    renderDetail();
    expect(await screen.findByRole("button", { name: DETAIL_ADMIN.menu("Alex") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: DETAIL_ADMIN.add })).toBeInTheDocument();
  });
});

describe("X18-1 — a reminder answered conflict_retry is said as that", () => {
  const nudge = `${DETAIL_PATH}/players/${PID.alex}/nudge`;
  const notice = () => document.querySelector("[data-detail-notice]");

  it("503 conflict_retry: someone else was changing the booking — never 'didn't answer'", async () => {
    serve({ extra: [{ method: "POST", path: nudge, status: 503, body: { error: "conflict_retry" } }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.nudgeFor("Alex") }));
    await waitFor(() => expect(notice()).toHaveTextContent(PLAYERS_UNSURE.nudgeConflict("Alex")));
    expect(notice()).not.toHaveTextContent(/didn't answer/);
  });

  it("a plain 503 keeps 'didn't answer'", async () => {
    serve({ extra: [{ method: "POST", path: nudge, status: 503, body: { error: "unavailable" } }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.nudgeFor("Alex") }));
    await waitFor(() => expect(notice()).toHaveTextContent(PLAYERS_UNSURE.nudge("Alex")));
  });
});
