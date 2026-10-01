import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import { useSheetHistory } from "@/lib/bookingSheetHistory";
import { stubFetch } from "@/test/harness";
import { BOOK_SHEET, CANCEL_SHEET } from "@/lib/bookingsCopy";
import { BookSheet } from "../BookSheet";
import { CancelSheet } from "../CancelSheet";
import type { GridBooking, SelectedSlot } from "../types";

/**
 * R4 I4-1 / I4-2 — a money write in flight keeps its sheet open, and a quick first tap on Book is
 * a booking, not a dropped press.
 *
 * <p>
 * The review's repro: Book on a slow reply → Back → Cancel (or Escape, or ×) closed the sheet with
 * nothing said; the booking landed a moment later and 50 credits were gone. Every way out now waits
 * for the club's answer and says so; an answer arriving after the sheet was torn down is a toast.
 * </p>
 */
const C1: SelectedSlot = { courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00.000Z", sliceCount: 1, priceMinutes: 50 };
const MINE: GridBooking = {
  bookingId: "bk-1", courtId: "c1", courtName: "Court 1",
  startsAt: "2030-09-09T16:00:00.000Z", endsAt: "2030-09-09T16:45:00.000Z", whenLabel: "Mon 9 Sep, 18:00",
  mine: true, memberFirstName: null, memberPhotoUrl: null, checkedIn: false, amountChargedMinutes: 50,
  timezone: "Africa/Johannesburg",
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Providers({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter><AuthProvider><BalanceProvider><ToastProvider>{children}</ToastProvider></BalanceProvider></AuthProvider></MemoryRouter>
  );
}

/**
 * The slow club: every POST is held until the test answers it (the stub's own `respond` cannot
 * wait, so its fetch is wrapped). Reads answer at once.
 */
function holdPosts() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    ((init?.method ?? "GET").toUpperCase() === "POST" ? gate.then(() => inner(input, init)) : inner(input, init)));
  return { answer: () => act(async () => { release(); await gate; await new Promise((r) => setTimeout(r, 0)); }) };
}

const dialog = () => screen.getByRole("dialog");
const bookButton = () => within(dialog()).getByRole("button", { name: /^Book · / });
const closeX = () => within(dialog()).getByRole("button", { name: /^Close/ });

function openBook(onOpenChange = vi.fn()) {
  const onBooked = vi.fn();
  render(
    <BookSheet open onOpenChange={onOpenChange} slots={[C1]} timezone="Africa/Johannesburg" sliceMinutes={15}
      isAdmin={false} actorUserId="me" balanceMinutes={500} onBooked={onBooked} />,
    { wrapper: Providers, reactStrictMode: true },
  );
  return { onOpenChange, onBooked };
}

describe("BookSheet — nothing leaves the sheet while a booking is on its way (I4-1)", () => {
  it("refuses Back, the ×, Escape and the scrim until the club answers, then shows what happened", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/bookings/", body: { booking_id: "b1", balance_after_minutes: 450 } }]);
    const slow = holdPosts();
    const { onOpenChange, onBooked } = openBook();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    fireEvent.click(bookButton(), { detail: 1 });

    // In flight: the waiting line stands where Back was — no way out is offered, and it says why.
    await waitFor(() => expect(within(dialog()).getByText(BOOK_SHEET.sending)).toBeVisible());
    expect(within(dialog()).queryByRole("button", { name: BOOK_SHEET.back })).toBeNull();
    expect(bookButton()).toHaveAttribute("aria-busy", "true"); // still on Confirm, still sending

    fireEvent.click(closeX());
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // The club answers: the sheet says so, and only now may it close.
    await slow.answer();
    await waitFor(() => expect(onBooked).toHaveBeenCalledTimes(1));
    expect(within(dialog()).queryByText(BOOK_SHEET.sending)).not.toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: BOOK_SHEET.done }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("says a booking that lands after the sheet was torn down, in a toast", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/bookings/", body: { booking_id: "b1", balance_after_minutes: 450 } }]);
    const slow = holdPosts();
    function Host() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShown(false)}>tear down</button>
          {shown ? (
            <BookSheet open onOpenChange={vi.fn()} slots={[C1]} timezone="Africa/Johannesburg" sliceMinutes={15}
              isAdmin={false} actorUserId="me" balanceMinutes={500} />
          ) : null}
        </>
      );
    }
    render(<Host />, { wrapper: Providers });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    fireEvent.click(bookButton(), { detail: 1 });
    fireEvent.click(screen.getByText("tear down")); // outside the modal, so hidden from roles
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await slow.answer();
    expect(await screen.findByText(/The booking went through: .*It's on the schedule\./)).toBeInTheDocument();
  });
});

