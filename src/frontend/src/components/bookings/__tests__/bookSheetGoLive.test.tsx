import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceTransport } from "@/lib/liveBalance";
import { refuse, signOut, stubFetch, type StubRoute } from "@/test/harness";
import { BOOK_SEATS, BOOK_SHEET, lateStartLine } from "@/lib/bookingsCopy";
import { BOOK_PLAYERS, BOOK_SPLIT, PICKER, PLAYERS_REFUSAL } from "@/lib/playersCopy";
import { BookSheet, type BookSheetProps } from "../BookSheet";
import { splitShares } from "../splitMath";
import type { SelectedSlot } from "../types";

/**
 * Go-live member pass — the Book sheet:
 * - BM-05: a Continue the Split step refuses takes the reader to the sentence (scrolled, focused).
 * - BM-06: a slot already inside the late-cancellation window says so on Confirm.
 * - BM-19: "With other players" and nobody added says Continue books it as just you.
 * - BM-18d: the picker never names a seat number.
 */
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); signOut(); window.sessionStorage.clear(); });

const TZ = "Africa/Johannesburg";
const SAM = { user_id: "sam", name: "Sam Petersen", photo_url: null };
const quiet: BalanceTransport = { open: () => Promise.resolve({ close: () => undefined }) };
const TERMS = { penaltyPct: 30, windowMinutes: 15 };

function slotIn(minutes: number): SelectedSlot {
  const start = new Date(Math.ceil((Date.now() + minutes * 60_000) / 60_000) * 60_000).toISOString();
  return { courtId: "c1", courtName: "Court 1", startsAt: start, sliceCount: 2, priceMinutes: 30 };
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter><AuthProvider><BalanceProvider transport={quiet}><ToastProvider>{children}</ToastProvider></BalanceProvider></AuthProvider></MemoryRouter>
  );
}

function open(props: Partial<BookSheetProps> = {}) {
  render(
    <BookSheet open onOpenChange={vi.fn()} slots={[slotIn(24 * 60)]} timezone={TZ} sliceMinutes={15} isAdmin={false}
      actorUserId="me" balanceMinutes={500} onBooked={vi.fn()} {...props} />,
    { wrapper: Providers },
  );
}

const PREVIEW: StubRoute = {
  method: "POST", path: "/api/v1/players/split-preview",
  respond: ({ body }) => {
    const b = body as { priceMinutes: number; splitMode: "equal" | "ratio" | "amount"; organiserWeight?: number; players: { seat: number; guestName?: string; weight?: number; amount?: number }[] };
    const r = splitShares(b.priceMinutes, b.splitMode, b.organiserWeight ?? 1, b.players.map((p) => ({ seat: p.seat, isGuest: p.guestName !== undefined, weight: p.weight, amount: p.amount })));
    if (!r.ok) return refuse(400, { error: r.error });
    return { price_minutes: b.priceMinutes, shares: r.shares.map((s) => ({ seat: s.seat, team: s.seat <= 2 ? "A" : "B", share_minutes: s.share, weight: s.weight })) };
  },
};
const FAVOURITES: StubRoute = { path: "/api/v1/me/partners/favourites", body: { items: [SAM] } };
const pause = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const next = async () => { fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next })); await pause(); };

describe("Book sheet — go-live", () => {
  it("BM-05: a refused Continue on Split scrolls the refusal into view and focuses it", async () => {
    stubFetch([FAVOURITES, PREVIEW]);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    open();
    fireEvent.click(screen.getByRole("radio", { name: BOOK_PLAYERS.withOthers }));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SEATS.addToSeat(3) }));
    fireEvent.click(await screen.findByRole("button", { name: PICKER.add(SAM.name) }));
    await next();
    await userEvent.setup().click(screen.getByRole("radio", { name: BOOK_SPLIT.modes.amount }));
    fireEvent.change(screen.getByLabelText(BOOK_SPLIT.amountLabel("Sam")), { target: { value: "45" } });
    const refusal = screen.getByText(PLAYERS_REFUSAL.split_exceeds_price);
    expect(document.activeElement).not.toBe(refusal);
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    await waitFor(() => expect(document.activeElement).toBe(refusal.closest("[data-sheet-refusal]")));
    expect(scrolled).toHaveBeenCalled();
  });

  it("BM-18d: the picker is titled by role, never by seat number", async () => {
    stubFetch([FAVOURITES, PREVIEW]);
    open();
    fireEvent.click(screen.getByRole("radio", { name: BOOK_PLAYERS.withOthers }));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SEATS.addToSeat(4) }));
    const title = await screen.findByRole("heading", { name: BOOK_SEATS.pickerTitle(4) });
    expect(title.textContent).not.toMatch(/seat\s*\d/i);
    expect(BOOK_SEATS.addToSeat(3)).not.toMatch(/\d/);
  });

  it("BM-19: With other players and nobody added says it books as just you", async () => {
    stubFetch([FAVOURITES, PREVIEW]);
    open();
    expect(screen.queryByText(BOOK_PLAYERS.noneAdded)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: BOOK_PLAYERS.withOthers }));
    expect(screen.getByText(BOOK_PLAYERS.noneAdded)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SEATS.addToSeat(3) }));
    fireEvent.click(await screen.findByRole("button", { name: PICKER.add(SAM.name) }));
    await waitFor(() => expect(screen.queryByText(BOOK_PLAYERS.noneAdded)).toBeNull());
  });
});

describe("Confirm warns of a start inside the cancellation window (BM-06)", () => {
  async function confirmFor(slot: SelectedSlot, terms = TERMS) {
    stubFetch([]);
    open({ slots: [slot], cancelTerms: terms });
    await next();
  }

  it("a slot 6 minutes away says cancelling keeps the penalty", async () => {
    await confirmFor(slotIn(6));
    const warning = document.querySelector("[data-late-start]");
    expect(warning).not.toBeNull();
    expect(warning!.textContent).toMatch(/30%/);
    expect([lateStartLine(5, 30, 1), lateStartLine(6, 30, 1)]).toContain(warning!.textContent);
  });

  it("a slot well outside the window says nothing extra", async () => {
    await confirmFor(slotIn(90));
    expect(document.querySelector("[data-late-start]")).toBeNull();
    expect(document.querySelector("[data-cancel-terms]")).not.toBeNull();
  });

  it("a club with no penalty says nothing extra, however soon the slot", async () => {
    await confirmFor(slotIn(3), { penaltyPct: 0, windowMinutes: 15 });
    expect(document.querySelector("[data-late-start]")).toBeNull();
  });
});
