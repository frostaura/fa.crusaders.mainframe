import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import SchedulePage from "./Schedule";
import { forgetClubZone } from "../lib/clubZone";
import { renderPage, signIn, signOut, stubFetch, type FetchStub, type StubRoute } from "../test/harness";

/**
 * Items 5 and 13 — an admin ticking a list of cells, and the list of outcomes they get back.
 *
 * <p>
 * <b>Partial failure is data, not a status code.</b> D2 §5.1: each booking is its own money
 * movement behind its own payer lock, a slot collision in a twenty-slot league book-out is
 * normal traffic, and the honest answer to a list of checkboxes is a list of outcomes. So both
 * routes answer 200 with a per-item array, and the console renders that array rather than a
 * spinner that ends in a toast — four seconds of `role="status"` cannot say "11 cancelled, 1
 * was already gone" and stay readable, and the toast viewport deliberately carries no live
 * region of its own.
 * </p>
 *
 * <p>
 * <b>There is no Undo for a cancel.</b> D3 §4.6: the refund is already a ledger row, and
 * "undoing" it would mean re-booking at today's price into a slot somebody else may have
 * taken, posting a second pair of movements to explain. The sheet says so BEFORE the button
 * rather than offering a magic word after it.
 * </p>
 */

const COURT_A = "11111111-1111-1111-1111-111111111111";
const COURT_B = "22222222-2222-2222-2222-222222222222";
const DATE = "2030-09-09";
const sast = (hh: number, mm = 0) => new Date(Date.UTC(2030, 8, 9, hh - 2, mm, 0)).toISOString();

const BOOKED = {
  courtId: COURT_B, courtNumber: 2, startsAtUtc: sast(17), endsAtUtc: sast(17, 15),
  status: "booked", ownerUserId: "55555555-5555-5555-5555-555555555555",
  ownerFirstName: "Thandi", ownerPhotoUrl: null, isMine: false,
  bookingId: "bk-1", blockLabel: null, checkedIn: false, amountChargedCredits: 50,
};

const DAY = {
  date: DATE, timezone: "Africa/Johannesburg", sliceMinutes: 15,
  dayStartMinute: 16 * 60, dayEndMinute: 18 * 60,
  advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15,
  courts: [
    { id: COURT_A, courtNumber: 1, name: "Court 1", slicePriceCredits: 50 },
    { id: COURT_B, courtNumber: 2, name: "Court 2", slicePriceCredits: 50 },
  ],
  slots: [BOOKED],
};

const MEMBERS = [
  { user_id: "55555555-5555-5555-5555-555555555555", full_name: "Thandi Mokoena", balance_credits: 370 },
  { user_id: "44444444-4444-4444-4444-444444444444", full_name: "Review Admin", balance_credits: 0 },
];

function openAsAdmin(extra: StubRoute[] = []): FetchStub {
  const stub = stubFetch([
    { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
    { path: "/api/v1/schedule", body: DAY },
    { path: "/api/v1/admin/members/", body: MEMBERS },
    { path: "/api/v1/wallet", body: { balance_credits: 900, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    ...extra,
  ]);
  renderPage(<SchedulePage />);
  return stub;
}

/** Turn selection mode on and tick the named cells. */
async function select(names: RegExp[]) {
  const toggle = await screen.findByRole("button", { name: "Select" });
  await act(async () => { fireEvent.click(toggle); });
  for (const name of names) {
    const cell = await screen.findByRole("button", { name });
    await act(async () => { fireEvent.click(cell); });
  }
}

describe("entering and leaving selection mode", () => {
  beforeEach(() => { forgetClubZone(); signIn({ isAdmin: true }); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  it("is offered to an admin", async () => {
    openAsAdmin();
    expect(await screen.findByRole("button", { name: "Select" })).toBeInTheDocument();
  });

  it("is not offered to a member — absent, not disabled", async () => {
    signOut();
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/schedule", body: DAY },
      { path: "/api/v1/wallet", body: { balance_credits: 900, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    ]);
    renderPage(<SchedulePage />);
    await screen.findByRole("grid");
    // A control that cannot do anything is not an affordance; it is a thing to try and fail at.
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
  });

  it("makes the grid multi-selectable and marks what is chosen with a ring AND a tick", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/]);

    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-multiselectable", "true");
    const cell = within(grid).getByRole("gridcell", { name: "Court 1 at 16:00" });
    // `aria-selected` on the CELL, so selectedness is a property of the cell rather than of
    // whichever control happens to be inside it. And never colour alone.
    expect(cell).toHaveAttribute("aria-selected", "true");
    expect(cell.className).toMatch(/ring-2/);
    expect(within(cell).getByText("✓")).toBeInTheDocument();
  });

  it("toggles a cell off again rather than only ever adding", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/, /^Book Court 1 at 16:00/]);
    expect(screen.queryByRole("region", { name: "Selected slots" })).toBeNull();
  });

  it("clears the selection when the day changes, and says why", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/]);
    expect(screen.getByRole("region", { name: "Selected slots" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Schedule date"), { target: { value: "2030-09-10" } });
    });
    // A selection that survived a date change would act on slots the admin is no longer
    // looking at — which on a bulk cancel is other people's money.
    await waitFor(() => expect(screen.queryByRole("region", { name: "Selected slots" })).toBeNull());
    expect(document.body.textContent).toMatch(/Selection cleared — you changed day/);
  });
});

