import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceTransport } from "@/lib/liveBalance";
import type { ScheduleDay } from "@/lib/api";
import { refuse, signIn, signOut, stubFetch, unreachable } from "@/test/harness";
import { BOOK_SHEET, CANCEL_SHEET, GOD_MODE, SPLIT_CANCEL, cancelTermsLine } from "@/lib/bookingsCopy";
import { UNSURE_TEXT, cancellationOutcome, describeBookingError } from "@/lib/bookingErrors";
import { ApiError } from "@/lib/api";
import { BookSheet, type BookSheetProps } from "../BookSheet";
import { CancelSheet, type CancelSheetProps } from "../CancelSheet";
import type { GridBooking, SelectedSlot } from "../types";

/**
 * Review round 1, F1.1–F1.5: what the sheets say when the club's answer is lost, when a cancel
 * fails, and which balance figure every line reads. Each case is a defect a reviewer reproduced:
 * "Nothing was booked" after the club had booked and charged; the booking's sentence under a
 * failed cancel; Confirm and Done disagreeing (300 vs 350); the desk's quote contradicting its own
 * god-mode notice; a group-window refusal read as "Try again in a moment".
 */

vi.setConfig({ testTimeout: 15_000 });

const TZ = "Africa/Johannesburg";
const ME = "44444444-4444-4444-4444-444444444444";
const NALEDI = "bbbbbbbb-0000-4000-8000-00000000000b";
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
  render(
    <BookSheet open onOpenChange={vi.fn()} slots={[C1]} timezone={TZ} sliceMinutes={15}
      isAdmin={false} actorUserId={ME} balanceMinutes={500} onBooked={onBooked} {...props} />,
    { wrapper: Providers, reactStrictMode: true },
  );
  return { onBooked };
}

async function toConfirm() {
  fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
  await new Promise((r) => setTimeout(r, 350));
}

const BOOK_POST = "/api/v1/bookings/";

describe("F1.1 — a booking whose answer was lost is checked against the schedule", () => {
  it("a 504 after the club booked shows it booked, not 'Nothing was booked'", async () => {
    stubFetch([{ method: "POST", path: BOOK_POST, status: 504, body: { error: "gateway_timeout" } }]);
    const reread = vi.fn(async () => day([{ isMine: true, ownerUserId: ME }]));
    const { onBooked } = openBook({ reread });
    await toConfirm();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(1, 50, null) }));
    expect(await screen.findByText(BOOK_SHEET.bookedTitle(1, 1))).toBeTruthy();
    expect(screen.getByText(BOOK_SHEET.provenNote)).toBeTruthy();
    expect(screen.queryByText(/Nothing was booked/)).toBeNull();
    expect(reread).toHaveBeenCalledTimes(1);
    expect(onBooked).toHaveBeenCalledWith(expect.objectContaining({ proven: true, booked: [C1] }));
  });

  it("a timeout with the slot still free says so — checked, not assumed", async () => {
    stubFetch([unreachable(BOOK_POST, "POST")]);
    openBook({ reread: async () => day([]) });
    await toConfirm();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(1, 50, null) }));
    expect(await screen.findByText(UNSURE_TEXT.book.checked)).toBeTruthy();
  });

  it("when even the schedule can't be read, it says it cannot tell", async () => {
    stubFetch([{ method: "POST", path: BOOK_POST, status: 502, body: {} }]);
    openBook({ reread: async () => null });
    await toConfirm();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(1, 50, null) }));
    expect(await screen.findByText(UNSURE_TEXT.book.unchecked)).toBeTruthy();
  });

  it("'taken' on a slot that is the member's own reads as theirs, not someone else's", async () => {
    stubFetch([{ method: "POST", path: BOOK_POST, body: refuse(409, { error: "slot_taken" }) }]);
    openBook({ reread: async () => day([{ isMine: true, ownerUserId: ME }]) });
    await toConfirm();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(1, 50, null) }));
    expect(await screen.findByText(BOOK_SHEET.bookedTitle(1, 1))).toBeTruthy();
    expect(screen.queryByText(/Someone just took/)).toBeNull();
  });

  it("'taken' by somebody else is still the plain refusal", async () => {
    stubFetch([{ method: "POST", path: BOOK_POST, body: refuse(409, { error: "slot_taken" }) }]);
    openBook({ reread: async () => day([{ isMine: false, ownerUserId: "someone" }]) });
    await toConfirm();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(1, 50, null) }));
    expect(await screen.findByText(/Someone just took that slot/)).toBeTruthy();
  });

  it("a partner's seat on the same court is not the member's booking", async () => {
    stubFetch([{ method: "POST", path: BOOK_POST, status: 503, body: {} }]);
    openBook({ reread: async () => day([{ isMine: true, role: "partner" } as never]) });
    await toConfirm();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(1, 50, null) }));
    expect(await screen.findByText(UNSURE_TEXT.book.checked)).toBeTruthy();
  });
});

