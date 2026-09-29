import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { refuse, signOut, type StubCall } from "@/test/harness";
import { DETAIL_ADMIN, PLAYERS_REFUSAL } from "@/lib/playersCopy";
import { ALEX_SEAT, BOOKING, DETAIL_PATH, PID, adminView, renderDetail, seat, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * God mode on the booking page (admin): every act needs a reason and lands in the change log;
 * collect always asks for the overdraft go-ahead and sends `allowNegativeBalance`; remove and
 * settle ask for it when the server answers `overdraft_not_authorised`, then resend with it.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const ADMIN_SEAT = `/api/v1/admin/bookings/${BOOKING}/players/${PID.alex}`;
const notice = () => document.querySelector("[data-detail-notice]");
const posts = (calls: StubCall[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

async function openAct(label: string) {
  renderDetail();
  // Radix opens its menu on pointerdown, not on click.
  const trigger = await screen.findByRole("button", { name: DETAIL_ADMIN.menu("Alex") });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: label }));
  return screen.findByRole("dialog");
}

function reason(dialog: HTMLElement, text: string) {
  fireEvent.change(within(dialog).getByRole("textbox", { name: DETAIL_ADMIN.reasonLabel }), { target: { value: text } });
}

describe("collect", () => {
  it("always asks for the overdraft go-ahead, and a reason, before it sends", async () => {
    const stub = serve({ admin: true, detail: adminView(), extra: [{
      method: "POST", path: `${ADMIN_SEAT}/collect`, body: { participant_id: PID.alex, collected_credits: 25, balance_after_credits: -5 },
    }] });
    const dialog = await openAct(DETAIL_ADMIN.collect);
    expect(dialog).toHaveTextContent(DETAIL_ADMIN.changeLog);
    const box = within(dialog).getByRole("checkbox", { name: DETAIL_ADMIN.overdraftCollect("25.00 cr", "Alex") });
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.collectConfirm }));
    expect(within(dialog).getByText(DETAIL_ADMIN.reasonMissing)).toBeInTheDocument();
    expect(within(dialog).getByText(DETAIL_ADMIN.overdraftMissing)).toBeInTheDocument();
    expect(posts(stub.calls, `${ADMIN_SEAT}/collect`)).toHaveLength(0);

    reason(dialog, "Paid late, agreed at the desk");
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.collectConfirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ADMIN.collected("Alex", "25.00 cr")));
    expect(posts(stub.calls, `${ADMIN_SEAT}/collect`)[0].body).toEqual({ reason: "Paid late, agreed at the desk", allowNegativeBalance: true });
  });

  it("says nothing_to_collect as a sentence", async () => {
    serve({ admin: true, detail: adminView(), extra: [{ method: "POST", path: `${ADMIN_SEAT}/collect`, status: 409, body: { error: "nothing_to_collect" } }] });
    const dialog = await openAct(DETAIL_ADMIN.collect);
    reason(dialog, "Checking");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.collectConfirm }));
    expect(await within(dialog).findByText(PLAYERS_REFUSAL.nothing_to_collect)).toBeInTheDocument();
  });
});

describe("remove and settle — the overdraft asked for by the server", () => {
  it.each([
    ["remove", DETAIL_ADMIN.remove, DETAIL_ADMIN.removeConfirm, DETAIL_ADMIN.removed("Alex")],
    ["settle-outside", DETAIL_ADMIN.settle, DETAIL_ADMIN.settleConfirm, DETAIL_ADMIN.settled("Alex")],
  ])("%s: overdraft_not_authorised → the god-mode confirm → resent with the flag", async (route, label, confirm, done) => {
    const stub = serve({ admin: true, detail: adminView(), extra: [{
      method: "POST", path: `${ADMIN_SEAT}/${route}`,
      respond: ({ body }) => ((body as { allowNegativeBalance?: boolean }).allowNegativeBalance
        ? { participant_id: PID.alex, status: "removed" }
        : refuse(400, { error: "overdraft_not_authorised" })),
    }] });
    const dialog = await openAct(label);
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    reason(dialog, "Paid cash");
    fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
    const box = await within(dialog).findByRole("checkbox", { name: DETAIL_ADMIN.overdraftReturn("Sam") });
    expect(within(dialog).getByText(DETAIL_ADMIN.overdraftAsked)).toBeInTheDocument();
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(done));
    const sent = posts(stub.calls, `${ADMIN_SEAT}/${route}`).map((c) => c.body);
    expect(sent).toEqual([
      { reason: "Paid cash", allowNegativeBalance: false },
      { reason: "Paid cash", allowNegativeBalance: true },
    ]);
  });
});

