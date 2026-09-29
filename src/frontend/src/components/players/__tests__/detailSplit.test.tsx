import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { refuse, signOut, type StubCall } from "@/test/harness";
import type { PlayerPickerDialogProps } from "@/components/players/PlayerPicker";
import { BOOK_SPLIT, CHANGE_SPLIT, DETAIL_ACTIONS, PLAYERS_REFUSAL, SHARE_ASK } from "@/lib/playersCopy";
import { ALEX_SEAT, DETAIL_PATH, PID, SAM_SEAT, detail, playerView, renderDetail, seat, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({
  PlayerPicker: () => null,
  PlayerPickerDialog: (props: PlayerPickerDialogProps) => (props.open ? (
    <div role="dialog" aria-label={props.title}>
      <button type="button" onClick={() => props.onPick({ kind: "member", userId: "u-jo", name: "Jo van Wyk", photoUrl: null })}>Pick Jo</button>
      <button type="button" onClick={() => props.onPick({ kind: "guest", name: "Themba" })}>Pick a guest</button>
    </div>
  ) : null),
}));

/**
 * R1 F2.1 — the organiser can change the split of a booking that already stands (the BookSheet's
 * own Split step), and a player added to an amount or ratio split is asked for a share first —
 * never seated at "Asked for 0.00 cr".
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const SPLIT = `${DETAIL_PATH}/split`;
const PREVIEW = "/api/v1/players/split-preview";
const notice = () => document.querySelector("[data-detail-notice]");
const puts = (calls: StubCall[]) => calls.filter((c) => c.method === "PUT" && c.path === SPLIT);

/** The server's own preview, from the body sent: partners as asked, the organiser the rest. */
function previewOf({ body }: { body: unknown }) {
  const req = body as { priceCredits: number; players: { seat: number; amount?: number }[] };
  const partners = req.players.map((p) => ({ seat: p.seat, team: p.seat <= 2 ? "A" : "B", share_credits: p.amount ?? 25, weight: 1 }));
  const taken = partners.reduce((n, p) => n + p.share_credits, 0);
  return { price_credits: req.priceCredits, shares: [{ seat: 1, team: "A", share_credits: req.priceCredits - taken, weight: 1 }, ...partners] };
}

describe("change the split (R1 F2.1)", () => {
  it("opens the Split step on the booking's own seats, and saves the new amounts by seat", async () => {
    const stub = serve({ extra: [
      { method: "POST", path: PREVIEW, respond: previewOf },
      { method: "PUT", path: SPLIT, body: { booking_id: "b", split_mode: "amount", shares: [
        { participant_id: PID.sam, seat: 2, share_credits: 30, weight: 1, needs_consent: true },
      ] } },
    ] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: CHANGE_SPLIT.open }));
    const dialog = await screen.findByRole("dialog", { name: CHANGE_SPLIT.title });
    fireEvent.click(within(dialog).getByRole("radio", { name: BOOK_SPLIT.modes.amount }));
    // Started from the shares as they stand, never four zeroes.
    const sam = within(dialog).getByRole("textbox", { name: BOOK_SPLIT.amountLabel("Sam") });
    expect(sam).toHaveValue("25.00");
    fireEvent.change(sam, { target: { value: "30" } });
    const save = within(dialog).getByRole("button", { name: CHANGE_SPLIT.save });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(notice()).toHaveTextContent(CHANGE_SPLIT.doneAskedAgain));
    expect(puts(stub.calls)[0].body).toEqual({
      mode: "amount",
      seats: [
        { participantId: PID.sam, amount: 30 },
        { participantId: PID.alex, amount: 25 },
        { participantId: PID.open, amount: 25 },
      ],
    });
  });

  it("keeps a refusal in the dialog as a sentence", async () => {
    serve({ extra: [
      { method: "POST", path: PREVIEW, respond: previewOf },
      { method: "PUT", path: SPLIT, respond: () => refuse(409, { error: "booking_not_open" }) },
    ] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: CHANGE_SPLIT.open }));
    const dialog = await screen.findByRole("dialog", { name: CHANGE_SPLIT.title });
    const save = within(dialog).getByRole("button", { name: CHANGE_SPLIT.save });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await within(dialog).findByText(PLAYERS_REFUSAL.booking_not_open)).toBeInTheDocument();
  });

  it("is the organiser's alone, and only while the server allows it", async () => {
    serve({ detail: detail({ permissions: { ...detail().permissions, can_change_split: false } }) });
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: CHANGE_SPLIT.open })).toBeNull();
  });

  it("a partner never sees it", async () => {
    serve({ detail: playerView({ permissions: { ...playerView().permissions, can_change_split: true } }) });
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: CHANGE_SPLIT.open })).toBeNull();
  });
});