/* ─────────────────────────────── cancel ─────────────────────────────── */

const MINE: GridBooking = {
  bookingId: "bk-1", courtId: "c1", courtName: "Court 1",
  startsAt: C1.startsAt, endsAt: "2030-09-09T16:15:00.000Z", whenLabel: "Mon 9 Sep, 18:00",
  mine: true, memberFirstName: null, memberPhotoUrl: null, checkedIn: false, amountChargedMinutes: 50, timezone: TZ,
};
const QUOTE = {
  bookingId: "bk-1", amountChargedMinutes: 50, refundMinutes: 50, penaltyMinutes: 0, penaltyPct: 30,
  penaltyWindowMinutes: 15, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false,
};

function openCancel(props: Partial<CancelSheetProps> = {}) {
  const onCancelled = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <CancelSheet open onOpenChange={onOpenChange} bookings={[MINE]} isAdmin={false} onCancelled={onCancelled} {...props} />,
    { wrapper: Providers, reactStrictMode: true },
  );
  return { onCancelled, onOpenChange };
}

describe("F1.1/F1.2 — a cancel that failed says so in its own words", () => {
  it("a 500 without a look never borrows the booking's 'Nothing was booked'", async () => {
    stubFetch([
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: QUOTE },
      { method: "POST", path: "/api/v1/bookings/bk-1/cancel", status: 500, body: {} },
    ]);
    openCancel();
    await screen.findByText(CANCEL_SHEET.free(null));
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    const alert = await screen.findByText(/may or may not have been cancelled/);
    expect(alert.textContent).not.toMatch(/booked/i);
  });

  it("a lost reply on a cancel the club made is a cancel — toast, closed, wallet re-read", async () => {
    stubFetch([
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: QUOTE },
      { method: "POST", path: "/api/v1/bookings/bk-1/cancel", status: 504, body: {} },
    ]);
    const { onCancelled, onOpenChange } = openCancel({ reread: async () => day([]) });
    await screen.findByText(CANCEL_SHEET.free(null));
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    expect(await screen.findByText(cancellationOutcome(null, null, null))).toBeTruthy();
    expect(onCancelled).toHaveBeenCalledWith({ cancelledIds: ["bk-1"], ownMoneyMoved: true });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a lost reply with the booking still there says nothing was cancelled", async () => {
    stubFetch([
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: QUOTE },
      { method: "POST", path: "/api/v1/bookings/bk-1/cancel", status: 503, body: {} },
    ]);
    const { onCancelled } = openCancel({ reread: async () => day([{ isMine: true, bookingId: "bk-1" }]) });
    await screen.findByText(CANCEL_SHEET.free(null));
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    expect(await screen.findByText(UNSURE_TEXT.cancel.checked)).toBeTruthy();
    expect(onCancelled).not.toHaveBeenCalled();
  });
});

/* ─────────────────────────────── the figures ─────────────────────────────── */

describe("F1.3 — Confirm and Done say the same figure", () => {
  it("with minutes held for partners, Done reads what is left to SPEND, as Confirm did", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: { tenant_slug: "crusaders", tenant_id: "t", user_id: ME, is_authenticated: true, is_admin: false } },
      {
        path: "/api/v1/wallet",
        body: { balance_minutes: 350, held_minutes: 50, spendable_minutes: 300, held_until: "2030-09-10T18:00:00Z", entries: [], total_entries: 0, offset: 0, limit: 100 },
      },
      { method: "POST", path: BOOK_POST, body: { booking_id: "bk-9", balance_after_minutes: 300 } },
    ]);
    signIn({ isAdmin: false });
    openBook({ balanceMinutes: 350 });
    await toConfirm();
    await waitFor(() => expect(document.querySelector("dl")).toHaveTextContent(`${BOOK_SHEET.availableAfter}4 h 10 min`));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(1, 50, null) }));
    // The server answers the RAW balance (300); what the member may spend is 250 — the Confirm figure.
    expect(await screen.findByText(BOOK_SHEET.availableLine(250, null))).toBeTruthy();
    expect(screen.queryByText(BOOK_SHEET.balanceLine(300, null))).toBeNull();
  });
});