describe("remove and settle — a return that waits on the organiser (P11)", () => {
  it.each([
    ["remove", DETAIL_ADMIN.remove, DETAIL_ADMIN.removeConfirm, "Removed Alex. Their 16.00 cr is waiting on Sam's balance and goes back as soon as it's covered."],
    ["settle-outside", DETAIL_ADMIN.settle, DETAIL_ADMIN.settleConfirm, "Alex's share is settled with the club. Their 16.00 cr is waiting on Sam's balance and goes back as soon as it's covered."],
  ])("%s: return_waiting says the money has not moved yet", async (route, label, confirm, done) => {
    serve({ admin: true, detail: adminView(), extra: [{
      method: "POST", path: `${ADMIN_SEAT}/${route}`,
      body: { participant_id: PID.alex, status: "removed", return_waiting: true, return_credits: 16 },
    }] });
    const dialog = await openAct(label);
    reason(dialog, "Injured");
    fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(done));
  });

  it("a waiting return with no figure still says nothing has moved", async () => {
    serve({ admin: true, detail: adminView(), extra: [{
      method: "POST", path: `${ADMIN_SEAT}/remove`,
      body: { participant_id: PID.alex, status: "removed", return_waiting: true, return_credits: null },
    }] });
    const dialog = await openAct(DETAIL_ADMIN.remove);
    reason(dialog, "Injured");
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.removeConfirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ADMIN.removedWaiting("Alex", null, "Sam")));
    expect(DETAIL_ADMIN.removedWaiting("Alex", null, "Sam")).toBe(
      "Removed Alex. What they paid is waiting on Sam's balance and goes back as soon as it's covered.");
  });

  it("return_waiting false reads exactly as before", async () => {
    serve({ admin: true, detail: adminView(), extra: [{
      method: "POST", path: `${ADMIN_SEAT}/remove`,
      body: { participant_id: PID.alex, status: "removed", return_waiting: false, return_credits: 16 },
    }] });
    const dialog = await openAct(DETAIL_ADMIN.remove);
    reason(dialog, "Injured");
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.removeConfirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ADMIN.removed("Alex")));
    expect(notice()).not.toHaveTextContent(/waiting/);
  });
});

describe("accept on their behalf", () => {
  it("needs a reason and says it records no consent", async () => {
    const invited = adminView({ players: [seat({ user_id: "u-sam", name: "Sam Petersen" }), { ...ALEX_SEAT, seat: 2, team: "A" }] });
    const stub = serve({ admin: true, detail: invited, extra: [{ method: "POST", path: `${ADMIN_SEAT}/accept`, body: { participant_id: PID.alex, status: "accepted" } }] });
    const dialog = await openAct(DETAIL_ADMIN.accept);
    expect(dialog).toHaveTextContent(DETAIL_ADMIN.acceptBody);
    reason(dialog, "Asked me at the desk");
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.acceptConfirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ADMIN.accepted("Alex")));
    expect(posts(stub.calls, `${ADMIN_SEAT}/accept`)[0].body).toEqual({ reason: "Asked me at the desk" });
  });
});

describe("add a player as the club", () => {
  it("adds an open link seat with a reason, then offers its link", async () => {
    const stub = serve({ admin: true, detail: adminView(), extra: [{
      method: "POST", path: `/api/v1/admin/bookings/${BOOKING}/players`,
      body: { booking_id: BOOKING, participants: [{ participant_id: "p-new", seat: 3, user_id: null, guest_name: null, status: "invited", share_credits: 25, invite_token: "t", invite_path: "/j/t" }] },
    }, { path: "/api/v1/admin/members", body: [] }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ADMIN.add }));
    const dialog = await screen.findByRole("dialog", { name: DETAIL_ADMIN.addTitle });
    fireEvent.click(within(dialog).getByRole("radio", { name: DETAIL_ADMIN.addLink }));
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.addConfirm }));
    expect(within(dialog).getByText(DETAIL_ADMIN.reasonMissing)).toBeInTheDocument();
    reason(dialog, "Club social");
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.addConfirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ADMIN.added));
    expect(posts(stub.calls, `/api/v1/admin/bookings/${BOOKING}/players`)[0].body).toEqual({ reason: "Club social" });
    expect(await screen.findByRole("textbox", { name: /Invite link/ })).toHaveValue(`${window.location.origin}/j/t`);
  });

  it("adds a named guest", async () => {
    const stub = serve({ admin: true, detail: adminView(), extra: [{
      method: "POST", path: `/api/v1/admin/bookings/${BOOKING}/players`,
      body: { booking_id: BOOKING, participants: [{ participant_id: "p-g", seat: 3, user_id: null, guest_name: "Themba", status: "accepted", share_credits: 0, invite_token: null, invite_path: null }] },
    }, { path: "/api/v1/admin/members", body: [] }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ADMIN.add }));
    const dialog = await screen.findByRole("dialog", { name: DETAIL_ADMIN.addTitle });
    fireEvent.click(within(dialog).getByRole("radio", { name: DETAIL_ADMIN.addGuest }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: DETAIL_ADMIN.guestLabel }), { target: { value: "Themba" } });
    reason(dialog, "Visiting coach");
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.addConfirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ADMIN.added));
    expect(posts(stub.calls, `/api/v1/admin/bookings/${BOOKING}/players`)[0].body).toEqual({ guestName: "Themba", reason: "Visiting coach" });
    expect(stub.calls.filter((c) => c.path === DETAIL_PATH).length).toBeGreaterThanOrEqual(2);
  });
});
