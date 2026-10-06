import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceTransport } from "@/lib/liveBalance";
import type { ScheduleDay } from "@/lib/api";
import { refuse, signOut, stubFetch } from "@/test/harness";
import { BOOK_SHEET, CANCEL_SHEET } from "@/lib/bookingsCopy";
import { BOOK_SHEET_GONE } from "@/lib/gridCopy";
import {
  CANCEL_REFUSAL_TEXT, CONFLICT_UNSURE_MANY_TEXT, CONFLICT_UNSURE_TEXT, UNSURE_MANY_TEXT, UNSURE_TEXT,
} from "@/lib/bookingErrors";
import { BookSheet, type BookSheetProps } from "../BookSheet";
import { CancelSheet, type CancelSheetProps } from "../CancelSheet";
import type { GridBooking, SelectedSlot } from "../types";

/**
 * Review round 18, lane FE18s — the bookings sheets.
 *
 * <ul>
 *   <li><b>X18-5</b> — a run of several slots whose answer was lost (or gave way to a clash) and that
 *   the schedule shows did not land says "the slots are still free", never the one slot's words.</li>
 *   <li><b>L18-2</b> — a refusal in a sheet is brought into view and takes the keyboard (book and
 *   cancel); a gone slot keeps its "Pick another time" focused (R11 X11-3), the refusal still shown.</li>
 *   <li><b>L18-10</b> — the club's cancel refused for good (already cancelled, played, a hold): the
 *   quote's figures and the Cancel button go; the way out is Done.</li>
 * </ul>
 */

vi.setConfig({ testTimeout: 30_000 });

const TZ = "Africa/Johannesburg";
const ME = "44444444-4444-4444-4444-444444444444";
const C1: SelectedSlot = { courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00.000Z", sliceCount: 1, priceMinutes: 50 };
const C2: SelectedSlot = { courtId: "c2", courtName: "Court 2", startsAt: "2030-09-09T16:00:00.000Z", sliceCount: 1, priceMinutes: 50 };

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

/** A day with nothing on it: whatever was sent did not land. */
function emptyDay(): ScheduleDay {
  return {
    date: "2030-09-09", timezone: TZ, sliceMinutes: 15, dayStartMinute: 360, dayEndMinute: 1320,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15,
    courts: [{ id: "c1", courtNumber: 1, name: "Court 1" }, { id: "c2", courtNumber: 2, name: "Court 2" }],
    slots: [],
  } as unknown as ScheduleDay;
}

function takenDay(): ScheduleDay {
  return {
    ...emptyDay(),
    slots: [{
      courtId: "c1", courtNumber: 1, startsAtUtc: C1.startsAt, endsAtUtc: "2030-09-09T16:15:00.000Z",
      status: "booked", ownerUserId: "someone", ownerFirstName: null, ownerPhotoUrl: null, isMine: false,
      bookingId: "bk-real", blockLabel: null, checkedIn: false, amountChargedMinutes: 50,
    }],
  } as unknown as ScheduleDay;
}

function openBook(slots: SelectedSlot[], props: Partial<BookSheetProps> = {}) {
  render(
    <BookSheet open onOpenChange={() => undefined} slots={slots} timezone={TZ} sliceMinutes={15}
      isAdmin={false} actorUserId={ME} balanceMinutes={500} onBooked={() => undefined} {...props} />,
    { wrapper: Providers },
  );
}

async function pressBook(count: number) {
  fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
  await new Promise((r) => setTimeout(r, 350)); // the sheet's own double-tap guard after a step change
  fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(count, 50 * count, null) }));
}

/* ─────────────────────────────── X18-5 ─────────────────────────────── */

const LOST = [
  { label: "a lost answer (503)", answer: {}, one: UNSURE_TEXT.book.checked, many: UNSURE_MANY_TEXT.checked },
  { label: "a clash (503 conflict_retry)", answer: { error: "conflict_retry" }, one: CONFLICT_UNSURE_TEXT.book.checked, many: CONFLICT_UNSURE_MANY_TEXT.checked },
] as const;

