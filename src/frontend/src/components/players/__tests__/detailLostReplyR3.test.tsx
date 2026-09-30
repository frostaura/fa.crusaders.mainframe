import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { refuse, signOut } from "@/test/harness";
import type { PlayerPickerDialogProps } from "@/components/players/PlayerPicker";
import type { BookingDetail } from "@/lib/playersApi";
import {
  BOOK_SPLIT, CHANGE_SPLIT, DETAIL_ACTIONS, DETAIL_PLAYER, PLAYERS_LOST, PLAYERS_UNSURE, SHARE_LINK,
} from "@/lib/playersCopy";
import { ALEX_SEAT, DETAIL_PATH, OPEN_SEAT, PID, SAM_SEAT, detail, playerView, renderDetail, seat, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({
  PlayerPicker: () => null,
  PlayerPickerDialog: (props: PlayerPickerDialogProps) => (props.open ? (
    <div role="dialog" aria-label={props.title}>
      <button type="button" onClick={() => props.onPick({ kind: "member", userId: "u-jo", name: "Jo van Wyk", photoUrl: null })}>Pick Jo</button>
      <button type="button" onClick={() => props.onPick({ kind: "link" })}>Pick a link</button>
    </div>
  ) : null),
}));

/**
 * R3 I-2 and the lost-reply audit of the booking page. Every stub PERFORMS the write (the
 * booking moves) and then loses the reply (a 504): the page reads the booking back and says
 * what it finds — never "Couldn't …" over a change that stands.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const SEAT = (pid: string) => `${DETAIL_PATH}/players/${pid}`;
const notice = () => document.querySelector("[data-detail-notice]");
const lost = () => refuse(504, { error: "gateway_timeout" });

/** The booking as a GET reads it, and a write that moves it and then loses its reply. */
function booking(first: BookingDetail) {
  let current = first;
  return {
    route: { path: DETAIL_PATH, respond: () => current },
    lands: (next: BookingDetail) => () => { current = next; return lost(); },
  };
}

describe("remove (I-2)", () => {
  const withoutSam = detail({ players: [seat(), ALEX_SEAT, OPEN_SEAT] });

  it("landed behind a 504: says Sam is off, and the list no longer shows them", async () => {
    const b = booking(detail());
    serve({ detail: b.route, extra: [{ method: "DELETE", path: SEAT(PID.sam), respond: b.lands(withoutSam) }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.removeFor("Sam") }));
    const dialog = await screen.findByRole("dialog", { name: DETAIL_ACTIONS.removeTitle("Sam") });
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ACTIONS.removeConfirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(PLAYERS_LOST(DETAIL_ACTIONS.removed("Sam"))));
    await waitFor(() => expect(screen.queryByRole("button", { name: DETAIL_ACTIONS.removeFor("Sam") })).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body).not.toHaveTextContent(/Couldn't remove/);
  });

  it("not landed: says Sam is still on the game, nothing changed", async () => {
    serve({ extra: [{ method: "DELETE", path: SEAT(PID.sam), respond: lost }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.removeFor("Sam") }));
    const dialog = await screen.findByRole("dialog", { name: DETAIL_ACTIONS.removeTitle("Sam") });
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ACTIONS.removeConfirm }));
    expect(await within(dialog).findByText(PLAYERS_UNSURE.remove("Sam").checked)).toBeInTheDocument();
  });

  it("unreadable: says it cannot tell", async () => {
    let reads = 0;
    serve({
      detail: { path: DETAIL_PATH, respond: () => { reads += 1; return reads <= 2 ? detail() : refuse(503, { error: "down" }); } },
      extra: [{ method: "DELETE", path: SEAT(PID.sam), respond: lost }],
    });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.removeFor("Sam") }));
    const dialog = await screen.findByRole("dialog", { name: DETAIL_ACTIONS.removeTitle("Sam") });
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ACTIONS.removeConfirm }));
    expect(await within(dialog).findByText(PLAYERS_UNSURE.remove("Sam").unchecked)).toBeInTheDocument();
  });
});

describe("invite, remind, link", () => {
  const three = () => detail({ players: [seat(), SAM_SEAT, ALEX_SEAT] });

  it("an invite that landed behind a 504 says Jo is invited", async () => {
    const jo = seat({ participant_id: "p-jo", seat: 4, team: "B", kind: "member", user_id: "u-jo", name: "Jo van Wyk", status: "invited" });
    const b = booking(three());
    serve({ detail: b.route, extra: [{ method: "POST", path: `${DETAIL_PATH}/players`, respond: b.lands(detail({ players: [seat(), SAM_SEAT, ALEX_SEAT, jo] })) }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.invite }));
    fireEvent.click(screen.getByRole("button", { name: "Pick Jo" }));
    await waitFor(() => expect(notice()).toHaveTextContent(PLAYERS_LOST(DETAIL_ACTIONS.invited("Jo"))));
  });

  it("an open seat that landed behind a 504 offers to make its link — the token was in the lost reply", async () => {
    const open = { ...OPEN_SEAT, participant_id: "p-new" };
    const b = booking(three());
    serve({ detail: b.route, extra: [{ method: "POST", path: `${DETAIL_PATH}/players`, respond: b.lands(detail({ players: [seat(), SAM_SEAT, ALEX_SEAT, open] })) }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.invite }));
    fireEvent.click(screen.getByRole("button", { name: "Pick a link" }));
    expect(await screen.findByRole("dialog", { name: SHARE_LINK.confirmTitle(DETAIL_ACTIONS.openSeatName) })).toBeInTheDocument();
  });

  it("an invite that did not land says Jo isn't on the game yet", async () => {
    serve({ detail: three(), extra: [{ method: "POST", path: `${DETAIL_PATH}/players`, respond: lost }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.invite }));
    fireEvent.click(screen.getByRole("button", { name: "Pick Jo" }));
    await waitFor(() => expect(notice()).toHaveTextContent(PLAYERS_UNSURE.add("Jo").checked));
  });

  it("a reminder whose reply was lost is said as not known, never 'Couldn't send'", async () => {
    serve({ extra: [{ method: "POST", path: `${SEAT(PID.alex)}/nudge`, respond: lost }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.nudgeFor("Alex") }));
    await waitFor(() => expect(notice()).toHaveTextContent(PLAYERS_UNSURE.nudge("Alex")));
  });

  it("a new link whose reply was lost is said as not known", async () => {
    serve({ extra: [{ method: "POST", path: `${SEAT(PID.alex)}/link`, respond: lost }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.linkFor("Alex") }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: SHARE_LINK.make }));
    expect(await within(dialog).findByText(PLAYERS_UNSURE.link)).toBeInTheDocument();
  });
});