describe("F1.4 — the desk's quote reads the member's spendable minutes", () => {
  it("rows and the god-mode notice agree when minutes are held", async () => {
    stubFetch([{
      path: "/api/v1/admin/bookings/quote",
      body: {
        user_id: NALEDI, court_id: "c1", court_name: "Court 1", starts_at: C1.startsAt, ends_at: null, slices: 1,
        price_minutes: 50, balance_minutes: 85, balance_after_minutes: 35, spendable_minutes: -40, held_minutes: 125,
        owed_back_minutes: 0, overdraws: true,
      },
    }]);
    openBook({ isAdmin: true, members: [{ id: NALEDI, name: "Naledi Khumalo", balance: 85 }], bookAsUserId: NALEDI });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    const notice = await waitFor(() => {
      const el = document.querySelector("[data-god-mode]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(notice).toHaveTextContent(GOD_MODE.body("Naledi Khumalo", -90));
    const money = document.querySelector("dl")!;
    expect(money).toHaveTextContent(`${BOOK_SHEET.theirAvailableNow("Naledi Khumalo")}−40 min`);
    expect(money).toHaveTextContent(`${BOOK_SHEET.theirBalanceAfter}−1 h 30 min`);
    expect(money).not.toHaveTextContent("35 minutes");
  });
});

describe("F1.5 — a group-window refusal names the rule, the day and who may change it", () => {
  it("for the desk booking on behalf: the member's group, the day, and no override", () => {
    const e = new ApiError(409, { error: "no_bookable_window", groups: ["Juniors", "Seniors"], day: "Thursday" });
    const text = describeBookingError(e, "x", { forName: "Naledi" });
    expect(text).toContain("Naledi's groups (Juniors and Seniors)");
    expect(text).toContain("on Thursday");
    expect(text).toContain("an admin can't override");
    expect(text).not.toBe(BOOK_SHEET.fallback);
  });

  it("the contract's single `group_name` field is read too, and a group_window names its hours", () => {
    const e = new ApiError(409, { error: "group_window", group_name: "Juniors", day: "Thursday", allowed_windows: [{ start: "09:00", end: "16:00" }] });
    expect(describeBookingError(e, "x")).toBe(
      "That time is outside your group (Juniors) booking times. You can book 09:00–16:00 on Thursday. Speak to the club if that's wrong.",
    );
  });

  it("shows on the desk's sheet when the quote itself is refused", async () => {
    stubFetch([{ path: "/api/v1/admin/bookings/quote", body: refuse(409, { error: "no_bookable_window", groups: ["Juniors"], day: "Thursday" }) }]);
    openBook({ isAdmin: true, members: [{ id: NALEDI, name: "Naledi Khumalo", balance: 85 }], bookAsUserId: NALEDI });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    expect(await screen.findByText(/Naledi's group \(Juniors\) can't book at all on Thursday/)).toBeTruthy();
    expect(screen.queryByText(BOOK_SHEET.fallback)).toBeNull();
  });
});

describe("R2 F1-4 — a window refusal says the day in words and offers no retry that cannot work", () => {
  it("reads the server's own day key ('wed') as a weekday", () => {
    // BookingRules.DayName sends OperatingHours' keys — "mon"…"sun" — never a word.
    const e = new ApiError(409, { error: "group_window", groups: ["Juniors"], day: "wed", allowed_windows: [{ start: "09:00", end: "16:00" }] });
    const text = describeBookingError(e, "x", { forName: "Naledi" });
    expect(text).toContain("on Wednesday");
    expect(text).not.toMatch(/on wed\b/);
    const none = new ApiError(409, { error: "no_bookable_window", groups: ["Juniors"], day: "sun" });
    expect(describeBookingError(none, "x")).toContain("at all on Sunday");
  });

  it("offers no Try again on the desk's refused quote — asking again gets the same refusal", async () => {
    stubFetch([{ path: "/api/v1/admin/bookings/quote", body: refuse(409, { error: "group_window", groups: ["Juniors"], day: "wed", allowed_windows: [{ start: "09:00", end: "16:00" }] }) }]);
    openBook({ isAdmin: true, members: [{ id: NALEDI, name: "Naledi Khumalo", balance: 85 }], bookAsUserId: NALEDI });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    expect(await screen.findByText(/can book 09:00–16:00 on Wednesday/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: BOOK_SHEET.retry })).toBeNull();
  });

  it("still offers Try again when the quote could not be read at all", async () => {
    stubFetch([{ path: "/api/v1/admin/bookings/quote", status: 503, body: { error: "unavailable" } }]);
    openBook({ isAdmin: true, members: [{ id: NALEDI, name: "Naledi Khumalo", balance: 85 }], bookAsUserId: NALEDI });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    expect(await screen.findByRole("button", { name: BOOK_SHEET.retry })).toBeTruthy();
  });
});

describe("F1.10 — Confirm states the cancellation terms before anything is charged", () => {
  it("says the window, the penalty and the lights-on rule", async () => {
    stubFetch([]);
    openBook({ cancelTerms: { penaltyPct: 30, windowMinutes: 15 } });
    await toConfirm();
    expect(screen.getByText(cancelTermsLine(30, 15))).toBeTruthy();
    expect(cancelTermsLine(30, 15)).toBe(
      "Cancel more than 15 minutes before the start and the full amount comes back; inside 15 minutes, 30% is kept. Once the lights have been on, nothing comes back.",
    );
  });

  it("a club without a penalty says the plain rule", () => {
    expect(cancelTermsLine(0, 15)).toContain("full amount comes back");
  });
});

describe("F1.13 — a split booking's cancel says who gets what back", () => {
  const split = { ...QUOTE, amountChargedMinutes: 100, refundMinutes: 100, net_minutes: 50, partner_refunds: [{ name: "Sam", minutes: 50 }] };

  it("names each partner's share and what the organiser keeps — the quote's camelCase or snake_case", async () => {
    stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: split }]);
    openCancel();
    await screen.findByText(CANCEL_SHEET.free(null, ["Sam"]));
    const money = document.querySelector("dl")!;
    expect(money).toHaveTextContent(`${SPLIT_CANCEL.partnerBack("Sam")}50 min`);
    expect(money).toHaveTextContent(`${SPLIT_CANCEL.youKeep}50 min`);
    expect(money).not.toHaveTextContent(`${CANCEL_SHEET.goesBack(null)}1 h 40 min`);
    expect(screen.getByText(SPLIT_CANCEL.note(null, ["Sam"]))).toBeTruthy();
  });

  it("the toast after it says the same", async () => {
    stubFetch([
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: { ...QUOTE, netMinutes: 50, partnerRefunds: [{ name: "Sam", minutes: 50 }] } },
      { method: "POST", path: "/api/v1/bookings/bk-1/cancel", body: { refunded_minutes: 100, penalty_minutes: 0, net_minutes: 50, partner_refunds: [{ name: "Sam", minutes: 50 }] } },
    ]);
    openCancel();
    await screen.findByText(`${SPLIT_CANCEL.youKeep}`);
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    expect(await screen.findByText("Booking cancelled. 50 minutes back to your balance; 50 minutes to Sam.")).toBeTruthy();
  });

  it("a booking without players is unchanged", async () => {
    stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: QUOTE }]);
    openCancel();
    await screen.findByText(CANCEL_SHEET.free(null));
    expect(document.querySelector("dl")).toHaveTextContent(`${CANCEL_SHEET.goesBack(null)}50 min`);
  });
});