describe("X18-5 — a multi-slot run that did not land is said in the plural", () => {
  for (const o of LOST) {
    it(`two slots, ${o.label}: "the slots are still free"`, async () => {
      stubFetch([{ method: "POST", path: "/api/v1/bookings/bulk", body: refuse(503, o.answer) }]);
      openBook([C1, C2], { reread: async () => emptyDay() });
      await pressBook(2);
      expect(await screen.findByText(o.many)).toBeInTheDocument();
      expect(screen.queryByText(o.one)).toBeNull();
      expect(o.many).toMatch(/slots are still free/);
    });

    it(`one slot, ${o.label}: the one slot's words, as before`, async () => {
      stubFetch([{ method: "POST", path: "/api/v1/bookings/", body: refuse(503, o.answer) }]);
      openBook([C1], { reread: async () => emptyDay() });
      await pressBook(1);
      expect(await screen.findByText(o.one)).toBeInTheDocument();
    });
  }

  it("two slots and the re-read failed too: \"whether these were booked\"", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/bookings/bulk", body: refuse(503, {}) }]);
    openBook([C1, C2], { reread: async () => null });
    await pressBook(2);
    expect(await screen.findByText(UNSURE_MANY_TEXT.unchecked)).toBeInTheDocument();
  });
});

/* ─────────────────────────────── L18-2 (book) ─────────────────────────────── */

describe("L18-2 — the Book sheet's refusal is brought into view and takes the keyboard", () => {
  it("a lost answer: the refusal is scrolled to and focused", async () => {
    const seen: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) { seen.push(this); });
    stubFetch([{ method: "POST", path: "/api/v1/bookings/", body: refuse(503, {}) }]);
    openBook([C1], { reread: async () => emptyDay() });
    await pressBook(1);
    const alert = (await screen.findByText(UNSURE_TEXT.book.checked)).closest("[data-sheet-refusal]") as HTMLElement;
    expect(alert).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(seen).toContain(alert);
  });

  it("a gone slot: 'Pick another time' keeps the keyboard (X11-3), the refusal is still scrolled to and describes it", async () => {
    const seen: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) { seen.push(this); });
    stubFetch([{ method: "POST", path: "/api/v1/bookings/", body: refuse(409, { error: "slot_taken" }) }]);
    openBook([C1], { reread: async () => takenDay() });
    await pressBook(1);
    const pick = await screen.findByRole("button", { name: BOOK_SHEET_GONE.pickAnother });
    const alert = (await screen.findByText(/Someone just took that slot/)).closest("[data-sheet-refusal]") as HTMLElement;
    await waitFor(() => expect(seen).toContain(alert));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).toBe(pick);
    expect(pick.getAttribute("aria-describedby") ?? "").toContain(alert.id);
  });
});

/* ─────────────────────────────── L18-2 (cancel) + L18-10 ─────────────────────────────── */

const BOOKING: GridBooking = {
  bookingId: "bk-1", courtId: "c1", courtName: "Court 1",
  startsAt: "2030-09-09T16:00:00.000Z", endsAt: "2030-09-09T16:45:00.000Z", whenLabel: "Mon 9 Sep, 18:00",
  mine: true, memberFirstName: null, memberPhotoUrl: null, checkedIn: null, amountChargedMinutes: 50,
  timezone: TZ,
};
const THEIRS: GridBooking = { ...BOOKING, mine: false, memberFirstName: "Thandi" };
const quote = (over: Record<string, unknown> = {}) => ({
  bookingId: "bk-1", amountChargedMinutes: 50, refundMinutes: 35, penaltyMinutes: 15, penaltyPct: 30,
  penaltyWindowMinutes: 120, insidePenaltyWindow: true, checkedIn: false, alreadyStarted: false, ...over,
});

function openCancel(props: Partial<CancelSheetProps>) {
  render(
    <CancelSheet open onOpenChange={() => undefined} bookings={[BOOKING]} isAdmin={false} onCancelled={() => undefined} {...props} />,
    { wrapper: Providers },
  );
  return screen.getByRole("dialog");
}

