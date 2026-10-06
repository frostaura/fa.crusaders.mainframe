import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceTransport } from "@/lib/liveBalance";
import { signOut, stubFetch, type StubCall } from "@/test/harness";
import { BOOK_SEATS, BOOK_SHEET } from "@/lib/bookingsCopy";
import { BOOK_PLAYERS, PICKER } from "@/lib/playersCopy";
import { BookSheet, type BookSheetProps } from "../BookSheet";
import { stepsFor } from "../bookFlow";
import type { SelectedSlot } from "../types";

/**
 * An admin booking for THEMSELVES gets the member's Players and Split steps, so the desk can try
 * the partner and split mechanics; booking for a member, or holding a court, keeps Slots → Confirm.
 */

vi.setConfig({ testTimeout: 20_000 });

const TZ = "Africa/Johannesburg";
const ME = "44444444-4444-4444-4444-444444444444";
const NALEDI = "55555555-5555-5555-5555-555555555555";
const C1: SelectedSlot = { courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00.000Z", sliceCount: 3, priceMinutes: 60 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  signOut();
  window.sessionStorage.clear();
});

describe("stepsFor — the admin's Players and Split", () => {
  it("shows an admin booking as themselves the member's steps", () => {
    expect(stepsFor({ isAdmin: true })).toEqual(["slots", "players", "confirm"]);
    expect(stepsFor({ isAdmin: true, paying: true })).toEqual(["slots", "players", "split", "confirm"]);
  });

  it("keeps Slots → Confirm for a booking on behalf of someone else or a hold", () => {
    expect(stepsFor({ isAdmin: true, forOther: true, paying: true })).toEqual(["slots", "confirm"]);
  });

  it("leaves a member's steps as they were", () => {
    expect(stepsFor({ isAdmin: false })).toEqual(["players", "confirm"]);
    expect(stepsFor({ isAdmin: false, paying: true })).toEqual(["players", "split", "confirm"]);
  });
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

function open(props: Partial<BookSheetProps> = {}) {
  render(
    <BookSheet
      open onOpenChange={vi.fn()} slots={[C1]} timezone={TZ} sliceMinutes={15}
      isAdmin actorUserId={ME} balanceMinutes={500} onBooked={vi.fn()}
      members={[{ id: NALEDI, name: "Naledi Khumalo", balance: 44 }]} {...props}
    />,
    { wrapper: Providers, reactStrictMode: true },
  );
}

const posts = (calls: StubCall[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

describe("BookSheet — an admin booking as themselves", () => {
  it("offers Players after Slots, and books Just me through the admin route as before", async () => {
    const stub = stubFetch([
      { path: "/api/v1/admin/bookings/quote", body: { user_id: ME, court_id: "c1", court_name: "Court 1", starts_at: C1.startsAt, ends_at: null, slices: 3, price_minutes: 60, balance_minutes: 500, balance_after_minutes: 440, overdraws: false } },
      { method: "POST", path: "/api/v1/admin/bookings/", body: { booking_id: "bk-1", balance_after_minutes: 440 } },
    ]);
    open();
    expect(screen.getByRole("list", { name: "Progress" })).toHaveTextContent(BOOK_SHEET.stepOf(1, 3, BOOK_SHEET.steps.slots));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    expect(await screen.findByRole("radio", { name: BOOK_PLAYERS.withOthers })).toBeTruthy();
    expect(screen.getByRole("radio", { name: BOOK_PLAYERS.justMe })).toHaveAttribute("aria-checked", "true");
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(await screen.findByRole("button", { name: BOOK_SHEET.primary(3, 60, null) }));
    await screen.findByText(BOOK_SHEET.bookedTitle(1, 1));
    expect(posts(stub.calls, "/api/v1/admin/bookings/")).toHaveLength(1);
    expect(posts(stub.calls, "/api/v1/bookings/")).toHaveLength(0);
  });

  it("books with a guest through the member's route, and no god-mode notice the player route could not honour", async () => {
    const stub = stubFetch([
      { path: "/api/v1/admin/bookings/quote", body: { user_id: ME, court_id: "c1", court_name: "Court 1", starts_at: C1.startsAt, ends_at: null, slices: 3, price_minutes: 60, balance_minutes: 20, balance_after_minutes: -40, overdraws: true } },
      { path: "/api/v1/me/partners/favourites", body: { items: [] } },
      { method: "POST", path: "/api/v1/bookings/", body: { booking_id: "bk-2", balance_after_minutes: -40, players: { booking_id: "bk-2", participants: [] }, players_error: null } },
    ]);
    open({ balanceMinutes: 20 });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    fireEvent.click(await screen.findByRole("radio", { name: BOOK_PLAYERS.withOthers }));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SEATS.addToSeat(2) }));
    await userEvent.setup().click(await screen.findByRole("tab", { name: PICKER.guest }));
    fireEvent.change(await screen.findByLabelText(PICKER.guestLabel), { target: { value: "Jo" } });
    fireEvent.click(screen.getByRole("button", { name: PICKER.guestAdd }));
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(await screen.findByRole("button", { name: BOOK_SHEET.primary(3, 60, null) }));
    await screen.findByText(BOOK_SHEET.bookedTitle(1, 1));
    expect(posts(stub.calls, "/api/v1/admin/bookings/")).toHaveLength(0);
    expect(document.querySelector("[data-god-mode]")).toBeNull();
    expect(posts(stub.calls, "/api/v1/bookings/")[0].body).toEqual({
      courtId: "c1", startsAt: C1.startsAt, sliceCount: 3, players: [{ guestName: "Jo", seat: 2 }], splitMode: "equal",
    });
  });

  it("hides Players once Book as is another member", async () => {
    stubFetch([]);
    open({ bookAsUserId: NALEDI });
    expect(screen.getByRole("list", { name: "Progress" })).toHaveTextContent(BOOK_SHEET.stepOf(1, 2, BOOK_SHEET.steps.slots));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    expect(screen.queryByRole("radio", { name: BOOK_PLAYERS.withOthers })).toBeNull();
  });
});
