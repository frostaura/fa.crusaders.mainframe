import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { DETAIL_ATTENDANCE, DETAIL_CANCELLED, DETAIL_MONEY, DETAIL_PLAYER, STATUS_WORD } from "@/lib/playersCopy";
import { RESULT_CARD } from "@/lib/playCopy";
import {
  ALEX_SEAT, DETAIL_PATH, OPEN_SEAT, PID, SAM_SEAT, adminView, detail, playerView, renderDetail, seat, serve,
} from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R1 F2.10 / F2.15 — a cancelled booking says only what is true (who was on it, what came back),
 * and the result card is asked for only by the game's own players while it can still matter.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const CANCELLED_PERMISSIONS = {
  can_invite: false, can_change_split: false, can_cancel: false, can_accept: false, can_decline: false,
  can_withdraw: false, withdraw_closes_at: "2026-09-30T14:00:00Z",
};

/** Cancelled before anybody scanned: the organiser refunded in full, Sam's 25 back to him. */
function cancelled(overrides = {}) {
  return detail({
    status: "cancelled",
    players: [seat(), { ...SAM_SEAT, paid_credits: 0, target_credits: 0 }, ALEX_SEAT, OPEN_SEAT],
    money: {
      price_credits: 100, organiser_owed_credits: 0, shares_received_credits: 0, organiser_net_credits: 0,
      unpaid_credits: 0, share_deadline: "2026-10-02T18:45:00Z", is_split: true,
    },
    permissions: CANCELLED_PERMISSIONS,
    ...overrides,
  });
}

const resultReads = (calls: { method: string; path: string }[]) => calls.filter((c) => c.path === `${DETAIL_PATH}/result`).length;

describe("a cancelled booking (R1 F2.10)", () => {
  it("says it was cancelled, and who was on it — never 'In' or an open invite", async () => {
    serve({ detail: cancelled() });
    renderDetail();
    expect(await screen.findByText(DETAIL_CANCELLED.banner)).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: `Sam, ${STATUS_WORD.was_in}` })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: `Alex, ${STATUS_WORD.invite_closed}` })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: `Open seat, ${STATUS_WORD.invite_closed}` })).toBeInTheDocument();
    expect(screen.queryByText(STATUS_WORD.accepted, { selector: "span" })).toBeNull();
  });

  it("the money says what came back — no deadline, no 'not paid yet', no 'Paid 0.00 of'", async () => {
    serve({ detail: cancelled() });
    renderDetail();
    const money = await screen.findByRole("region", { name: DETAIL_MONEY.title });
    expect(money).toHaveTextContent(DETAIL_CANCELLED.moneyNote);
    expect(within(money).getByText(DETAIL_CANCELLED.refunded(null)).nextSibling).toHaveTextContent("100.00 cr");
    expect(within(money).getAllByText(DETAIL_CANCELLED.nothingToPay).length).toBeGreaterThan(0);
    expect(money).not.toHaveTextContent(/Shares close|Not paid yet|Paid 0\.00|lapses|Asked for/);
  });

  it("a partner reads no 'all paid up' and no share still to pay", async () => {
    serve({ detail: cancelled({
      viewer: { role: "player", participant_id: PID.sam },
      organiser: { user_id: "u-nomsa", name: "Nomsa Khumalo", photo_url: null },
    }) });
    renderDetail();
    expect(await screen.findByText(DETAIL_CANCELLED.partnerNothing)).toBeInTheDocument();
    expect(screen.queryByText(DETAIL_PLAYER.paidAll)).toBeNull();
    expect(screen.queryByText(DETAIL_PLAYER.toPay)).toBeNull();
  });

  it("asks for no result and draws no attendance nobody had (F2.15)", async () => {
    const stub = serve({ detail: cancelled() });
    renderDetail();
    await screen.findByText(DETAIL_CANCELLED.banner);
    expect(screen.queryByRole("region", { name: RESULT_CARD.title })).toBeNull();
    expect(screen.queryByText(DETAIL_ATTENDANCE.notYet)).toBeNull();
    expect(resultReads(stub.calls)).toBe(0);
  });

  it("cancelled after check-in: the partners' shares stand and are said as paid", async () => {
    serve({ detail: cancelled({
      players: [seat(), { ...SAM_SEAT, paid_credits: 25 }, OPEN_SEAT],
      attendance: { checked_in_at: "2026-09-30T16:02:00Z", players_checked_in: 1 },
      money: {
        price_credits: 100, organiser_owed_credits: 100, shares_received_credits: 25, organiser_net_credits: 75,
        unpaid_credits: 0, share_deadline: "2026-10-02T18:45:00Z", is_split: true,
      },
    }) });
    renderDetail();
    const money = await screen.findByRole("region", { name: DETAIL_MONEY.title });
    expect(within(money).getByText(DETAIL_CANCELLED.paidRow("25.00 cr"))).toBeInTheDocument();
    expect(within(money).queryByText(DETAIL_CANCELLED.refunded(null))).toBeNull();
    expect(screen.getByText(DETAIL_ATTENDANCE.checkedInAt("18:02"))).toBeInTheDocument();
  });
});

describe("the result card is asked for by the game's players only (R1 F2.15)", () => {
  it("an admin looking in never asks — the API would answer 404 to them", async () => {
    const stub = serve({ admin: true, detail: adminView() });
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    expect(resultReads(stub.calls)).toBe(0);
  });

  it("the organiser and a partner still see it", async () => {
    const stub = serve({ detail: playerView() });
    renderDetail();
    expect(await screen.findByRole("region", { name: RESULT_CARD.title })).toBeInTheDocument();
    expect(resultReads(stub.calls)).toBeGreaterThan(0);
  });
});