describe("L18-2 — the Cancel sheet's refusal is brought into view and takes the keyboard", () => {
  it("a clash (conflict_retry) the schedule shows did not cancel: scrolled to and focused", async () => {
    const seen: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) { seen.push(this); });
    stubFetch([
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: quote() },
      { method: "POST", path: "/api/v1/bookings/bk-1/cancel", body: refuse(503, { error: "conflict_retry" }) },
    ]);
    const reread = async () => ({ ...emptyDay(), slots: [{ ...takenDay().slots[0], bookingId: "bk-1", isMine: true }] }) as ScheduleDay;
    const dialog = openCancel({ reread });
    fireEvent.click(await within(dialog).findByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    const alert = (await within(dialog).findByText(CONFLICT_UNSURE_TEXT.cancel.checked)).closest("[data-sheet-refusal]") as HTMLElement;
    expect(alert).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(seen).toContain(alert);
  });
});

/** The sheet's refusal (the quote's own consequence line is an alert too). */
async function refusalIn(dialog: HTMLElement): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = dialog.querySelector<HTMLElement>("[data-sheet-refusal]");
    expect(found).not.toBeNull();
  });
  return found!;
}

const TERMINAL = [
  { label: "already cancelled (booking_not_open)", body: { error: "booking_not_open" }, said: CANCEL_REFUSAL_TEXT.alreadyCancelled },
  { label: "played (not_cancellable)", body: { error: "not_cancellable", status: "completed" }, said: CANCEL_REFUSAL_TEXT.completed },
  { label: "a hold (not_cancellable)", body: { error: "not_cancellable", status: "blocked" }, said: CANCEL_REFUSAL_TEXT.blocked },
] as const;

describe("L18-10 — a cancel refused for good drops the quote and the Cancel button", () => {
  for (const t of TERMINAL) {
    it(`the club's cancel, ${t.label}`, async () => {
      stubFetch([
        { path: "/api/v1/admin/bookings/bk-1/cancellation-quote", body: quote() },
        { path: "/api/v1/bookings/bk-1/cancellation-quote", body: quote() },
        { method: "POST", path: "/api/v1/admin/bookings/bk-1/cancel", body: refuse(409, t.body) },
      ]);
      const onStale = vi.fn();
      const dialog = openCancel({ bookings: [THEIRS], isAdmin: true, onStale });
      fireEvent.change(await within(dialog).findByRole("textbox"), { target: { value: "Booked in error" } });
      // The quote's figures are on screen before the press.
      expect(await within(dialog).findByText(CANCEL_SHEET.late(30))).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
      const alert = await refusalIn(dialog);
      expect(alert).toHaveTextContent(t.said);
      await waitFor(() => expect(within(dialog).queryByRole("button", { name: CANCEL_SHEET.confirm(1) })).toBeNull());
      expect(within(dialog).queryByText(CANCEL_SHEET.late(30))).toBeNull();
      expect(within(dialog).queryByRole("term")).toBeNull();
      expect(within(dialog).queryByRole("textbox")).toBeNull();
      expect(within(dialog).queryByRole("button", { name: CANCEL_SHEET.keep(1) })).toBeNull();
      expect(within(dialog).getByRole("button", { name: CANCEL_SHEET.done })).toBeInTheDocument();
      expect(onStale).toHaveBeenCalled();
      await waitFor(() => expect(document.activeElement).toBe(alert));
    });
  }

  it("a member's own cancel of a booking already gone (booking_not_found) is final too", async () => {
    stubFetch([
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: quote() },
      { method: "POST", path: "/api/v1/bookings/bk-1/cancel", body: refuse(404, { error: "booking_not_found" }) },
    ]);
    const dialog = openCancel({});
    fireEvent.click(await within(dialog).findByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    await refusalIn(dialog);
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: CANCEL_SHEET.confirm(1) })).toBeNull());
    expect(within(dialog).getByRole("button", { name: CANCEL_SHEET.done })).toBeInTheDocument();
  });

  it("a refusal that is not final (rate limited) keeps the quote and the Cancel button", async () => {
    stubFetch([
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: quote() },
      { method: "POST", path: "/api/v1/bookings/bk-1/cancel", body: refuse(429, { error: "rate_limited", retry_after_seconds: 5 }) },
    ]);
    const dialog = openCancel({});
    fireEvent.click(await within(dialog).findByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    await refusalIn(dialog);
    expect(within(dialog).getByRole("button", { name: CANCEL_SHEET.confirm(1) })).toBeInTheDocument();
    expect(within(dialog).getByText(CANCEL_SHEET.late(30))).toBeInTheDocument();
  });
});
