import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { refuse, stubFetch, type StubCall } from "@/test/harness";
import { BOOK_SHEET, GOD_MODE, REFUSAL_REASON, RESULTS_LABEL } from "@/lib/bookingsCopy";
import { BookSheet, type BookSheetProps } from "../BookSheet";
import { slotCount } from "../bookFlow";
import type { SelectedSlot } from "../types";

/**
 * BookSheet (P4: R7, R19, D8). Queries go through `lib/bookingsCopy` so a wording change is one
 * edit. Every render is in StrictMode, where a mount → unmount → mount would double a quote read
 * or a booking POST if the sheet were careless about either.
 */

const strict = { reactStrictMode: true };
const TZ = "Africa/Johannesburg";
const ME = "44444444-4444-4444-4444-444444444444";
const NALEDI = "bbbbbbbb-0000-4000-8000-00000000000b";

const C1: SelectedSlot = { courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00.000Z", sliceCount: 3, priceCredits: 50 };
const C2: SelectedSlot = { courtId: "c2", courtName: "Court 2", startsAt: "2030-09-09T17:00:00.000Z", sliceCount: 1, priceCredits: 20 };
/**
 * The sheet counts in GRID slots, the unit the action bar ticked (C1 is a 45-minute run = 3 slots):
 * a bar reading "3 slots" over a sheet titled "Book 2 slots" read as a slot lost (P3/P4 integration).
 */
const S1 = slotCount([C1]);
const S12 = slotCount([C1, C2]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Providers({ children }: { children: ReactNode }) {
  return <MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter>;
}

function open(props: Partial<BookSheetProps> = {}) {
  const onOpenChange = vi.fn();
  const onBooked = vi.fn();
  const onStale = vi.fn();
  render(
    <BookSheet
      open
      onOpenChange={onOpenChange}
      slots={[C1]}
      timezone={TZ}
      sliceMinutes={15}
      isAdmin={false}
      actorUserId={ME}
      balanceCredits={500}
      onBooked={onBooked}
      onStale={onStale}
      {...props}
    />,
    { wrapper: Providers, ...strict },
  );
  return { onOpenChange, onBooked, onStale, dialog: () => screen.getByRole("dialog") };
}

const posts = (calls: StubCall[], path: string) => calls.filter((c) => c.method === "POST" && c.path.startsWith(path));
const gets = (calls: StubCall[], path: string) => calls.filter((c) => c.method === "GET" && c.path.startsWith(path));

describe("BookSheet — a member, one slot", () => {
  it("states the slot, its length and the money, with a close × and an outcome-named book", () => {
    stubFetch([]);
    const { dialog } = open();
    const d = dialog();
    expect(within(d).getByRole("heading", { name: BOOK_SHEET.title(S1) })).toBeTruthy();
    // No stepper for a one-step sheet — a progress bar at 100% is decoration.
    expect(within(d).queryByRole("list", { name: "Progress" })).toBeNull();
    const slots = within(d).getByRole("list", { name: BOOK_SHEET.slotsLabel });
    expect(slots).toHaveTextContent("Court 1");
    expect(slots).toHaveTextContent("Mon 9 Sep · 18:00–18:45");
    expect(slots).toHaveTextContent("45 min");
    const money = d.querySelector("dl")!;
    expect(money).toHaveTextContent(`${BOOK_SHEET.total}50.00 cr`);
    expect(money).toHaveTextContent(`${BOOK_SHEET.balanceNow}500.00 cr`);
    expect(money).toHaveTextContent(`${BOOK_SHEET.balanceAfter}450.00 cr`);
    expect(within(d).getByRole("button", { name: "Close" })).toBeTruthy();
    expect(within(d).getByRole("button", { name: BOOK_SHEET.cancel })).toBeTruthy();
    expect(within(d).getByRole("button", { name: BOOK_SHEET.primary(S1, 50, null) })).toBeTruthy();
    // Banned dialog copy (design-system.md, Patterns → Dialog copy).
    expect(within(d).queryByText(/Keep looking|^OK$/)).toBeNull();
  });

  it("books once on a double tap, then shows the tick and the row, and hands back the balance", async () => {
    const stub = stubFetch([
      { method: "POST", path: "/api/v1/bookings/", body: { booking_id: "bk-1", balance_after_credits: 450 } },
    ]);
    const { onBooked } = open();
    const book = screen.getByRole("button", { name: BOOK_SHEET.primary(S1, 50, null) });
    fireEvent.click(book);
    fireEvent.click(book);
    expect(await screen.findByText(BOOK_SHEET.bookedTitle(S1, S1))).toBeTruthy();
    expect(posts(stub.calls, "/api/v1/bookings/")).toHaveLength(1);
    expect(posts(stub.calls, "/api/v1/bookings/")[0].body).toEqual({ courtId: "c1", startsAt: C1.startsAt, sliceCount: 3 });
    expect(document.querySelector('[data-glyph="check"]')).not.toBeNull();
    expect(screen.getByRole("list", { name: RESULTS_LABEL.book })).toHaveTextContent("Court 1");
    expect(screen.getByText(BOOK_SHEET.balanceLine(450, null))).toBeTruthy();
    expect(onBooked).toHaveBeenCalledWith({ booked: [C1], ownBalanceAfter: 450, forMemberId: null, hold: false });
    expect(screen.getByRole("button", { name: BOOK_SHEET.done })).toBeTruthy();
  });

  it("shows the spinner in the button while it books — never a frozen, disabled one", async () => {
    let release: (v: unknown) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { release = resolve; })));
    open();
    const book = screen.getByRole("button", { name: BOOK_SHEET.primary(S1, 50, null) });
    fireEvent.click(book);
    await waitFor(() => expect(book).toHaveAttribute("aria-busy", "true"));
    expect(book).not.toBeDisabled();
    expect(book).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      release({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve('{"booking_id":"b","balance_after_credits":1}') });
    });
  });

  it("keeps a refusal in the sheet, in words, and tells the page its grid is stale", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/bookings/", status: 409, body: { error: "slot_taken" } }]);
    const { onStale, onBooked } = open();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(S1, 50, null) }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Someone just took that slot/);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onBooked).not.toHaveBeenCalled();
    // Still on the confirm, ready to be dismissed or tried again.
    expect(screen.getByRole("button", { name: BOOK_SHEET.primary(S1, 50, null) })).toBeTruthy();
  });

  it("tells a short member what they need, never a red negative balance — members never overdraw", () => {
    const stub = stubFetch([]);
    const { dialog } = open({ balanceCredits: 20 });
    const d = dialog();
    // P4 walk: "Balance after −30.00 cr" in red, a figure a member's wallet can never reach.
    const money = d.querySelector("dl")!;
    expect(money).not.toHaveTextContent(BOOK_SHEET.balanceAfter);
    expect(money).not.toHaveTextContent("−");
    expect(money).toHaveTextContent(`${BOOK_SHEET.stillNeeded}30.00 cr`);
    expect(money.querySelector(".text-danger-strong")).toBeNull();
    expect(within(d).getByText(BOOK_SHEET.needMore(30))).toBeTruthy();
    // The way out is navigation, so a link in a button's clothes.
    const topUp = within(d).getByRole("link", { name: BOOK_SHEET.topUp });
    expect(topUp).toHaveAttribute("href", "/wallet/topup");
    expect(topUp).toHaveAttribute("data-slot", "button");
    // The Book button is still there, unavailable, and says why.
    const book = within(d).getByRole("button", { name: BOOK_SHEET.primary(S1, 50, null) });
    expect(book).toHaveAttribute("aria-disabled", "true");
    expect(book).not.toBeDisabled();
    expect(book).toHaveAccessibleDescription(new RegExp(BOOK_SHEET.needMore(30)));
    fireEvent.click(book);
    expect(stub.calls).toHaveLength(0);
  });

  it("keeps the ordinary Balance after for a member who can afford it", () => {
    stubFetch([]);
    const { dialog } = open({ balanceCredits: 50 });
    const money = dialog().querySelector("dl")!;
    expect(money).toHaveTextContent(`${BOOK_SHEET.balanceAfter}0.00 cr`);
    expect(screen.queryByText(BOOK_SHEET.needMore(0))).toBeNull();
    expect(screen.getByRole("button", { name: BOOK_SHEET.primary(S1, 50, null) })).not.toHaveAttribute("aria-disabled");
  });
});