describe("the keyboard path — D3 §4.7", () => {
  beforeEach(() => { forgetClubZone(); signIn({ isAdmin: true }); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  it("makes the grid ONE tab stop, not two hundred and forty", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/]);

    const cells = screen.getAllByRole("gridcell");
    const stops = cells.filter((c) => c.getAttribute("tabindex") === "0");
    // Exactly one roving stop, and every control inside the cells is out of the tab order
    // while the cell itself is the stop. Found by driving it: Tab from a ticked cell landed on
    // the NEXT CELL, so reaching the action bar from the keyboard meant tabbing through every
    // remaining slot in the day.
    expect(stops).toHaveLength(1);
    const inner = screen.getAllByRole("button", { name: /^Book Court/ });
    expect(inner.every((b) => b.tabIndex === -1)).toBe(true);
  });

  it("moves the roving stop with the arrow keys, across courts and down the day", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/]);
    const grid = screen.getByRole("grid");

    await act(async () => { fireEvent.keyDown(grid, { key: "ArrowRight" }); });
    expect(screen.getByRole("gridcell", { name: "Court 2 at 16:00" }).tabIndex).toBe(0);

    await act(async () => { fireEvent.keyDown(grid, { key: "ArrowDown" }); });
    expect(screen.getByRole("gridcell", { name: "Court 2 at 16:15" }).tabIndex).toBe(0);

    await act(async () => { fireEvent.keyDown(grid, { key: "Home" }); });
    expect(screen.getByRole("gridcell", { name: "Court 1 at 16:15" }).tabIndex).toBe(0);
  });

  it("will not walk off the edges of the grid", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/]);
    const grid = screen.getByRole("grid");
    await act(async () => { fireEvent.keyDown(grid, { key: "ArrowUp" }); });
    await act(async () => { fireEvent.keyDown(grid, { key: "ArrowLeft" }); });
    expect(screen.getByRole("gridcell", { name: "Court 1 at 16:00" }).tabIndex).toBe(0);
  });

  it("drops the choices on the first Escape and the mode on the second", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/, /^Book Court 1 at 16:15/]);
    const grid = screen.getByRole("grid");

    await act(async () => { fireEvent.keyDown(grid, { key: "Escape" }); });
    // An admin who has ticked twelve cells by mistake should not also lose the mode they were
    // working in — so the choices go first and the mode stays.
    await waitFor(() => expect(screen.queryByRole("region", { name: "Selected slots" })).toBeNull());
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();

    await act(async () => { fireEvent.keyDown(grid, { key: "Escape" }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument());
  });
});

describe("the selection bar", () => {
  beforeEach(() => { forgetClubZone(); signIn({ isAdmin: true }); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  it("counts free and booked apart, and offers the action each of them has", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/, /^Book Court 1 at 16:15/, /Thandi — cancel on their behalf/]);

    const bar = screen.getByRole("region", { name: "Selected slots" });
    expect(within(bar).getByText("2 free · 1 booked")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Book 2 slots" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Cancel 1 booking" })).toBeInTheDocument();
  });

  it("names the span so the admin can check it without scrolling", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/, /^Book Court 1 at 17:45/]);
    expect(within(screen.getByRole("region", { name: "Selected slots" }))
      .getByText(/Court 1 · Monday · 16:00–17:45/)).toBeInTheDocument();
  });

  it("is singular for one thing, because a desk reads what it says", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/]);
    expect(screen.getByRole("button", { name: "Book 1 slot" })).toBeInTheDocument();
  });
});

