import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut, type StubCall } from "@/test/harness";
import { ApiError } from "@/lib/api";
import { DETAIL_ADMIN, DETAIL_MONEY, STATUS_WORD, playersRefusal } from "@/lib/playersCopy";
import { ALEX_SEAT, BOOKING, PID, adminView, renderDetail, seat, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * Review round 16 (FE16m) — the club's money acts on a seat, against BE16b's R16 contract.
 *
 * <ul>
 *   <li><b>J16-10</b> — collect forced the "may go below zero" tick even when the partner's balance
 *   covers the share. The seat now says (`collect_needs_overdraft`); the tick is asked only when
 *   true (and, from an older API that does not say, as before). A raced shortfall is still asked.</li>
 *   <li><b>E16-8</b> — collect on an invited, unaccepted seat is `player_not_accepted`; on a seat
 *   paid by hand, `share_settled_outside`. Both said as sentences about collecting.</li>
 *   <li><b>J16-11</b> — adding a member already at their daily limit is `at_daily_limit` with their name.</li>
 *   <li><b>J16-6</b> — settle-outside is "<partner> paid <organiser> by hand", never "settled with the club".</li>
 * </ul>
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const ADMIN_SEAT = `/api/v1/admin/bookings/${BOOKING}/players/${PID.alex}`;
const notice = () => document.querySelector("[data-detail-notice]");
const posts = (calls: StubCall[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

async function openAct(label: string) {
  renderDetail();
  const trigger = await screen.findByRole("button", { name: DETAIL_ADMIN.menu("Alex") });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: label }));
  return screen.findByRole("dialog");
}

function reason(dialog: HTMLElement, text: string) {
  fireEvent.change(within(dialog).getByRole("textbox", { name: DETAIL_ADMIN.reasonLabel }), { target: { value: text } });
}

const withAlex = (extra: Record<string, unknown>) => adminView({
  players: [
    seat({ user_id: "u-sam", name: "Sam Petersen" }),
    seat({ ...ALEX_SEAT, seat: 2, team: "A", status: "accepted", consented_minutes: 25, target_minutes: 25, share_minutes: 25, paid_minutes: 0, unpaid_minutes: 25, ...extra }),
  ],
});

describe("R16 J16-10 — collect asks for the go-ahead only when the balance is short", () => {
  it("covered: no tick, and the collect goes without the go-ahead", async () => {
    const stub = serve({ admin: true, detail: withAlex({ collect_needs_overdraft: false }), extra: [{
      method: "POST", path: `${ADMIN_SEAT}/collect`, body: { participant_id: PID.alex, collected_minutes: 25, balance_after_minutes: 15 },
    }] });
    const dialog = await openAct(DETAIL_ADMIN.collect);
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(dialog).not.toHaveTextContent(DETAIL_ADMIN.overdraftTitle);
    reason(dialog, "Paid late, agreed at the desk");
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.collectConfirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ADMIN.collected("Alex", "25 minutes")));
    expect(posts(stub.calls, `${ADMIN_SEAT}/collect`)[0].body).toEqual({ reason: "Paid late, agreed at the desk", allowNegativeBalance: false });
  });

  it("short: the tick is asked, and the collect sends the go-ahead", async () => {
    const stub = serve({ admin: true, detail: withAlex({ collect_needs_overdraft: true }), extra: [{
      method: "POST", path: `${ADMIN_SEAT}/collect`, body: { participant_id: PID.alex, collected_minutes: 25, balance_after_minutes: -5 },
    }] });
    const dialog = await openAct(DETAIL_ADMIN.collect);
    reason(dialog, "Agreed");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: DETAIL_ADMIN.overdraftCollect("25 minutes", "Alex Naidoo") }));
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.collectConfirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ADMIN.collected("Alex", "25 minutes")));
    expect(posts(stub.calls, `${ADMIN_SEAT}/collect`)[0].body).toEqual({ reason: "Agreed", allowNegativeBalance: true });
  });

  it("covered when the page read it, short by the time it is sent: the server's refusal asks, and the resend carries it", async () => {
    const stub = serve({ admin: true, detail: withAlex({ collect_needs_overdraft: false }), extra: [{
      method: "POST", path: `${ADMIN_SEAT}/collect`, status: [400, 200],
      sequence: [{ error: "overdraft_not_authorised", collect_minutes: 25, balance_minutes: 10 }, { participant_id: PID.alex, collected_minutes: 25, balance_after_minutes: -15 }],
    }] });
    const dialog = await openAct(DETAIL_ADMIN.collect);
    reason(dialog, "Agreed");
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.collectConfirm }));
    const box = await within(dialog).findByRole("checkbox");
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.collectConfirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ADMIN.collected("Alex", "25 minutes")));
    expect(posts(stub.calls, `${ADMIN_SEAT}/collect`).map((c) => (c.body as { allowNegativeBalance: boolean }).allowNegativeBalance)).toEqual([false, true]);
  });

  it("an older API that does not say: asks, as before", async () => {
    serve({ admin: true, detail: withAlex({}) });
    const dialog = await openAct(DETAIL_ADMIN.collect);
    expect(within(dialog).getByRole("checkbox")).toBeInTheDocument();
  });
});