describe("BookSheet — a member, several slots (D8)", () => {
  const bulkAnswer = (overrides: Record<string, unknown> = {}) => ({
    requested: 2, booked: 1, refused: 1, total_charged_credits: 50, charged_now_credits: 50,
    balance_before_credits: 500, balance_after_credits: 450, halted_at: null, halted_reason: null,
    results: [
      { index: 0, court_id: "c1", court_name: "Court 1", starts_at: C1.startsAt, ends_at: null, status: "booked", reason: null, booking_id: "b1", amount_credits: 50, replayed: false },
      { index: 1, court_id: "c2", court_name: "Court 2", starts_at: C2.startsAt, ends_at: null, status: "refused", reason: "slot_taken", booking_id: null, amount_credits: null, replayed: false },
    ],
    ...overrides,
  });

  it("sends one bulk request with a fresh key and reads back a row per item", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/bookings/bulk", body: bulkAnswer() }]);
    const { onBooked } = open({ slots: [C1, C2] });
    expect(screen.getByRole("heading", { name: BOOK_SHEET.title(S12) })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(S12, 70, null) }));
    expect(await screen.findByText(BOOK_SHEET.bookedTitle(S1, S12))).toBeTruthy();
    const [call] = posts(stub.calls, "/api/v1/bookings/bulk");
    const body = call.body as { idempotencyKey: string; items: unknown[] };
    expect(body.idempotencyKey).toMatch(/^mb_/);
    expect(body.items).toEqual([
      { courtId: "c1", startsAt: C1.startsAt, sliceCount: 3 },
      { courtId: "c2", startsAt: C2.startsAt, sliceCount: 1 },
    ]);
    const results = screen.getByRole("list", { name: RESULTS_LABEL.book });
    expect(results).toHaveTextContent(REFUSAL_REASON.slot_taken);
    expect(onBooked).toHaveBeenCalledWith(expect.objectContaining({ booked: [C1], ownBalanceAfter: 450 }));
  });

  it("offers Top up and a retry under the SAME key when the credit runs out part-way", async () => {
    const halted = bulkAnswer({
      halted_at: 1, halted_reason: "insufficient_balance",
      results: [
        bulkAnswer().results[0],
        { ...bulkAnswer().results[1], reason: "not_attempted" },
      ],
    });
    let served = 0;
    const answers = [halted, bulkAnswer({ booked: 2, refused: 0 })];
    const stub = stubFetch([{ method: "POST", path: "/api/v1/bookings/bulk", respond: () => answers[Math.min(served++, 1)] }]);
    open({ slots: [C1, C2] });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(S12, 70, null) }));
    expect(await screen.findByText(BOOK_SHEET.haltedShort)).toBeTruthy();
    expect(screen.getByRole("link", { name: BOOK_SHEET.topUp })).toHaveAttribute("href", "/wallet/topup");
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.retry }));
    await waitFor(() => expect(posts(stub.calls, "/api/v1/bookings/bulk")).toHaveLength(2));
    const [first, second] = posts(stub.calls, "/api/v1/bookings/bulk").map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(second).toBe(first);
  });
});