describe("cancelling many — item 5", () => {
  beforeEach(() => { forgetClubZone(); signIn({ isAdmin: true }); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  const QUOTE = {
    path: "/api/v1/bookings/bk-1/cancellation-quote",
    body: {
      bookingId: "bk-1", amountChargedCredits: 50, refundCredits: 50, penaltyCredits: 15,
      penaltyPct: 30, penaltyWindowMinutes: 15, insidePenaltyWindow: true,
      checkedIn: false, alreadyStarted: false,
    },
  };

  async function openSheet(extra: StubRoute[] = []) {
    const stub = openAsAdmin([QUOTE, ...extra]);
    await select([/Thandi — cancel on their behalf/]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel 1 booking" })); });
    return stub;
  }

  it("states what goes back — fetched, per booking and in total — before the button", async () => {
    await openSheet();
    const dialog = await screen.findByRole("dialog");
    // 50.00 charged, 15.00 penalty inside the window: 35.00 net. Quoted by the server, never
    // guessed, and never a zero that later becomes a real figure.
    await waitFor(() => expect(within(dialog).getByText(/35\.00 cr back, 15\.00 cr penalty/)).toBeInTheDocument());
    expect(within(dialog).getByText(/15\.00 cr is kept as a late-cancellation penalty/)).toBeInTheDocument();
  });

  it("says there is no undo before the fact, and offers none after it", async () => {
    await openSheet();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/There is no undo/)).toBeInTheDocument();
    expect(within(dialog).getByText(/This cannot be undone\./)).toBeInTheDocument();
  });

  it("will not send without a reason, because the reason is in the email each member gets", async () => {
    await openSheet();
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Cancel 1 booking/ })).not.toBeDisabled);
    const confirm = within(dialog).getByRole("button", { name: /Cancel 1 booking/ });
    expect(confirm).toBeDisabled();

    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("Tell them why"), { target: { value: "Court 2 lights faulty" } });
    });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /Cancel 1 booking/ })).not.toBeDisabled());
  });

  it("sends D2 §5.2's body — one idempotency key for the batch, items by booking id", async () => {
    const stub = await openSheet([{
      method: "POST", path: "/api/v1/admin/bookings/bulk-cancel",
      body: { requested: 1, succeeded: 1, failed: 0, results: [{ booking_id: "bk-1", status: "cancelled", refund_credits: 35, penalty_credits: 15 }] },
    }]);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(/35\.00 cr back/)).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("Tell them why"), { target: { value: "Court 2 lights faulty" } });
    });
    // Two taps: this is a `ConfirmButton`, and a destructive batch arms before it fires.
    const confirm = within(dialog).getByRole("button", { name: /Cancel 1 booking/ });
    await act(async () => { fireEvent.click(confirm); });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /Tap to confirm/ })); });

    const sent = await waitFor(() => {
      const call = stub.calls.find((c) => c.path === "/api/v1/admin/bookings/bulk-cancel");
      expect(call).toBeTruthy();
      return call!.body as Record<string, unknown>;
    });
    expect(sent.reason).toBe("Court 2 lights faulty");
    expect(sent.waivePenalty).toBe(false);
    expect(sent.items).toEqual([{ bookingId: "bk-1" }]);
    expect(String(sent.idempotencyKey)).toMatch(/^bc_/);
  });

  it("renders the per-item outcomes as a list, and never as a toast", async () => {
    const stub = await openSheet([{
      method: "POST", path: "/api/v1/admin/bookings/bulk-cancel",
      body: {
        requested: 1, succeeded: 1, failed: 0,
        results: [{ booking_id: "bk-1", status: "already_cancelled", refund_credits: 0, penalty_credits: 0 }],
      },
    }]);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(/35\.00 cr back/)).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("Tell them why"), { target: { value: "moved to Wednesday" } });
    });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /Cancel 1 booking/ })); });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /Tap to confirm/ })); });

    // `already_cancelled` is a SUCCESS. `CancelAsync` answers NotFound for a row that is not
    // Booked, so a retried batch reports its own successes as errors — and an admin reading
    // "6 failed" about six bookings they cancelled forty seconds ago cancels something else
    // to compensate.
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByText("1 of 1 done.")).toBeInTheDocument());
    expect(within(screen.getByRole("dialog")).getByText("Was already cancelled")).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.path === "/api/v1/admin/bookings/bulk-cancel")).toHaveLength(1);
  });
});

