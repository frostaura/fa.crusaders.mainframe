import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut, type StubCall } from "@/test/harness";
import { LEFT_TO_COVER } from "@/lib/playersCopy";
import {
  assigned, coverers, equalPortions, leftoverChange, leftoverExpected, portionsReady,
} from "@/components/players/detail/leftoverSplit";
import { ALEX_SEAT, DETAIL_PATH, OPEN_SEAT, PID, SAM_SEAT, detail, playerView, renderDetail, seat, serve } from "./detailKit";

/**
 * Pay what you can — the organiser's side (players-and-splits.md §4). Sam could pay only 15 of his
 * 25: 10 are left to cover. The organiser covers them (their seat reads 35) until they split what's
 * left: Sam's figure is locked at what he paid, and the organiser, Alex and the open seat each take
 * a whole-minute portion that must add up to exactly 10 before Save.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const SPLIT = `${DETAIL_PATH}/split`;
const puts = (calls: StubCall[]) => calls.filter((c) => c.method === "PUT" && c.path === SPLIT);

const SHORT_SAM = { ...SAM_SEAT, share_minutes: 15, consented_minutes: 15, paid_minutes: 15, target_minutes: 15, shortfall_minutes: 10 };
function shortDetail() {
  const base = detail();
  return detail({
    split_mode: "amount",
    players: [seat({ share_minutes: 35 }), SHORT_SAM, ALEX_SEAT, OPEN_SEAT],
    money: { ...base.money, left_to_cover_minutes: 10 },
  });
}

describe("the arithmetic of splitting what's left", () => {
  it("opens on an equal split in whole minutes, the organiser keeping the remainder", () => {
    const people = coverers(shortDetail());
    expect(people.map((p) => p.participant_id)).toEqual([PID.me, PID.alex, PID.open]);
    // 10 three ways: 3 and 3 for the partners, 4 for the organiser — it always sums to what is left.
    const portions = equalPortions(10, people);
    expect(portions).toEqual({ organiser: "4", [PID.alex]: "3", [PID.open]: "3" });
    expect(assigned(portions, people)).toEqual({ total: 10, readable: true });
    expect(portionsReady(10, portions, people)).toBe(true);
  });

  it("is ready only at exactly what is left, every portion a whole number", () => {
    const people = coverers(shortDetail());
    expect(portionsReady(10, { organiser: "4", [PID.alex]: "3", [PID.open]: "2" }, people)).toBe(false);
    expect(portionsReady(10, { organiser: "5", [PID.alex]: "3", [PID.open]: "3" }, people)).toBe(false);
    expect(portionsReady(10, { organiser: "4", [PID.alex]: "2.5", [PID.open]: "3.5" }, people)).toBe(false);
    expect(portionsReady(10, { organiser: "0", [PID.alex]: "10", [PID.open]: "0" }, people)).toBe(true);
  });

  it("saves an amount split: the short partner at what they paid, the others at share plus portion, the organiser unnamed", () => {
    const d = shortDetail();
    const change = leftoverChange(d, { organiser: "2", [PID.alex]: "5", [PID.open]: "3" });
    expect(change).toEqual({
      mode: "amount",
      seats: [
        { participantId: PID.sam, amount: 15 },
        { participantId: PID.alex, amount: 30 },
        { participantId: PID.open, amount: 28 },
      ],
    });
    expect(leftoverExpected(change!, d)).toEqual([{ seat: 2, share_minutes: 15 }, { seat: 3, share_minutes: 30 }, { seat: 4, share_minutes: 28 }]);
    expect(leftoverChange(d, { organiser: "2", [PID.alex]: "5", [PID.open]: "2" })).toBeNull();
  });
});

describe("Split what's left on the booking page", () => {
  it("tells the organiser, and saves the portions through the split route", async () => {
    const stub = serve({ detail: shortDetail(), extra: [
      { method: "PUT", path: SPLIT, body: { booking_id: "b", split_mode: "amount", shares: [
        { participant_id: PID.alex, seat: 3, share_minutes: 30, weight: 0, needs_consent: true },
      ] } },
    ] });
    renderDetail();
    const notice = await waitFor(() => {
      const found = document.querySelector("[data-left-to-cover]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(notice).toHaveTextContent(/10 minutes left to cover/);
    expect(notice.textContent).not.toMatch(/credit/i);
    fireEvent.click(within(notice).getByRole("button", { name: LEFT_TO_COVER.open }));

    const dialog = await screen.findByRole("dialog", { name: LEFT_TO_COVER.dialogTitle });
    expect(dialog.querySelector("[data-short-seats]")).toHaveTextContent(/Sam paid 15 minutes of their 25 minutes share/);
    expect(within(dialog).getByText(LEFT_TO_COVER.consent)).toBeInTheDocument();
    const mine = within(dialog).getByRole("textbox", { name: LEFT_TO_COVER.portionLabel(LEFT_TO_COVER.you) });
    const alex = within(dialog).getByRole("textbox", { name: LEFT_TO_COVER.portionLabel("Alex") });
    expect(mine).toHaveValue("4");
    expect(alex).toHaveValue("3");
    expect(dialog.querySelector("[data-assigned-words]")).toHaveTextContent(LEFT_TO_COVER.assigned(10, 10));

    // Under what is left: the bar says so and Save waits.
    fireEvent.change(alex, { target: { value: "1" } });
    const save = within(dialog).getByRole("button", { name: LEFT_TO_COVER.save });
    expect(dialog.querySelector("[data-assigned-words]")).toHaveTextContent(LEFT_TO_COVER.assigned(8, 10));
    expect(save).toBeDisabled();
    // Exactly what is left: 2 for me, 5 for Alex, 3 for the open seat.
    fireEvent.change(mine, { target: { value: "2" } });
    fireEvent.change(alex, { target: { value: "5" } });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() => expect(document.querySelector("[data-detail-notice]")).toHaveTextContent(LEFT_TO_COVER.doneAsked));
    expect(puts(stub.calls)[0].body).toEqual({
      mode: "amount",
      seats: [
        { participantId: PID.sam, amount: 15 },
        { participantId: PID.alex, amount: 30 },
        { participantId: PID.open, amount: 28 },
      ],
    });
  });

  it("is said to nobody but the organiser, and not at all with nothing left to cover", async () => {
    serve({ detail: playerView({ players: shortDetail().players, money: shortDetail().money }) });
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    expect(document.querySelector("[data-left-to-cover]")).toBeNull();
  });

  it("is not shown on a booking with nothing left to cover", async () => {
    serve({ detail: detail() });
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    expect(document.querySelector("[data-left-to-cover]")).toBeNull();
  });
});