describe("change the split", () => {
  const PREVIEW = "/api/v1/players/split-preview";
  function previewOf({ body }: { body: unknown }) {
    const req = body as { priceCredits: number; players: { seat: number; amount?: number }[] };
    const partners = req.players.map((p) => ({ seat: p.seat, team: p.seat <= 2 ? "A" : "B", share_credits: p.amount ?? 25, weight: 1 }));
    const taken = partners.reduce((n, p) => n + p.share_credits, 0);
    return { price_credits: req.priceCredits, shares: [{ seat: 1, team: "A", share_credits: req.priceCredits - taken, weight: 1 }, ...partners] };
  }

  it("a split that landed behind a 504 says it is changed", async () => {
    const changed = detail({ split_mode: "amount", players: [seat({ share_credits: 20 }), { ...SAM_SEAT, share_credits: 30, needs_consent: true }, ALEX_SEAT, OPEN_SEAT] });
    const b = booking(detail());
    serve({ detail: b.route, extra: [
      { method: "POST", path: PREVIEW, respond: previewOf },
      { method: "PUT", path: `${DETAIL_PATH}/split`, respond: b.lands(changed) },
    ] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: CHANGE_SPLIT.open }));
    const dialog = await screen.findByRole("dialog", { name: CHANGE_SPLIT.title });
    fireEvent.click(within(dialog).getByRole("radio", { name: BOOK_SPLIT.modes.amount }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: BOOK_SPLIT.amountLabel("Sam") }), { target: { value: "30" } });
    const save = within(dialog).getByRole("button", { name: CHANGE_SPLIT.save });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(notice()).toHaveTextContent(PLAYERS_LOST(CHANGE_SPLIT.doneAskedAgain)));
  });

  it("a split that did not land says the split is as it was", async () => {
    serve({ extra: [
      { method: "POST", path: PREVIEW, respond: previewOf },
      { method: "PUT", path: `${DETAIL_PATH}/split`, respond: lost },
    ] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: CHANGE_SPLIT.open }));
    const dialog = await screen.findByRole("dialog", { name: CHANGE_SPLIT.title });
    fireEvent.click(within(dialog).getByRole("radio", { name: BOOK_SPLIT.modes.amount }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: BOOK_SPLIT.amountLabel("Sam") }), { target: { value: "30" } });
    const save = within(dialog).getByRole("button", { name: CHANGE_SPLIT.save });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await within(dialog).findByText(PLAYERS_UNSURE.split.checked)).toBeInTheDocument();
  });
});

describe("a partner leaving", () => {
  const inView = () => playerView({
    players: [seat({ user_id: "u-sam", name: "Sam Petersen" }), SAM_SEAT, { ...ALEX_SEAT, status: "accepted", paid_credits: 25, unpaid_credits: 0, consented_credits: 25 }, OPEN_SEAT],
    permissions: { ...playerView().permissions, can_accept: false, can_decline: false, can_withdraw: true },
  });
  const mySeat = (status: string) => ({
    participant_id: PID.alex, booking_id: "b", status, lapsed: false, settled_outside: false, booking_status: "booked",
    court_name: "Court 1", starts_at: "2026-09-30T16:00:00Z", ends_at: "2026-09-30T16:45:00Z", organiser_name: "Sam", share_credits: 25, timezone: "Africa/Johannesburg",
  });

  it("a pull-out that landed behind a 504 goes back to Bookings saying so", async () => {
    let status = "accepted";
    serve({ detail: inView(), extra: [
      { method: "POST", path: `${SEAT(PID.alex)}/withdraw`, respond: () => { status = "withdrawn"; return lost(); } },
      { path: `/api/v1/me/invites/${PID.alex}`, respond: () => mySeat(status) },
    ] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_PLAYER.withdraw }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: DETAIL_PLAYER.withdrawConfirm }));
    expect(await screen.findByText("The bookings grid")).toBeInTheDocument();
    expect(await screen.findByText(PLAYERS_LOST(DETAIL_PLAYER.withdrawn))).toBeInTheDocument();
  });

  it("a pull-out that did not land says you're still on the game", async () => {
    serve({ detail: inView(), extra: [
      { method: "POST", path: `${SEAT(PID.alex)}/withdraw`, respond: lost },
      { path: `/api/v1/me/invites/${PID.alex}`, body: mySeat("accepted") },
    ] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_PLAYER.withdraw }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_PLAYER.withdrawConfirm }));
    expect(await within(dialog).findByText(PLAYERS_UNSURE.withdraw.checked)).toBeInTheDocument();
  });
});