describe("booking many — item 13", () => {
  beforeEach(() => { forgetClubZone(); signIn({ isAdmin: true }); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  async function openSheet(extra: StubRoute[] = []) {
    const stub = openAsAdmin(extra);
    await select([/^Book Court 1 at 16:00/, /^Book Court 1 at 16:15/]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Book 2 slots" })); });
    return stub;
  }

  it("asks who it is for, with one line of consequence against each answer", async () => {
    await openSheet();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Who is this for?")).toBeInTheDocument();
    expect(within(dialog).getByText(/Booked in your own name/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Charged to the member you pick/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Nobody is charged and the name shows on the grid/)).toBeInTheDocument();
  });

  it("states the member's money before anything happens", async () => {
    await openSheet();
    const dialog = await screen.findByRole("dialog");
    await act(async () => { fireEvent.click(within(dialog).getByRole("radio", { name: /A member/ })); });
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("Member to book for"),
        { target: { value: "55555555-5555-5555-5555-555555555555" } });
    });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Next" })); });

    expect(within(dialog).getByText(/100\.00 cr in total\. Thandi Mokoena has 370\.00 cr\. After this: 270\.00 cr\./))
      .toBeInTheDocument();
  });

  it("takes the written-in name in line, and says in words that nobody is charged", async () => {
    const stub = await openSheet([{
      method: "POST", path: "/api/v1/admin/bookings/bulk",
      body: { requested: 2, succeeded: 2, failed: 0, results: [{ index: 0, status: "blocked" }, { index: 1, status: "blocked" }] },
    }]);
    const dialog = await screen.findByRole("dialog");
    await act(async () => { fireEvent.click(within(dialog).getByRole("radio", { name: /A written-in name/ })); });
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("The name to write in"), { target: { value: "Sarah from Westville" } });
    });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Next" })); });

    // A guest has no wallet, no email and no cancellation rights — which is exactly what a
    // block already is. Stated rather than hidden.
    expect(within(dialog).getByText("Nobody is charged for these 2 slots.")).toBeInTheDocument();

    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Book 2 slots" })); });
    const sent = await waitFor(() => {
      const call = stub.calls.find((c) => c.path === "/api/v1/admin/bookings/bulk");
      expect(call).toBeTruthy();
      return call!.body as Record<string, unknown>;
    });
    expect(sent.onBehalf).toEqual({ guestName: "Sarah from Westville" });
    expect(sent.allowNegativeBalance).toBe(false);
    expect(sent.items).toHaveLength(2);
    expect(String(sent.idempotencyKey)).toMatch(/^bb_/);
  });

  it("sends nothing for on_behalf when the admin books as themselves", async () => {
    const stub = await openSheet([{
      method: "POST", path: "/api/v1/admin/bookings/bulk",
      body: { requested: 2, succeeded: 2, failed: 0, results: [{ index: 0, status: "booked" }, { index: 1, status: "booked" }] },
    }]);
    const dialog = await screen.findByRole("dialog");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Next" })); });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Book 2 slots" })); });

    const sent = await waitFor(() => {
      const call = stub.calls.find((c) => c.path === "/api/v1/admin/bookings/bulk");
      expect(call).toBeTruthy();
      return call!.body as Record<string, unknown>;
    });
    // D2 §5.3: omitted `on_behalf` IS the admin's own booking on their own wallet. Sending
    // `{userId: <the admin>}` instead would be a different row kind and a different audit action.
    expect(sent.onBehalf).toBeUndefined();
  });

  it("shows a mid-batch refusal as data, in request order, beside the successes", async () => {
    const stub = await openSheet([{
      method: "POST", path: "/api/v1/admin/bookings/bulk",
      body: {
        requested: 2, succeeded: 1, failed: 1,
        results: [
          { index: 0, status: "booked", booking_id: "new-1", court_name: "Court 1", amount_credits: 50 },
          { index: 1, status: "failed", error: "slot_taken", court_name: "Court 1" },
        ],
      },
    }]);
    const dialog = await screen.findByRole("dialog");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Next" })); });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Book 2 slots" })); });

    await waitFor(() => expect(within(screen.getByRole("dialog")).getByText("1 of 2 done.")).toBeInTheDocument());
    // The reason comes through `describeBookingError` — ONE decoder, so a failed row here says
    // exactly what the single-slot dialog would have said about the same refusal.
    expect(within(screen.getByRole("dialog")).getByText(/Someone just took that slot/)).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.path === "/api/v1/admin/bookings/bulk")).toHaveLength(1);
  });

  it("offers the override under the SAME key when the payer ran out mid-batch", async () => {
    const stub = await openSheet([{
      method: "POST", path: "/api/v1/admin/bookings/bulk",
      body: {
        requested: 2, succeeded: 1, failed: 0, halted_at: 1, halted_reason: "insufficient_balance",
        payer: { user_id: "55555555-5555-5555-5555-555555555555", name: "Thandi Mokoena" },
        results: [
          { index: 0, status: "booked", booking_id: "new-1", court_name: "Court 1", amount_credits: 50 },
          { index: 1, status: "duplicate", booking_id: "new-1" },
        ],
      },
    }]);
    const dialog = await screen.findByRole("dialog");
    await act(async () => { fireEvent.click(within(dialog).getByRole("radio", { name: /A member/ })); });
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("Member to book for"),
        { target: { value: "55555555-5555-5555-5555-555555555555" } });
    });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Next" })); });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Book 2 slots" })); });

    await waitFor(() => expect(within(screen.getByRole("dialog"))
      .getByText(/Thandi Mokoena ran out of credit part-way through/)).toBeInTheDocument());
    const retry = within(screen.getByRole("dialog")).getByRole("button", { name: "Book the rest anyway" });
    await act(async () => { fireEvent.click(retry); });

    const calls = await waitFor(() => {
      const found = stub.calls.filter((c) => c.path === "/api/v1/admin/bookings/bulk");
      expect(found).toHaveLength(2);
      return found;
    });
    const first = calls[0].body as Record<string, unknown>;
    const second = calls[1].body as Record<string, unknown>;
    // The SAME key: the items that landed answer `duplicate` rather than being booked and
    // charged twice. A key regenerated per attempt would defeat exactly that.
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.allowNegativeBalance).toBe(true);
    expect(first.allowNegativeBalance).toBe(false);
  });
});


