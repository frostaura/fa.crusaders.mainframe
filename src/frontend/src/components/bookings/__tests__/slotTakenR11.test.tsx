import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceTransport } from "@/lib/liveBalance";
import type { ScheduleDay } from "@/lib/api";
import { refuse, signOut, stubFetch } from "@/test/harness";
import { BOOK_SHEET } from "@/lib/bookingsCopy";
import { BOOK_SHEET_GONE } from "@/lib/gridCopy";
import { BookSheet, type BookSheetProps } from "../BookSheet";
import type { SelectedSlot } from "../types";

/**
 * R11 X11-3 — after a 409 slot_taken the Book sheet kept "Book · 15 minutes" enabled and focused
 * for a slot that was gone. The primary becomes "Pick another time" (closing onto the refreshed
 * grid), and focus is on it.
 */

vi.setConfig({ testTimeout: 15_000 });

const TZ = "Africa/Johannesburg";
const ME = "44444444-4444-4444-4444-444444444444";
const C1: SelectedSlot = { courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00.000Z", sliceCount: 1, priceMinutes: 50 };

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

function day(slots: Partial<ScheduleDay["slots"][number]>[]): ScheduleDay {
  return {
    date: "2030-09-09", timezone: TZ, sliceMinutes: 15, dayStartMinute: 360, dayEndMinute: 1320,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15,
    courts: [{ id: "c1", courtNumber: 1, name: "Court 1" }],
    slots: slots.map((s) => ({
      courtId: "c1", courtNumber: 1, startsAtUtc: C1.startsAt, endsAtUtc: "2030-09-09T16:15:00.000Z",
      status: "booked", ownerUserId: null, ownerFirstName: null, ownerPhotoUrl: null, isMine: false,
      bookingId: "bk-real", blockLabel: null, checkedIn: false, amountChargedMinutes: 50, ...s,
    })),
  } as ScheduleDay;
}

function openBook(props: Partial<BookSheetProps> = {}) {
  const onBooked = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <BookSheet open onOpenChange={onOpenChange} slots={[C1]} timezone={TZ} sliceMinutes={15}
      isAdmin={false} actorUserId={ME} balanceMinutes={500} onBooked={onBooked} {...props} />,
    { wrapper: Providers, reactStrictMode: true },
  );
  return { onBooked, onOpenChange };
}

async function toConfirm() {
  fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
  await new Promise((r) => setTimeout(r, 350));
}

const BOOK_POST = "/api/v1/bookings/";

describe("R11 X11-3 — a slot taken under the member", () => {
  it("swaps Book for 'Pick another time', focused, which closes onto the grid", async () => {
    stubFetch([{ method: "POST", path: BOOK_POST, body: refuse(409, { error: "slot_taken" }) }]);
    const { onOpenChange } = openBook({ reread: async () => day([{ isMine: false, ownerUserId: "someone" }]) });
    await toConfirm();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(1, 50, null) }));
    expect(await screen.findByText(/Someone just took that slot/)).toBeTruthy();
    const pick = await screen.findByRole("button", { name: BOOK_SHEET_GONE.pickAnother });
    expect(screen.queryByRole("button", { name: BOOK_SHEET.primary(1, 50, null) })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(pick));
    fireEvent.click(pick);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a lost answer is not a gone slot: no 'Pick another time'", async () => {
    stubFetch([{ method: "POST", path: BOOK_POST, body: refuse(500, { error: "boom" }) }]);
    openBook({ reread: async () => day([]) });
    await toConfirm();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(1, 50, null) }));
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole("button", { name: BOOK_SHEET_GONE.pickAnother })).toBeNull();
  });
});
