import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { refuse, stubFetch, type StubCall } from "@/test/harness";
import { CANCEL_SHEET, RESULTS_LABEL, RESULT_WORD } from "@/lib/bookingsCopy";
import { cancellationOutcome } from "@/lib/bookingErrors";
import { CancelSheet, type CancelSheetProps } from "../CancelSheet";
import type { GridBooking } from "../types";

/**
 * CancelSheet (P4: R7). The money is the server's quote, stated before the destructive confirm;
 * the confirm is the danger button and a success is a toast, never a tick. Every render is in
 * StrictMode.
 */

const strict = { reactStrictMode: true };

const MINE: GridBooking = {
  bookingId: "bk-1", courtId: "c1", courtName: "Court 1",
  startsAt: "2030-09-09T16:00:00.000Z", endsAt: "2030-09-09T16:45:00.000Z", whenLabel: "Mon 9 Sep, 18:00",
  mine: true, memberFirstName: null, memberPhotoUrl: null, checkedIn: false, amountChargedCredits: 50,
  timezone: "Africa/Johannesburg",
};
const THANDI: GridBooking = { ...MINE, bookingId: "bk-2", courtName: "Court 2", mine: false, memberFirstName: "Thandi", amountChargedCredits: null, checkedIn: null };
const SIPHO: GridBooking = { ...MINE, bookingId: "bk-3", courtName: "Court 3", mine: false, memberFirstName: "Sipho", amountChargedCredits: null, checkedIn: null };

const quote = (overrides: Record<string, unknown> = {}) => ({
  bookingId: "bk-1", amountChargedCredits: 50, refundCredits: 50, penaltyCredits: 0, penaltyPct: 30,
  penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false, ...overrides,
});
const late = quote({ refundCredits: 35, penaltyCredits: 15, insidePenaltyWindow: true });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Providers({ children }: { children: ReactNode }) {
  return <MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter>;
}

function open(props: Partial<CancelSheetProps> = {}) {
  const onOpenChange = vi.fn();
  const onCancelled = vi.fn();
  const onStale = vi.fn();
  render(
    <CancelSheet open onOpenChange={onOpenChange} bookings={[MINE]} isAdmin={false}
      onCancelled={onCancelled} onStale={onStale} {...props} />,
    { wrapper: Providers, ...strict },
  );
  return { onOpenChange, onCancelled, onStale };
}

const posts = (calls: StubCall[], path: string) => calls.filter((c) => c.method === "POST" && c.path.startsWith(path));
const moneyOf = () => screen.getByRole("dialog").querySelector("dl")!;

describe("CancelSheet — a member's own booking", () => {
  it("states the money before the confirm: free, in full, back to you", async () => {
    stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: quote() }]);
    open();
    const dialog = screen.getByRole("dialog", { name: CANCEL_SHEET.title(1) });
    expect(await within(dialog).findByText(CANCEL_SHEET.free(null))).toBeTruthy();
    expect(moneyOf()).toHaveTextContent(`${CANCEL_SHEET.paid}50.00 cr`);
    expect(moneyOf()).toHaveTextContent(`${CANCEL_SHEET.goesBack(null)}50.00 cr`);
    expect(within(dialog).getByRole("list")).toHaveTextContent("Mon 9 Sep · 18:00–18:45");
    // F4-9: the × is "Close" + the sheet's own title, never a second bare "Close".
    expect(within(dialog).getByRole("button", { name: `Close ${CANCEL_SHEET.title(1)}` })).toBeTruthy();
    // The way out names what it keeps; the confirm is the danger button.
    expect(within(dialog).getByRole("button", { name: CANCEL_SHEET.keep(1) })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: CANCEL_SHEET.confirm(1) }).className).toContain("bg-danger-solid");
    expect(within(dialog).queryByText(/Keep looking|^OK$/)).toBeNull();
  });

  it("says the penalty in figures inside the window", async () => {
    stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: late }]);
    open();
    expect(await screen.findByText(CANCEL_SHEET.late(30))).toBeTruthy();
    expect(moneyOf()).toHaveTextContent(`${CANCEL_SHEET.penalty(30)}−15.00 cr`);
    expect(moneyOf()).toHaveTextContent(`${CANCEL_SHEET.goesBack(null)}35.00 cr`);
  });

  it("says nothing comes back once the lights have been on", async () => {
    stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: quote({ refundCredits: 0, checkedIn: true }) }]);
    open();
    expect(await screen.findByText(CANCEL_SHEET.checkedIn(null))).toBeTruthy();
    expect(moneyOf()).toHaveTextContent(`${CANCEL_SHEET.goesBack(null)}0.00 cr`);
  });

  it("cancels once, closes, and says what moved in a toast — no tick for a destructive action", async () => {
    const stub = stubFetch([
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: late },
      { method: "POST", path: "/api/v1/bookings/bk-1/cancel", body: { refunded_credits: 50, penalty_credits: 15 } },
    ]);
    const { onOpenChange, onCancelled } = open();
    await screen.findByText(CANCEL_SHEET.late(30));
    const confirm = screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(posts(stub.calls, "/api/v1/bookings/bk-1/cancel")).toHaveLength(1);
    expect(onCancelled).toHaveBeenCalledWith({ cancelledIds: ["bk-1"], ownMoneyMoved: true });
    expect(screen.getByText(cancellationOutcome(50, 15, null))).toBeTruthy();
    expect(document.querySelector('[data-glyph="check"]')).toBeNull();
  });

  it("keeps a refusal in the sheet and tells the page its grid is stale", async () => {
    stubFetch([
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: quote() },
      { method: "POST", path: "/api/v1/bookings/bk-1/cancel", body: refuse(404, { error: "booking_not_found" }) },
    ]);
    const { onOpenChange, onStale } = open();
    await screen.findByText(CANCEL_SHEET.free(null));
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer there/);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("still lets a member cancel when the quote will not load, and says so", async () => {
    stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: refuse(500, {}) }]);
    open();
    expect(await screen.findByText(CANCEL_SHEET.quoteFailed)).toBeTruthy();
    expect(screen.getByRole("button", { name: CANCEL_SHEET.retry })).toBeTruthy();
    expect(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) })).not.toBeDisabled();
  });
});