describe("F1.13 — the desk cancelling a split booking says the truth even when its route does not", () => {
  const ADM: GridBooking = { ...MINE, mine: false, memberFirstName: "Adm", amountChargedMinutes: 250 };
  const splitQuote = {
    ...QUOTE, amountChargedMinutes: 250, refundMinutes: 250, net_minutes: 125, partner_refunds: [{ name: "Sam", minutes: 125 }],
  };

  it("never '4 h 10 min back to Adm' when 125 of it went to the partner", async () => {
    stubFetch([
      { path: "/api/v1/bookings/bk-1/cancellation-quote", body: splitQuote },
      // The desk's route answers the gross figures only.
      { method: "POST", path: "/api/v1/admin/bookings/bk-1/cancel", body: { refunded_minutes: 250, penalty_minutes: 0 } },
    ]);
    openCancel({ bookings: [ADM], isAdmin: true });
    await screen.findByText(CANCEL_SHEET.free("Adm", ["Sam"]));
    const money = document.querySelector("dl")!;
    expect(money).toHaveTextContent(`${SPLIT_CANCEL.partnerBack("Sam")}2 h 5 min`);
    expect(money).toHaveTextContent(`${CANCEL_SHEET.goesBack("Adm")}2 h 5 min`);
    // R13 J13-5 — the note under the figures is about Adm's money, said in the third person.
    expect(screen.getByText(SPLIT_CANCEL.note("Adm", ["Sam"]))).toBeTruthy();
    expect(SPLIT_CANCEL.note("Adm", ["Sam"])).toBe("Sam gets their share back from what comes back to Adm.");
    expect(screen.queryByText(/comes back to you/)).toBeNull();
    // R4 A4-4: a desk cancel of somebody else's booking always carries a reason.
    fireEvent.change(screen.getByLabelText(CANCEL_SHEET.reasonLabel), { target: { value: "Court closed" } });
    fireEvent.click(screen.getByRole("button", { name: CANCEL_SHEET.confirm(1) }));
    expect(await screen.findByText("Booking cancelled. 2 hours 5 minutes back to Adm's balance; 2 hours 5 minutes to Sam.")).toBeTruthy();
    expect(screen.queryByText(/4 hours 10 minutes back to Adm/)).toBeNull();
  });
});

