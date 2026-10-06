import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import { useBalance } from "@/lib/useBalance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { BOOK_SHEET } from "@/lib/bookingsCopy";
import { minutesSpoken } from "@/lib/minutes";
import { signIn, signOut, stubFetch } from "@/test/harness";
import { MinutesChip } from "@/components/shell/MinutesChip";
import { BookSheet, type BookedOutcome } from "../BookSheet";
import type { SelectedSlot } from "../types";

/**
 * R19 J19-2 — the Done line "Your balance is now X" was the booking answer's figure for as long as
 * the sheet stayed open: a +9 club adjustment landing just after the answer moved the chip to 459
 * while the sheet still said 450. The line now follows the live wallet once it has caught up with
 * the booking, and matches the chip. Another member's figure is not live here, so it says "after
 * this booking" instead of "now".
 */

vi.setConfig({ testTimeout: 30_000 });

const TZ = "Africa/Johannesburg";
const ME = "44444444-4444-4444-4444-444444444444";
const C1: SelectedSlot = { courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00.000Z", sliceCount: 1, priceMinutes: 50 };
const BOOK_POST = "/api/v1/bookings/";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); signOut(); localStorage.clear(); });

type Rig = { push: (f: BalanceFrame) => Promise<void>; line: () => string | null; chip: () => string };

/** Schedule's own wiring: the booking answer is handed to the live wallet (`applyBalance`). */
function SheetLikeSchedule({ wire }: { wire: boolean }) {
  const { apply } = useBalance();
  const onBooked = useCallback((o: BookedOutcome) => {
    if (wire && o.ownBalanceAfter !== null) apply(o.ownBalanceAfter);
  }, [apply, wire]);
  return (
    <BookSheet open onOpenChange={vi.fn()} slots={[C1]} timezone={TZ} sliceMinutes={15}
      isAdmin={false} actorUserId={ME} balanceMinutes={500} onBooked={onBooked} />
  );
}

async function mount(opts: { wallet: Record<string, unknown>; answer: unknown; inFlight?: BalanceFrame; wire?: boolean }): Promise<Rig> {
  const whoami = signIn({ isAdmin: false });
  let live: { onFrame: (f: BalanceFrame) => void } | null = null;
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { entries: [], total_entries: 0, offset: 0, limit: 100, ...opts.wallet } },
    {
      method: "POST", path: BOOK_POST,
      // A frame that lands while the booking is on its way: the answer arrives after it.
      respond: () => { if (opts.inFlight) live?.onFrame(opts.inFlight); return opts.answer; },
    },
  ]);
  const transport: BalanceTransport = { open: (args) => { live = args; return Promise.resolve({ close: () => { live = null; } }); } };
  const Wrap = ({ children }: { children: ReactNode }) => (
    <MemoryRouter><AuthProvider><BalanceProvider transport={transport}><ToastProvider>{children}</ToastProvider></BalanceProvider></AuthProvider></MemoryRouter>
  );
  const view = render(<Wrap><MinutesChip /><SheetLikeSchedule wire={opts.wire ?? true} /></Wrap>);
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return {
    push: (f) => act(async () => { live?.onFrame(f); }),
    line: () => view.container.ownerDocument.querySelector("[data-sheet='book'] [role='status'] .text-sm")?.textContent ?? null,
    chip: () => view.container.querySelector("[aria-label^='Wallet balance']")?.getAttribute("aria-label") ?? "",
  };
}

async function book() {
  fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
  await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
  fireEvent.click(await screen.findByRole("button", { name: BOOK_SHEET.primary(1, 50, null) }));
  expect(await screen.findByText(BOOK_SHEET.bookedTitle(1, 1))).toBeTruthy();
}

describe("R19 J19-2 — the Done line matches the chip when a club movement lands around the booking", () => {
  it("+9 adjustment just AFTER the answer: the line moves to 459 with the chip", async () => {
    const rig = await mount({ wallet: { balance_minutes: 500 }, answer: { booking_id: "bk-1", balance_after_minutes: 450 } });
    await book();
    expect(rig.line()).toBe(BOOK_SHEET.balanceLine(450, null));
    await rig.push({ balance_minutes: 459, delta_minutes: 9, reason: "admin_adjustment", actor_name: "Club desk" } as BalanceFrame);
    expect(rig.line()).toBe(BOOK_SHEET.balanceLine(459, null));
    expect(rig.chip()).toContain(minutesSpoken(459));
  });

  it("+9 adjustment while the booking is IN FLIGHT (the answer is dropped for the newer frame): the line follows the frame", async () => {
    const rig = await mount({
      wallet: { balance_minutes: 500 },
      answer: { booking_id: "bk-1", balance_after_minutes: 450 },
      inFlight: { balance_minutes: 459, delta_minutes: 9, reason: "admin_adjustment", actor_name: "Club desk" } as BalanceFrame,
    });
    await book();
    expect(rig.chip()).toContain(minutesSpoken(459));
    expect(rig.line()).toBe(BOOK_SHEET.balanceLine(459, null));
  });

  it("held minutes: the spendable line follows the chip's spendable figure", async () => {
    const rig = await mount({
      wallet: { balance_minutes: 500, held_minutes: 50, spendable_minutes: 450, held_until: "2030-09-11T16:00:00Z" },
      answer: { booking_id: "bk-1", balance_after_minutes: 450 },
    });
    await book();
    expect(rig.line()).toBe(BOOK_SHEET.availableLine(400, null));
    await rig.push({ balance_minutes: 459, delta_minutes: 9, reason: "admin_adjustment", held_minutes: 50, spendable_minutes: 409, held_until: "2030-09-11T16:00:00Z" } as BalanceFrame);
    expect(rig.line()).toBe(BOOK_SHEET.availableLine(409, null));
  });

  it("no page hands the answer to the wallet: the line keeps the answer's figure (never the pre-booking 500)", async () => {
    const rig = await mount({ wallet: { balance_minutes: 500 }, answer: { booking_id: "bk-1", balance_after_minutes: 450 }, wire: false });
    await book();
    expect(rig.line()).toBe(BOOK_SHEET.balanceLine(450, null));
  });
});

describe("R19 J19-2 — another member's figure is the answer's, worded as such", () => {
  it("says 'after this booking', not 'now'", () => {
    expect(BOOK_SHEET.balanceLine(-16, "Naledi")).toBe("Naledi's balance after this booking: minus 16 minutes.");
    expect(BOOK_SHEET.availableLine(40, "Naledi")).toBe("Naledi has 40 minutes to spend after this booking.");
    expect(BOOK_SHEET.balanceLine(450, null)).not.toMatch(/after this booking/);
  });
});