describe("CancelSheet — an admin, for a member", () => {
  /** R4 A4-4: a plain admin cancel (no waiver) needs a reason too — the API refuses it without. */
  it("asks why for a plain cancel of a member's booking, and sends it", async () => {
    const stub = stubFetch([
      { path: "/api/v1/bookings/bk-2/cancellation-quote", body: late },
      { method: "POST", path: "/api/v1/admin/bookings/bk-2/cancel", body: { refunded_credits: 35, penalty_credits: 15 } },
    ]);
    const { onCancelled } = open({ isAdmin: true, bookings: [THANDI] });
    expect(await screen.findByText(CANCEL_SHEET.late(30))).toBeTruthy();
    expect(screen.getByLabelText(CANCEL_SHEET.reasonLabel)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    expect(screen.getByText(CANCEL_SHEET.reasonMissing)).toBeTruthy();
    expect(posts(stub.calls, "/api/v1/admin/bookings/")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(CANCEL_SHEET.reasonLabel), { target: { value: "Member asked by phone" } });
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    await waitFor(() => expect(onCancelled).toHaveBeenCalled());
    expect(posts(stub.calls, "/api/v1/admin/bookings/bk-2/cancel")[0].body)
      .toEqual({ waivePenalty: false, reason: "Member asked by phone" });
  });

  it("names the member, and waives the penalty only with a reason", async () => {
    const stub = stubFetch([
      { path: "/api/v1/bookings/bk-2/cancellation-quote", body: late },
      { method: "POST", path: "/api/v1/admin/bookings/bk-2/cancel", body: { refunded_credits: 50, penalty_credits: 0 } },
    ]);
    const { onCancelled } = open({ isAdmin: true, bookings: [THANDI] });
    expect(await screen.findByText(CANCEL_SHEET.late(30))).toBeTruthy();
    expect(moneyOf()).toHaveTextContent(`${CANCEL_SHEET.goesBack("Thandi")}35.00 cr`);
    expect(screen.getByRole("list")).toHaveTextContent("Court 2 · Thandi");

    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(CANCEL_SHEET.waive(15)) }));
    expect(moneyOf()).toHaveTextContent(`${CANCEL_SHEET.goesBack("Thandi")}50.00 cr`);
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    expect(screen.getByText(CANCEL_SHEET.reasonMissing)).toBeTruthy();
    expect(posts(stub.calls, "/api/v1/admin/bookings/")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(CANCEL_SHEET.reasonLabel), { target: { value: "Court double-booked" } });
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    await waitFor(() => expect(onCancelled).toHaveBeenCalled());
    expect(posts(stub.calls, "/api/v1/admin/bookings/bk-2/cancel")[0].body)
      .toEqual({ waivePenalty: true, reason: "Court double-booked", waiveReason: "Court double-booked" });
    expect(onCancelled).toHaveBeenCalledWith({ cancelledIds: ["bk-2"], ownMoneyMoved: false });
    expect(screen.getByText(cancellationOutcome(50, 0, "Thandi"))).toBeTruthy();
  });

  it("cancels a batch by the bulk route with one reason, and reads back a row each", async () => {
    const stub = stubFetch([
      { path: "/api/v1/bookings/bk-2/cancellation-quote", body: late },
      { path: "/api/v1/bookings/bk-3/cancellation-quote", body: quote({ bookingId: "bk-3" }) },
      {
        method: "POST", path: "/api/v1/admin/bookings/bulk-cancel",
        body: {
          results: [
            { booking_id: "bk-2", status: "cancelled", refund_credits: 50, penalty_credits: 15 },
            { booking_id: "bk-3", status: "failed", error: "already_started" },
          ],
        },
      },
    ]);
    open({ isAdmin: true, bookings: [THANDI, SIPHO] });
    await waitFor(() => expect(moneyOf()).toHaveTextContent(`${CANCEL_SHEET.totalBack}85.00 cr`));
    expect(moneyOf()).toHaveTextContent(`${CANCEL_SHEET.penalty(30)}\u221215.00 cr`);
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(2) }));
    expect(screen.getByText(CANCEL_SHEET.reasonMissing)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(CANCEL_SHEET.reasonLabel), { target: { value: "Court 2 lights faulty" } });
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(2) }));
    expect(await screen.findByText(CANCEL_SHEET.cancelledTitle(1, 2))).toBeTruthy();
    const body = posts(stub.calls, "/api/v1/admin/bookings/bulk-cancel")[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ reason: "Court 2 lights faulty", waivePenalty: false, items: [{ bookingId: "bk-2" }, { bookingId: "bk-3" }] });
    expect(String(body.idempotencyKey)).toMatch(/^bc_/);
    const results = screen.getByRole("list", { name: RESULTS_LABEL.cancel });
    expect(results).toHaveTextContent(RESULT_WORD.cancelled);
    expect(results).toHaveTextContent("35.00 cr back, 15.00 cr penalty kept");
    expect(results).toHaveTextContent(RESULT_WORD.notCancelled);
    expect(screen.getByRole("button", { name: CANCEL_SHEET.done })).toBeTruthy();
  });
});
