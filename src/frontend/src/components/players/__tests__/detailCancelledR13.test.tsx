import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { DETAIL_CANCELLED } from "@/lib/playersCopy";
import { ALEX_SEAT, SAM_SEAT, detail, playerView, renderDetail, seat, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R13 J13-6 (contract C13-1) — a game the club cancelled, or displaced, said only "This game was
 * cancelled." The detail now carries `cancelled_by`, `cancel_cause` and `cancel_reason`; the banner
 * says who cancelled and why.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const CLOSED = {
  can_invite: false, can_change_split: false, can_cancel: false, can_accept: false, can_decline: false,
  can_withdraw: false, withdraw_closes_at: "2026-09-30T14:00:00Z",
};
const MONEY = {
  price_minutes: 100, organiser_owed_minutes: 0, shares_received_minutes: 0, organiser_net_minutes: 0,
  unpaid_minutes: 0, share_deadline: "2026-10-02T18:45:00Z", is_split: true,
};
const PLAYERS = [seat(), { ...SAM_SEAT, paid_minutes: 0, target_minutes: 0 }, ALEX_SEAT];

function cancelledAs(view: "organiser" | "player", wire: Record<string, unknown>) {
  const base = { status: "cancelled" as const, players: PLAYERS, money: MONEY, permissions: CLOSED };
  return { ...(view === "organiser" ? detail(base) : playerView(base)), ...wire };
}

const banner = async () => (await screen.findByText((_t, el) => el?.hasAttribute("data-cancelled") ?? false));

describe("R13 J13-6 — the cancelled booking says who cancelled it and why", () => {
  it("the club, with its reason — to a partner", async () => {
    serve({ detail: cancelledAs("player", { cancelled_by: "club", cancel_cause: null, cancel_reason: "Court resurfacing" }) });
    renderDetail();
    const said = await banner();
    expect(said).toHaveTextContent(DETAIL_CANCELLED.byClub);
    expect(said).toHaveTextContent(DETAIL_CANCELLED.reason("Court resurfacing"));
    expect(said.textContent).not.toBe(DETAIL_CANCELLED.banner);
  });

  it("the club, with its reason — to the organiser", async () => {
    serve({ detail: cancelledAs("organiser", { cancelled_by: "club", cancel_cause: null, cancel_reason: "Injury" }) });
    renderDetail();
    const said = await banner();
    expect(said).toHaveTextContent("The club cancelled this game.");
    expect(said).toHaveTextContent("Reason: Injury");
  });

  it("the club, no recorded reason: no empty 'Reason:'", async () => {
    serve({ detail: cancelledAs("player", { cancelled_by: "club", cancel_cause: null, cancel_reason: null }) });
    renderDetail();
    const said = await banner();
    expect(said).toHaveTextContent(DETAIL_CANCELLED.byClub);
    expect(said.textContent).not.toMatch(/Reason/);
  });

  it("displaced: the club cancelled and refunded it, and says why", async () => {
    serve({ detail: cancelledAs("organiser", { cancelled_by: "club", cancel_cause: "displaced", cancel_reason: null }) });
    renderDetail();
    expect(await banner()).toHaveTextContent(DETAIL_CANCELLED.displaced);
    expect(DETAIL_CANCELLED.displaced).toMatch(/still in use by an earlier booking/);
  });

  it("the organiser's own cancel, to the organiser: 'You cancelled this game.'", async () => {
    serve({ detail: cancelledAs("organiser", { cancelled_by: "member", cancel_cause: null, cancel_reason: null }) });
    renderDetail();
    expect(await banner()).toHaveTextContent(DETAIL_CANCELLED.byYou);
  });

  it("the organiser's own cancel, to a partner: the organiser by name", async () => {
    serve({ detail: cancelledAs("player", { cancelled_by: "member", cancel_cause: null, cancel_reason: null }) });
    renderDetail();
    expect(await banner()).toHaveTextContent(DETAIL_CANCELLED.byOrganiser("Sam"));
  });

  it("an older server (no fields): today's sentence", async () => {
    serve({ detail: cancelledAs("player", {}) });
    renderDetail();
    expect(await banner()).toHaveTextContent(DETAIL_CANCELLED.banner);
  });
});
