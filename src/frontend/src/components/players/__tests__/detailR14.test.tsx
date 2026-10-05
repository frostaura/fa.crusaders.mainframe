import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { DETAIL_CANCEL, DETAIL_PLAYER } from "@/lib/playersCopy";
import { ALEX_SEAT, OPEN_SEAT, SAM_SEAT, detail, playerView, renderDetail, seat, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * Review round 14 on the booking page's words: the organiser's cancel note counts and names the
 * partners (J14-7 — "Your partners … their shares" with one partner), and a seat the club accepted
 * without asking is asked for its share the first time, never "Your share went up" (J14-9).
 */
beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const cancelNote = async () => within(await screen.findByRole("region", { name: DETAIL_CANCEL.title })).getByText(DETAIL_CANCEL.penaltyYours, { exact: false });

describe("J14-7 — the cancel note says one partner as one", () => {
  it("one partner: named, singular", async () => {
    serve({ detail: detail({ players: [seat(), SAM_SEAT] }) });
    renderDetail();
    const note = await cancelNote();
    expect(note).toHaveTextContent(DETAIL_CANCEL.partnersBack(["Sam"]));
    expect(DETAIL_CANCEL.partnersBack(["Sam"])).toBe("Sam gets back what they paid for their share.");
    expect(note.textContent).not.toMatch(/partners|shares/);
  });

  it("two partners: both named, plural — an open seat is nobody's share yet", async () => {
    serve({ detail: detail({ players: [seat(), SAM_SEAT, ALEX_SEAT, OPEN_SEAT] }) });
    renderDetail();
    const note = await cancelNote();
    expect(note).toHaveTextContent(DETAIL_CANCEL.partnersBack(["Sam", "Alex"]));
    expect(DETAIL_CANCEL.partnersBack(["Sam", "Alex"])).toBe("Sam and Alex get back what they paid for their shares.");
  });

  it("no member partner (an open seat only): only the penalty line", async () => {
    serve({ detail: detail({ players: [seat(), OPEN_SEAT] }) });
    renderDetail();
    const note = await cancelNote();
    expect(note.textContent).toBe(DETAIL_CANCEL.penaltyYours);
  });
});

describe("J14-9 — a share never agreed is asked for, not 'went up'", () => {
  it("accepted by the club with nothing agreed: the club's ask", async () => {
    serve({ detail: playerView({
      players: [seat({ user_id: "u-sam", name: "Sam Petersen" }), SAM_SEAT, { ...ALEX_SEAT, status: "accepted", share_minutes: 12, consented_minutes: 0, unpaid_minutes: 12, needs_consent: true }],
    }) });
    renderDetail();
    expect(await screen.findByText(DETAIL_PLAYER.askedFirst("12 minutes"))).toBeInTheDocument();
    expect(DETAIL_PLAYER.askedFirst("12 minutes")).toBe("The club has asked you for 12 minutes — review it to say yes.");
    expect(screen.queryByText(/went up/)).toBeNull();
  });

  it("agreed before and the share rose: still 'went up'", async () => {
    serve({ detail: playerView({
      players: [seat({ user_id: "u-sam", name: "Sam Petersen" }), SAM_SEAT, { ...ALEX_SEAT, status: "accepted", share_minutes: 30, consented_minutes: 25, paid_minutes: 25, unpaid_minutes: 5, needs_consent: true }],
    }) });
    renderDetail();
    expect(await screen.findByText(DETAIL_PLAYER.askedAgain("30 minutes"))).toBeInTheDocument();
    expect(screen.queryByText(DETAIL_PLAYER.askedFirst("30 minutes"))).toBeNull();
  });
});