describe("R16 E16-8 / J16-11 — the refusals, said", () => {
  const refusal = (body: object) => new ApiError(409, body);

  it("collect on a seat that has not said yes, or that was paid by hand", () => {
    expect(playersRefusal(refusal({ error: "player_not_accepted" }))).toBe("That player hasn't said yes yet, so there's no share to collect or settle.");
    expect(playersRefusal(refusal({ error: "share_settled_outside" }))).toBe("That share was already paid by hand — there's nothing to collect in the app.");
  });

  it("adding a member at their daily limit names them", () => {
    expect(playersRefusal(refusal({ error: "at_daily_limit", user_id: "u", name: "Pia van Partner" })))
      .toBe("Pia van Partner has already used their court time for that day, so they can't join this game.");
    expect(playersRefusal(refusal({ error: "at_daily_limit" })))
      .toBe("That member has already used their court time for that day, so they can't join this game.");
  });
});

describe("R16 J16-6 — settle-outside is a payment by hand to the organiser", () => {
  it("the notice names who paid whom", async () => {
    serve({ admin: true, detail: withAlex({}), extra: [{
      method: "POST", path: `${ADMIN_SEAT}/settle-outside`, body: { participant_id: PID.alex, status: "accepted" },
    }] });
    const dialog = await openAct(DETAIL_ADMIN.settle);
    reason(dialog, "Cash at the bar");
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ADMIN.settleConfirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ADMIN.settled("Alex", "Sam")));
    expect(DETAIL_ADMIN.settled("Alex", "Sam")).toBe("Alex paid Sam by hand — recorded.");
    expect(notice()).not.toHaveTextContent(/with the club/);
  });

  it("the waiting return says the same", () => {
    expect(DETAIL_ADMIN.settledWaiting("Alex", "16 minutes", "Sam"))
      .toBe("Alex paid Sam by hand — recorded. Their 16 minutes is waiting on Sam's balance and goes back as soon as it's covered.");
  });

  it("the seat's chip and money row say paid by hand", async () => {
    serve({ admin: true, detail: withAlex({ settled_outside: true }) });
    renderDetail();
    expect(await screen.findByRole("listitem", { name: `Alex, ${STATUS_WORD.settled_outside}` })).toBeInTheDocument();
    expect(STATUS_WORD.settled_outside).toBe("Paid by hand");
    expect(DETAIL_MONEY.settledRow).toBe("Paid the organiser by hand");
    expect(document.body.textContent).not.toMatch(/[Ss]ettled (by|with) the club/);
  });
});