describe("BookSheet — an admin (R19 god mode)", () => {
  const quote = (overrides: Record<string, unknown> = {}) => ({
    user_id: NALEDI, court_id: "c1", court_name: "Court 1", starts_at: C1.startsAt, ends_at: null,
    slices: 3, price_credits: 60, balance_credits: 44, balance_after_credits: -16, overdraws: true, ...overrides,
  });
  const members = [{ id: NALEDI, name: "Naledi Khumalo", balance: 44 }, { id: ME, name: "Desk Admin", balance: 0 }];

  it("is a stepper: Slots with Book as, then Confirm — Cancel first, Back after", () => {
    stubFetch([]);
    open({ isAdmin: true, members });
    expect(screen.getByRole("list", { name: "Progress" })).toHaveTextContent(BOOK_SHEET.stepOf(1, 2, BOOK_SHEET.steps.slots));
    const group = screen.getByRole("radiogroup", { name: BOOK_SHEET.bookAs });
    expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(screen.getByRole("button", { name: BOOK_SHEET.cancel })).toBeTruthy();
  });

  it("says who is missing on Continue rather than greying the button out", () => {
    stubFetch([]);
    open({ isAdmin: true, members });
    fireEvent.click(screen.getByRole("radio", { name: BOOK_SHEET.asMember }));
    const next = screen.getByRole("button", { name: BOOK_SHEET.next });
    expect(next).not.toBeDisabled();
    fireEvent.click(next);
    expect(screen.getByText(BOOK_SHEET.memberMissing)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Progress" })).toHaveTextContent(BOOK_SHEET.stepOf(1, 2, BOOK_SHEET.steps.slots));
  });

  it("quotes first, shows where it leaves the member, and sends the override once — no 402 dance", async () => {
    const stub = stubFetch([
      { path: "/api/v1/admin/bookings/quote", body: quote() },
      { method: "POST", path: "/api/v1/admin/bookings/", body: { booking_id: "bk-9", balance_after_credits: -16 } },
    ]);
    const { onBooked } = open({ isAdmin: true, members, bookAsUserId: NALEDI });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    expect(await screen.findByText(GOD_MODE.body("Naledi Khumalo", -16))).toBeTruthy();
    expect(GOD_MODE.body("Naledi Khumalo", -16)).toBe("This takes Naledi Khumalo to −16.00 cr. It's recorded in the change record.");
    const [q] = gets(stub.calls, "/api/v1/admin/bookings/quote");
    expect(q.path).toContain(`userId=${NALEDI}`);
    expect(q.path).toContain("slices=3");
    expect(screen.getByRole("button", { name: BOOK_SHEET.back })).toBeTruthy();

    // A double tap on Continue must not land its second half on the Book button.
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(S1, 60, "Naledi") }));
    await screen.findByText(BOOK_SHEET.bookedTitle(S1, S1));
    const sent = posts(stub.calls, "/api/v1/admin/bookings/");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ courtId: "c1", userId: NALEDI, startsAt: C1.startsAt, sliceCount: 3, allowNegativeBalance: true });
    expect(screen.getByText(BOOK_SHEET.balanceLine(-16, "Naledi Khumalo"))).toBeTruthy();
    // The member's wallet is not the admin's: nothing for the admin's own chip.
    expect(onBooked).toHaveBeenCalledWith(expect.objectContaining({ ownBalanceAfter: null, forMemberId: NALEDI }));
  });

  it("books the admin's own court on their own wallet without the flag when it does not overdraw", async () => {
    const stub = stubFetch([
      { path: "/api/v1/admin/bookings/quote", body: quote({ user_id: ME, balance_credits: 200, balance_after_credits: 140, overdraws: false }) },
      { method: "POST", path: "/api/v1/admin/bookings/", body: { booking_id: "bk-9", balance_after_credits: 140 } },
    ]);
    open({ isAdmin: true, members });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    const book = await screen.findByRole("button", { name: BOOK_SHEET.primary(S1, 60, null) });
    expect(screen.queryByText(GOD_MODE.title)).toBeNull();
    expect(gets(stub.calls, "/api/v1/admin/bookings/quote")[0].path).not.toContain("userId=");
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(book);
    await screen.findByText(BOOK_SHEET.bookedTitle(S1, S1));
    expect(posts(stub.calls, "/api/v1/admin/bookings/")[0].body).toMatchObject({ userId: ME, allowNegativeBalance: false });
  });

  it("marks a slot the bulk quote refuses, and books only the rest", async () => {
    const stub = stubFetch([
      {
        method: "POST", path: "/api/v1/admin/bookings/bulk/quote",
        body: {
          user_id: NALEDI, total_credits: 60, balance_credits: 100, balance_after_credits: 40, overdraws: false,
          items: [
            { index: 0, court_id: "c1", court_name: "Court 1", starts_at: C1.startsAt, slices: 3, price_credits: 60, bookable: true, reason: null },
            { index: 1, court_id: "c2", court_name: "Court 2", starts_at: C2.startsAt, slices: 1, price_credits: 0, bookable: false, reason: "slot_taken" },
          ],
        },
      },
      // One slot left to send, so it goes by the single route with the same god-mode rule.
      { method: "POST", path: "/api/v1/admin/bookings/", body: { booking_id: "b1", balance_after_credits: 40 } },
    ]);
    open({ isAdmin: true, members, bookAsUserId: NALEDI, slots: [C1, C2] });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    expect(await screen.findByText(BOOK_SHEET.someNotBookable(1))).toBeTruthy();
    expect(screen.getByRole("list", { name: BOOK_SHEET.slotsLabel })).toHaveTextContent(REFUSAL_REASON.slot_taken);
    const quoted = posts(stub.calls, "/api/v1/admin/bookings/bulk/quote")[0].body as { user_id: string; items: unknown[] };
    expect(quoted.user_id).toBe(NALEDI);
    expect(quoted.items).toEqual([
      { court_id: "c1", starts_at: C1.startsAt, slices: 3 },
      { court_id: "c2", starts_at: C2.startsAt, slices: 1 },
    ]);
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(S1, 60, "Naledi") }));
    await screen.findByText(BOOK_SHEET.bookedTitle(S1, S1));
    const sent = stub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/admin/bookings/");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ courtId: "c1", userId: NALEDI, startsAt: C1.startsAt, sliceCount: 3, allowNegativeBalance: false });
  });

  it("books a batch for a member by the bulk route, and books the rest anyway under the same key", async () => {
    const bulkQuote = {
      user_id: NALEDI, total_credits: 80, balance_credits: 100, balance_after_credits: 20, overdraws: false,
      items: [
        { index: 0, court_id: "c1", court_name: "Court 1", starts_at: C1.startsAt, slices: 3, price_credits: 60, bookable: true, reason: null },
        { index: 1, court_id: "c2", court_name: "Court 2", starts_at: C2.startsAt, slices: 1, price_credits: 20, bookable: true, reason: null },
      ],
    };
    const halted = {
      halted_at: 1, halted_reason: "insufficient_balance", payer: { name: "Naledi Khumalo", balance_after_credits: 5 },
      results: [
        { index: 0, status: "booked", booking_id: "b1", amount_credits: 60 },
        { index: 1, status: "failed", error: "insufficient_balance" },
      ],
    };
    const finished = { ...halted, halted_at: null, halted_reason: null, results: [halted.results[0], { index: 1, status: "booked", booking_id: "b2", amount_credits: 20 }] };
    let served = 0;
    const stub = stubFetch([
      { method: "POST", path: "/api/v1/admin/bookings/bulk/quote", body: bulkQuote },
      { method: "POST", path: "/api/v1/admin/bookings/bulk", respond: () => (served++ === 0 ? halted : finished) },
    ]);
    open({ isAdmin: true, members, bookAsUserId: NALEDI, slots: [C1, C2] });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    const book = await screen.findByRole("button", { name: BOOK_SHEET.primary(S12, 80, "Naledi") });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(book);
    expect(await screen.findByText(BOOK_SHEET.haltedShortAdmin("Naledi Khumalo"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.bookRestAnyway }));
    expect(await screen.findByText(BOOK_SHEET.bookedTitle(S12, S12))).toBeTruthy();
    const sent = stub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/admin/bookings/bulk").map((c) => c.body as Record<string, unknown>);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ onBehalf: { userId: NALEDI }, allowNegativeBalance: false });
    expect(String(sent[0].idempotencyKey)).toMatch(/^ab_/);
    expect(sent[1]).toMatchObject({ allowNegativeBalance: true, idempotencyKey: sent[0].idempotencyKey });
  });

  it("shows a quote refusal in words with a retry, and offers no book button", async () => {
    stubFetch([{ path: "/api/v1/admin/bookings/quote", body: refuse(409, { error: "slot_taken" }) }]);
    open({ isAdmin: true, members });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Someone just took that slot/);
    expect(screen.getByRole("button", { name: BOOK_SHEET.retry })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Book/ })).toBeNull();
  });

  it("holds a court for nobody's money, with the name the grid shows", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/admin/blocks/", body: { booking_id: "blk-1" } }]);
    open({ isAdmin: true, members });
    fireEvent.click(screen.getByRole("radio", { name: BOOK_SHEET.asHold }));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    expect(screen.getByText(BOOK_SHEET.holdMissing)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(BOOK_SHEET.holdLabel), { target: { value: "League night" } });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    expect(screen.getByRole("heading", { name: BOOK_SHEET.holdTitle(S1) })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.holdPrimary(S1) }));
    await screen.findByText(BOOK_SHEET.heldTitle(S1, S1));
    expect(stub.calls.filter((c) => c.path.includes("quote"))).toHaveLength(0);
    expect(posts(stub.calls, "/api/v1/admin/blocks/")[0].body).toEqual({ courtId: "c1", startsAt: C1.startsAt, sliceCount: 3, label: "League night" });
  });

  it("goes Back to Slots with the choice kept", async () => {
    stubFetch([{ path: "/api/v1/admin/bookings/quote", body: quote() }]);
    open({ isAdmin: true, members, bookAsUserId: NALEDI });
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    await screen.findByText(GOD_MODE.title);
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.back }));
    expect(screen.getByRole("radio", { name: BOOK_SHEET.asMember })).toHaveAttribute("aria-checked", "true");
  });
});