/**
 * Item 5's desktop half — D3 §4.1 doors 3 and 4: drag a marquee, and extend with Shift.
 *
 * <p>
 * <b>Both grow a RECTANGLE, and D3 said "reading order" for Shift+click.</b> The deviation is
 * argued in `withinRectangle`: shift-clicking Court 2 at 16:00 and Court 2 at 17:00 means that
 * court for that hour, which is what a league night is. In reading order the same pair also
 * takes every other court of the first row, every court of every row between, and the courts
 * before the target in the last — twenty-odd slots where four were asked for, on a control
 * whose next button is a bulk charge.
 * </p>
 *
 * <p>
 * <b>The rectangle is filled from the CELLS, not from the rules.</b> `keysWithin` reads each
 * cell's own `data-select-key`, so a Closed or Past cell inside the sweep is passed over
 * because that cell already decided it cannot be chosen. Re-deriving that here would be a
 * second copy of `cellVerdict`, the quota and the group windows.
 * </p>
 */
describe("extending a selection across a range", () => {
  beforeEach(() => { forgetClubZone(); signIn({ isAdmin: true }); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetClubZone(); });

  const cellAt = (name: string) => screen.getByRole("gridcell", { name });
  const chosen = () => screen.getAllByRole("gridcell").filter((c) => c.getAttribute("aria-selected") === "true");

  it("takes the rectangle between the anchor and a Shift+click, not the reading-order run", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/]);

    // Court 1 16:00 is the anchor. Shift+click Court 1 at 16:30 — one column, three rows.
    await act(async () => {
      fireEvent.click(cellAt("Court 1 at 16:30"), { shiftKey: true, bubbles: true });
    });

    const names = chosen().map((c) => c.getAttribute("aria-label"));
    expect(names).toEqual(["Court 1 at 16:00", "Court 1 at 16:15", "Court 1 at 16:30"]);
    // The proof that it is a rectangle and not a run: the reading-order answer would have
    // swept Court 2 at 16:00 and 16:15 in as well.
    expect(names).not.toContain("Court 2 at 16:00");
  });

  it("widens across courts when the Shift+click is in another column", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/]);

    await act(async () => {
      fireEvent.click(cellAt("Court 2 at 16:15"), { shiftKey: true, bubbles: true });
    });

    expect(chosen().map((c) => c.getAttribute("aria-label")).sort()).toEqual([
      "Court 1 at 16:00", "Court 1 at 16:15", "Court 2 at 16:00", "Court 2 at 16:15",
    ]);
  });

  /**
   * A second extension from the same anchor REPLACES the first rather than adding to it, so a
   * drag that went too far is fixed by dragging back — not by un-ticking eleven cells.
   */
  it("shrinks when the range is pulled back, rather than only ever growing", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/]);

    await act(async () => { fireEvent.click(cellAt("Court 1 at 16:45"), { shiftKey: true, bubbles: true }); });
    expect(chosen()).toHaveLength(4);

    await act(async () => { fireEvent.click(cellAt("Court 1 at 16:15"), { shiftKey: true, bubbles: true }); });
    expect(chosen().map((c) => c.getAttribute("aria-label")))
      .toEqual(["Court 1 at 16:00", "Court 1 at 16:15"]);
  });

  it("extends on Shift+Arrow, so the keyboard draws the same shape as the mouse", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/]);

    const grid = screen.getByRole("grid");
    await act(async () => { fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true }); });
    await act(async () => { fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true }); });

    expect(chosen().map((c) => c.getAttribute("aria-label")).sort()).toEqual([
      "Court 1 at 16:00", "Court 1 at 16:15", "Court 2 at 16:00", "Court 2 at 16:15",
    ]);
  });

  /** Without Shift the caret moves and the selection is left exactly as it was. */
  it("moves the caret without touching the selection when Shift is not held", async () => {
    openAsAdmin();
    await select([/^Book Court 1 at 16:00/]);

    const grid = screen.getByRole("grid");
    await act(async () => { fireEvent.keyDown(grid, { key: "ArrowDown" }); });
    expect(chosen().map((c) => c.getAttribute("aria-label"))).toEqual(["Court 1 at 16:00"]);
  });

  /**
   * The marquee, on a mouse. `pointerType: "mouse"` is load-bearing: a coarse pointer gets the
   * long press instead, because a marquee on a phone is a scroll.
   */
  it("paints a rectangle under a mouse drag, and enters selection mode by itself", async () => {
    openAsAdmin();
    await screen.findByRole("grid");
    // No `Select` pressed. The drag is a door IN — D3 §4.1, door 3. The day strip's toggle is
    // what says whether the mode is on; `aria-multiselectable` is on the grid for any admin.
    expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();

    const grid = screen.getByRole("grid");
    await act(async () => {
      fireEvent.pointerDown(cellAt("Court 1 at 16:00"), { pointerType: "mouse", button: 0, bubbles: true });
      fireEvent.pointerOver(cellAt("Court 1 at 16:15"), { pointerType: "mouse", bubbles: true });
      fireEvent.pointerOver(cellAt("Court 2 at 16:30"), { pointerType: "mouse", bubbles: true });
      fireEvent.pointerUp(window);
    });

    expect(grid).toHaveAttribute("aria-multiselectable", "true");
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(chosen().map((c) => c.getAttribute("aria-label")).sort()).toEqual([
      "Court 1 at 16:00", "Court 1 at 16:15", "Court 1 at 16:30",
      "Court 2 at 16:00", "Court 2 at 16:15", "Court 2 at 16:30",
    ]);
  });

  /**
   * A press and a release on ONE cell is a click, and must still open the booking dialog. A
   * marquee that fired on every click would have replaced the product's primary action.
   */
  it("leaves an ordinary click alone", async () => {
    openAsAdmin();
    await screen.findByRole("grid");

    const cell = await screen.findByRole("button", { name: /^Book Court 1 at 16:00/ });
    await act(async () => {
      fireEvent.pointerDown(cell, { pointerType: "mouse", button: 0, bubbles: true });
      fireEvent.pointerUp(window);
      fireEvent.click(cell);
    });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  /**
   * A marquee is not a mobile gesture. On a coarse pointer the same sequence must do nothing,
   * because the same sequence is how somebody scrolls a grid with their thumb.
   */
  it("ignores a touch drag, which is a scroll", async () => {
    openAsAdmin();
    await screen.findByRole("grid");

    await act(async () => {
      fireEvent.pointerDown(cellAt("Court 1 at 16:00"), { pointerType: "touch", button: 0, bubbles: true });
      fireEvent.pointerOver(cellAt("Court 1 at 16:30"), { pointerType: "touch", bubbles: true });
      fireEvent.pointerUp(window);
    });

    expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();
    expect(chosen()).toHaveLength(0);
  });
});