describe("BookSheet — a quick first tap on Book books (I4-2)", () => {
  it("accepts a single tap straight after Continue, and ignores only a double tap's second half", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/bookings/", body: { booking_id: "b1", balance_after_minutes: 450 } }]);
    openBook();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }), { detail: 1 });
    // The double tap on Continue: its second click (detail 2) lands on Book — ignored.
    fireEvent.click(bookButton(), { detail: 2 });
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(bookButton()).not.toHaveAttribute("aria-disabled");
    // …and never in silence: the sheet says why nothing happened.
    expect(within(dialog()).getByText(BOOK_SHEET.doubleTapIgnored)).toBeVisible();
    // A deliberate tap, however quick, is a booking.
    fireEvent.click(bookButton(), { detail: 1 });
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1));
  });
});

describe("CancelSheet — Keep, the × and Escape wait for the club (I4-1)", () => {
  it("refuses every way out while the cancel is on its way", async () => {
    stubFetch([
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: { bookingId: "bk-1", amountChargedMinutes: 50, refundMinutes: 50, penaltyMinutes: 0, penaltyPct: 30, penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false } },
      { method: "POST", path: "/api/v1/bookings/bk-1/cancel", body: { refunded_minutes: 50, penalty_minutes: 0 } },
    ]);
    const slow = holdPosts();
    const onOpenChange = vi.fn();
    render(<CancelSheet open onOpenChange={onOpenChange} bookings={[MINE]} isAdmin={false} />, { wrapper: Providers, reactStrictMode: true });
    fireEvent.click(await within(dialog()).findByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    await waitFor(() => expect(within(dialog()).getByText(CANCEL_SHEET.sending)).toBeVisible());
    expect(within(dialog()).queryByRole("button", { name: CANCEL_SHEET.keep(1) })).toBeNull();
    fireEvent.click(closeX());
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    await slow.answer();
    // A single cancellation closes itself with its toast once it is answered.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe("useSheetHistory — a sheet may refuse the system Back (I4-1)", () => {
  it("keeps the sheet open and puts its entry back when close returns false", async () => {
    const closes = vi.fn();
    function Sheet() {
      const navigate = useNavigate();
      const [open, setOpen] = useState(true);
      const [busy, setBusy] = useState(true);
      useSheetHistory(open, () => { closes(); return busy ? false : setOpen(false); }, "book");
      return (
        <p>
          {open ? "open" : "closed"}
          <button type="button" onClick={() => setBusy(false)}>answered</button>
          <button type="button" onClick={() => navigate(-1)}>system back</button>
        </p>
      );
    }
    const goBack = () => fireEvent.click(screen.getByRole("button", { name: "system back" }));
    render(<MemoryRouter initialEntries={["/bookings"]}><Sheet /></MemoryRouter>);
    await act(async () => { goBack(); });
    expect(closes).toHaveBeenCalledTimes(1);
    expect(screen.getByText("open")).toBeInTheDocument();
    // Answered: the next Back closes it — so the refused Back really did put the entry back.
    fireEvent.click(screen.getByRole("button", { name: "answered" }));
    await act(async () => { goBack(); });
    await waitFor(() => expect(screen.getByText("closed")).toBeInTheDocument());
  });
});