describe("inviting into an amount or ratio split asks for their share (R1 F2.1)", () => {
  const amountSplit = () => detail({
    split_mode: "amount",
    players: [seat({ share_credits: 60 }), { ...SAM_SEAT, share_credits: 40 }],
  });

  it("asks what they should pay, then sends it with the invite", async () => {
    const stub = serve({ detail: amountSplit(), extra: [{
      method: "POST", path: `${DETAIL_PATH}/players`,
      body: { booking_id: "b", participants: [{ participant_id: "p-jo", seat: 3, user_id: "u-jo", guest_name: null, status: "invited", share_credits: 30, invite_token: null, invite_path: null }] },
    }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.invite }));
    fireEvent.click(screen.getByRole("button", { name: "Pick Jo" }));
    const ask = await screen.findByRole("dialog", { name: SHARE_ASK.title("Jo") });
    expect(ask).toHaveTextContent(SHARE_ASK.amountBody("60.00 cr"));
    const field = within(ask).getByRole("textbox", { name: SHARE_ASK.amountLabel("Jo") });
    // Offered the equal share among three payers, in whole credits: ⌊100 / 3⌋.
    expect(field).toHaveValue("33.00");
    fireEvent.change(field, { target: { value: "30" } });
    fireEvent.click(within(ask).getByRole("button", { name: SHARE_ASK.confirm("Jo") }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ACTIONS.invited("Jo")));
    const post = stub.calls.find((c) => c.method === "POST" && c.path === `${DETAIL_PATH}/players`);
    expect(post?.body).toEqual({ players: [{ userId: "u-jo", amount: 30 }] });
  });

  it("refuses more than the organiser covers, in the field, and sends nothing", async () => {
    const stub = serve({ detail: amountSplit() });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.invite }));
    fireEvent.click(screen.getByRole("button", { name: "Pick Jo" }));
    const ask = await screen.findByRole("dialog", { name: SHARE_ASK.title("Jo") });
    fireEvent.change(within(ask).getByRole("textbox", { name: SHARE_ASK.amountLabel("Jo") }), { target: { value: "70" } });
    fireEvent.click(within(ask).getByRole("button", { name: SHARE_ASK.confirm("Jo") }));
    expect(within(ask).getByText(PLAYERS_REFUSAL.split_exceeds_price)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.method === "POST" && c.path === `${DETAIL_PATH}/players`)).toBe(false);
  });

  it("a guest plays free, so nothing is asked", async () => {
    const stub = serve({ detail: amountSplit(), extra: [{
      method: "POST", path: `${DETAIL_PATH}/players`,
      body: { booking_id: "b", participants: [{ participant_id: "p-g", seat: 3, user_id: null, guest_name: "Themba", status: "accepted", share_credits: 0, invite_token: null, invite_path: null }] },
    }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.invite }));
    fireEvent.click(screen.getByRole("button", { name: "Pick a guest" }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ACTIONS.guestAdded("Themba")));
    expect(screen.queryByRole("dialog", { name: SHARE_ASK.title("Themba") })).toBeNull();
    expect(stub.calls.find((c) => c.method === "POST" && c.path === `${DETAIL_PATH}/players`)?.body).toEqual({ players: [{ guestName: "Themba" }] });
  });

  it("an equal split asks nothing — the server splits it", async () => {
    const stub = serve({ detail: detail({ players: [seat(), SAM_SEAT, ALEX_SEAT] }), extra: [{
      method: "POST", path: `${DETAIL_PATH}/players`,
      body: { booking_id: "b", participants: [{ participant_id: "p-jo", seat: 4, user_id: "u-jo", guest_name: null, status: "invited", share_credits: 25, invite_token: null, invite_path: null }] },
    }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.invite }));
    fireEvent.click(screen.getByRole("button", { name: "Pick Jo" }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ACTIONS.invited("Jo")));
    expect(stub.calls.find((c) => c.method === "POST" && c.path === `${DETAIL_PATH}/players`)?.body).toEqual({ players: [{ userId: "u-jo" }] });
  });
});
