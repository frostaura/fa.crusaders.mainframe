import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { refuse, signOut } from "@/test/harness";
import { ApiError } from "@/lib/api";
import { DETAIL_COPY, DETAIL_PLAYER, PLAYERS_REFUSAL, playersRefusal } from "@/lib/playersCopy";
import { ALEX_SEAT, DETAIL_PATH, OPEN_SEAT, PID, SAM_SEAT, playerView, renderDetail, seat, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * A partner's hand on the booking page: pull out (inside the window only), decline, and the
 * link to review the share — the accept itself is the invites lane's sheet.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const SEAT = `${DETAIL_PATH}/players/${PID.alex}`;

/** Alex has said yes and paid; the game is far enough off to pull out. */
function inView() {
  return playerView({
    players: [seat({ user_id: "u-sam", name: "Sam Petersen" }), SAM_SEAT, { ...ALEX_SEAT, status: "accepted", paid_minutes: 25, unpaid_minutes: 0, consented_minutes: 25 }, OPEN_SEAT],
    permissions: { ...playerView().permissions, can_accept: false, can_decline: false, can_withdraw: true },
  });
}

describe("pull out", () => {
  it("R1 F2.9: confirms, pulls out, and goes back to Bookings saying so — never 'Booking not found' beside the success", async () => {
    // The server's own rule: once pulled out, the detail is a 404 to them.
    let gone = false;
    const stub = serve({
      detail: { path: DETAIL_PATH, respond: () => (gone ? refuse(404, { error: "booking_not_found" }) : inView()) },
      extra: [{ method: "POST", path: `${SEAT}/withdraw`, respond: () => { gone = true; return { participant_id: PID.alex, status: "withdrawn" }; } }],
    });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_PLAYER.withdraw }));
    const dialog = screen.getByRole("dialog", { name: DETAIL_PLAYER.withdrawTitle });
    expect(dialog).toHaveTextContent(DETAIL_PLAYER.withdrawBody);
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_PLAYER.withdrawConfirm }));
    expect(await screen.findByText("The bookings grid")).toBeInTheDocument();
    expect(await screen.findByText(DETAIL_PLAYER.withdrawn)).toBeInTheDocument();
    expect(screen.queryByText(DETAIL_COPY.notFoundTitle)).toBeNull();
    expect(stub.calls.some((c) => c.method === "POST" && c.path === `${SEAT}/withdraw`)).toBe(true);
  });

  it("says a closed window as a sentence with the time, in the dialog", async () => {
    const body = { error: "withdraw_window_closed", closed_at: "2026-09-30T14:00:00Z" };
    serve({ detail: inView(), extra: [{ method: "POST", path: `${SEAT}/withdraw`, status: 409, body }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_PLAYER.withdraw }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: DETAIL_PLAYER.withdrawConfirm }));
    const sentence = playersRefusal(new ApiError(409, body));
    expect(sentence).toContain("Wed 30 Sep, 16:00");
    expect(await within(screen.getByRole("dialog")).findByText(sentence)).toBeInTheDocument();
  });

  it("says the window has closed, with no button, once it has", async () => {
    serve({ detail: playerView({ ...inView(), permissions: { ...inView().permissions, can_withdraw: false } }) });
    renderDetail();
    expect(await screen.findByText(DETAIL_PLAYER.withdrawClosed("Wed 30 Sep, 16:00"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: DETAIL_PLAYER.withdraw })).not.toBeInTheDocument();
  });
});

describe("decline", () => {
  it("confirms, declines, and says so", async () => {
    const stub = serve({ extra: [{ method: "POST", path: `${SEAT}/decline`, body: { participant_id: PID.alex, status: "declined" } }], detail: playerView() });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_PLAYER.decline }));
    const dialog = screen.getByRole("dialog", { name: DETAIL_PLAYER.declineTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_PLAYER.declineConfirm }));
    // A decline takes the member off the game, so the page would 404: back to Bookings, saying so.
    expect(await screen.findByText("The bookings grid")).toBeInTheDocument();
    expect(await screen.findByText(DETAIL_PLAYER.declined)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST" && c.path === `${SEAT}/decline`)).toBe(true);
  });

  it("keeps a refusal in the dialog", async () => {
    serve({ detail: playerView(), extra: [{ method: "POST", path: `${SEAT}/decline`, status: 409, body: { error: "not_invited" } }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_PLAYER.decline }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: DETAIL_PLAYER.declineConfirm }));
    expect(await screen.findByText(PLAYERS_REFUSAL.not_invited)).toBeInTheDocument();
  });
});

describe("review", () => {
  it("navigates to the invite's own accept sheet", async () => {
    serve({ detail: playerView() });
    renderDetail();
    fireEvent.click(await screen.findByRole("link", { name: DETAIL_PLAYER.review }));
    expect(await screen.findByText("The accept sheet")).toBeInTheDocument();
  });

  it("asks again when the share went up since they said yes", async () => {
    serve({ detail: playerView({
      players: [seat({ user_id: "u-sam", name: "Sam Petersen" }), SAM_SEAT, { ...ALEX_SEAT, status: "accepted", share_minutes: 30, consented_minutes: 25, paid_minutes: 25, unpaid_minutes: 5, needs_consent: true }],
    }) });
    renderDetail();
    expect(await screen.findByText(DETAIL_PLAYER.askedAgain("30 min"))).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Alex (you), Asked again" })).toBeInTheDocument();
  });
});
