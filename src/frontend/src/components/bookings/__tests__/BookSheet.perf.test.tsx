import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import { refuse, stubFetch } from "@/test/harness";
import { BOOK_SHEET } from "@/lib/bookingsCopy";
import { BookSheet } from "../BookSheet";
import type { SelectedSlot } from "../types";

/**
 * Perf lane (2026-09-30) — what the sheet does so a booking FEELS instant without hiding anything:
 * the guard after Continue is visible, the grid is told what is being sent the moment Book is
 * pressed, and a refusal takes that back at once.
 */
const C1: SelectedSlot = { courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00.000Z", sliceCount: 1, priceCredits: 50 };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Providers({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter><AuthProvider><BalanceProvider><ToastProvider>{children}</ToastProvider></BalanceProvider></AuthProvider></MemoryRouter>
  );
}

function open() {
  const onBooked = vi.fn();
  const onSending = vi.fn();
  render(
    <BookSheet open onOpenChange={vi.fn()} slots={[C1]} timezone="Africa/Johannesburg" sliceMinutes={15}
      isAdmin={false} actorUserId="me" balanceCredits={500} onBooked={onBooked} onSending={onSending} />,
    { wrapper: Providers, reactStrictMode: true },
  );
  return { onBooked, onSending };
}

const bookButton = () => within(screen.getByRole("dialog")).getByRole("button", { name: /^Book · / });

describe("BookSheet — the guard after Continue", () => {
  it("shows Book unavailable for its few hundred ms, ignores a press then, and is ready after", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/bookings/", body: { booking_id: "b1", balance_after_credits: 450 } }]);
    open();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    // A double tap's second half lands here: visibly not ready, and nothing is sent.
    expect(bookButton()).toHaveAttribute("aria-disabled", "true");
    expect(bookButton()).toHaveAttribute("data-settling");
    fireEvent.click(bookButton());
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await waitFor(() => expect(bookButton()).not.toHaveAttribute("data-settling"));
    expect(bookButton()).not.toHaveAttribute("aria-disabled");
    fireEvent.click(bookButton());
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1));
  });
});

describe("BookSheet — what the grid is told", () => {
  it("names the slots it is sending the moment Book is pressed, and reports the booking from its own answer", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/bookings/", body: { booking_id: "b1", balance_after_credits: 450 } }]);
    const { onBooked, onSending } = open();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    await waitFor(() => expect(bookButton()).not.toHaveAttribute("data-settling"));
    fireEvent.click(bookButton());
    expect(onSending).toHaveBeenCalledWith([C1]);
    await waitFor(() => expect(onBooked).toHaveBeenCalledTimes(1));
    expect(onBooked.mock.calls[0][0]).toMatchObject({ booked: [C1], ownBalanceAfter: 450 });
    // The page clears the mark with the cells it paints; the sheet never says "nothing" on success.
    expect(onSending).not.toHaveBeenCalledWith(null);
  });

  it("takes the mark back at once when the club refuses, and the sheet says why", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/bookings/", respond: () => refuse(409, { error: "slot_taken" }) },
      { path: "/api/v1/schedule", respond: () => refuse(503, { error: "unavailable" }) }]);
    const { onBooked, onSending } = open();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    await waitFor(() => expect(bookButton()).not.toHaveAttribute("data-settling"));
    fireEvent.click(bookButton());
    expect(onSending).toHaveBeenCalledWith([C1]);
    await waitFor(() => expect(onSending).toHaveBeenLastCalledWith(null));
    expect(onBooked).not.toHaveBeenCalled();
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toBeInTheDocument();
  });
});
