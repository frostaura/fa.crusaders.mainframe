import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceTransport } from "@/lib/liveBalance";
import { signOut, stubFetch, unreachable } from "@/test/harness";
import { BOOK_SHEET, CANCEL_SHEET } from "@/lib/bookingsCopy";
import { NOT_SENT_TEXT, UNSURE_TEXT } from "@/lib/bookingErrors";
import { BookSheet } from "../BookSheet";
import { CancelSheet } from "../CancelSheet";
import type { GridBooking, SelectedSlot } from "../types";

/**
 * R3 I-4 — booking (or cancelling) while the phone knows it is offline. Nothing leaves the phone,
 * so nothing happened, and the sheet says exactly that — it used to say "we can't tell whether
 * this was booked", which sends a member to check a wallet that cannot have moved.
 */

vi.setConfig({ testTimeout: 15_000 });

const TZ = "Africa/Johannesburg";
const ME = "44444444-4444-4444-4444-444444444444";
const C1: SelectedSlot = { courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00.000Z", sliceCount: 1, priceMinutes: 50 };
const MINE: GridBooking = {
  bookingId: "bk-1", courtId: "c1", courtName: "Court 1",
  startsAt: C1.startsAt, endsAt: "2030-09-09T16:15:00.000Z", whenLabel: "Mon 9 Sep, 18:00",
  mine: true, memberFirstName: null, memberPhotoUrl: null, checkedIn: false, amountChargedMinutes: 50, timezone: TZ,
};
const QUOTE = {
  bookingId: "bk-1", amountChargedMinutes: 50, refundMinutes: 50, penaltyMinutes: 0, penaltyPct: 30,
  penaltyWindowMinutes: 15, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  signOut();
});

const quietStream: BalanceTransport = { open: () => Promise.resolve({ close: () => undefined }) };

function Providers({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <AuthProvider>
        <BalanceProvider transport={quietStream}>
          <ToastProvider>{children}</ToastProvider>
        </BalanceProvider>
      </AuthProvider>
    </MemoryRouter>
  );
}

function offline() {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
}

describe("R3 I-4 — offline, nothing is sent, and the sheet says so", () => {
  it("a booking made offline says nothing was booked, and sends nothing", async () => {
    const stub = stubFetch([unreachable("/api/v1/bookings/", "POST")]);
    const reread = vi.fn(async () => null);
    render(
      <BookSheet open onOpenChange={vi.fn()} slots={[C1]} timezone={TZ} sliceMinutes={15}
        isAdmin={false} actorUserId={ME} balanceCredits={500} reread={reread} />,
      { wrapper: Providers, reactStrictMode: true },
    );
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    await new Promise((r) => setTimeout(r, 350));
    offline();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(1, 50, null) }));
    expect(await screen.findByText(NOT_SENT_TEXT.book)).toBeTruthy();
    expect(screen.queryByText(UNSURE_TEXT.book.unchecked)).toBeNull();
    expect(stub.calls.some((c) => c.method === "POST" && c.path.startsWith("/api/v1/bookings"))).toBe(false);
    expect(reread).not.toHaveBeenCalled();
  });

  it("a cancel made offline says the booking is still there, and sends nothing", async () => {
    const stub = stubFetch([
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: QUOTE },
      unreachable("/api/v1/bookings/bk-1/cancel", "POST"),
    ]);
    render(
      <CancelSheet open onOpenChange={vi.fn()} bookings={[MINE]} isAdmin={false} reread={async () => null} />,
      { wrapper: Providers, reactStrictMode: true },
    );
    await screen.findByText(CANCEL_SHEET.free(null));
    offline();
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    expect(await screen.findByText(NOT_SENT_TEXT.cancel)).toBeTruthy();
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);
  });
});