describe("R14 J14-6 / J14-7 — a free cancel of a split booking says who gets what, one partner singular", () => {
  const one = { ...QUOTE, amountChargedMinutes: 100, refundMinutes: 100, net_minutes: 50, partner_refunds: [{ name: "Sam", minutes: 50 }] };
  const two = { ...QUOTE, amountChargedMinutes: 90, refundMinutes: 90, net_minutes: 30, partner_refunds: [{ name: "Sam", minutes: 30 }, { name: "Nomsa", minutes: 30 }] };

  it("one partner: never 'every minute goes back to your balance', never 'Partners … their shares'", async () => {
    stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: one }]);
    openCancel();
    expect(await screen.findByText("Cancelling now is free — nothing is kept: Sam gets their share back, and the rest goes back to your balance.")).toBeTruthy();
    expect(screen.getByText("Sam gets their share back from what comes back to you.")).toBeTruthy();
    expect(screen.queryByText(/every minute goes back/)).toBeNull();
    expect(screen.queryByText(/Partners get/)).toBeNull();
  });

  it("two partners: both named, plural", async () => {
    stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: two }]);
    openCancel();
    expect(await screen.findByText("Cancelling now is free — nothing is kept: Sam and Nomsa get their shares back, and the rest goes back to your balance.")).toBeTruthy();
    expect(screen.getByText("Sam and Nomsa get their shares back from what comes back to you.")).toBeTruthy();
  });

  it("the desk's sheet says it of the member: 'the rest goes back to Adm's balance'", async () => {
    const ADM: GridBooking = { ...MINE, mine: false, memberFirstName: "Adm", amountChargedMinutes: 100 };
    stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: one }]);
    openCancel({ bookings: [ADM], isAdmin: true });
    expect(await screen.findByText("Cancelling now is free — nothing is kept: Sam gets their share back, and the rest goes back to Adm's balance.")).toBeTruthy();
    expect(screen.getByText("Sam gets their share back from what comes back to Adm.")).toBeTruthy();
  });

  it("a booking without players keeps the plain sentence", async () => {
    stubFetch([{ path: "/api/v1/bookings/bk-1/cancellation-quote", body: QUOTE }]);
    openCancel();
    expect(await screen.findByText("Cancelling now is free — every minute goes back to your balance.")).toBeTruthy();
  });
});
