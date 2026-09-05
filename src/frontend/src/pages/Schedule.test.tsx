import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import SchedulePage from "./Schedule";
import { renderPage, signIn, signOut, stubFetch, type StubRoute } from "../test/harness";

/**
 * `slotAt` is called once per grid cell per render, so counting it counts renders of the
 * grid — which is what the last block of tests below is measuring. The rest of the module
 * is the real one; only the counter is added.
 */
const cellLookups = { count: 0 };
vi.mock("../lib/scheduleGrid", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/scheduleGrid")>();
  return {
    ...real,
    slotAt: (...args: Parameters<typeof real.slotAt>) => {
      cellLookups.count += 1;
      return real.slotAt(...args);
    },
  };
});

/**
 * The schedule, as a member and as an admin.
 *
 * <p>
 * Five findings meet on this screen and every one of them was a thing the member was
 * not told: the two headline booking rules refused with "Booking failed."; a
 * cancellation stated no figures before and lied about them afterwards; the booking
 * confirmation was a grid cell that relabelled itself and disarmed after three seconds;
 * a lapsed session was reported as "That slot is in the past."; and an admin's own
 * schedule offered no admin action at all.
 * </p>
 *
 * <p>
 * fireEvent throughout, never user-event: its keyboard and typing paths never settle
 * under jsdom 28 + vitest 4 here and the failure reads as a component ignoring input.
 * </p>
 */
describe("Schedule", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    signOut();
  });

  const COURT = "11111111-1111-1111-1111-111111111111";
  const BOOKING_ID = "99999999-9999-9999-9999-999999999999";
  const ME = "44444444-4444-4444-4444-444444444444";

  /**
   * A fixed day, far enough ahead that every slot on it is in the future.
   *
   * <p>
   * Fixed so the labels below are identical on every machine; FUTURE because the grid
   * greys a slot whose start has passed, and a fixture set to "today" would turn its own
   * cells into "Past" as the suite ran later in the day — passing all morning and failing
   * after lunch, which is the exact trap the backend fixtures carry a comment about.
   * </p>
   */
  const DATE = "2030-09-07";
  const sast = (hh: number, mm = 0) => new Date(Date.UTC(2030, 8, 7, hh - 2, mm, 0)).toISOString();

  const DAY = {
    date: DATE,
    timezone: "Africa/Johannesburg",
    sliceMinutes: 15,
    dayStartMinute: 7 * 60,
    dayEndMinute: 20 * 60,
    advanceBookingDays: 14,
    penaltyPct: 30,
    penaltyWindowMinutes: 15,
    courts: [{ id: COURT, courtNumber: 1, name: "Court 1", slicePriceCredits: 50 }],
    slots: [] as unknown[],
  };

  const MY_SLOT = {
    courtId: COURT,
    courtNumber: 1,
    startsAtUtc: sast(19),
    endsAtUtc: sast(19, 30),
    status: "booked",
    ownerUserId: ME,
    ownerFirstName: "Naledi",
    ownerPhotoUrl: null,
    isMine: true,
    bookingId: BOOKING_ID,
    blockLabel: null,
    checkedIn: false,
    amountChargedCredits: 50,
  };

  const WALLET = { balance_credits: 1635, entries: [] };

  function stub(routes: StubRoute[], opts: { isAdmin?: boolean } = {}) {
    const whoami = signIn({ isAdmin: opts.isAdmin ?? false });
    return stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: WALLET },
      { path: "/api/v1/schedule", body: DAY },
      ...routes,
    ]);
  }

  /** Opens the confirmation for the first free slot on the grid — a whole day of them is free. */
  async function openBookingModal() {
    const cells = await screen.findAllByRole("button", { name: /^Book Court .* for 50\.00 cr/ });
    fireEvent.click(cells[0]);
    return await screen.findByRole("dialog", { name: "Confirm booking" });
  }

  // ---- F6: the confirmation is the specified modal, and it has no stopwatch ----

  it("shows court, time, duration, cost and the balance before and after", async () => {
    stub([]);
    renderPage(<SchedulePage />);

    const modal = await openBookingModal();

    // §5 names all six. The old confirmation was the grid cell turning orange and
    // reading "Reserve for 50.00 cr?" — no court, no time, no duration, no balance.
    expect(modal).toHaveTextContent("Court 1");
    expect(modal).toHaveTextContent("15 min");
    expect(modal).toHaveTextContent("50.00 cr");
    expect(modal).toHaveTextContent("1635.00 cr");
    expect(modal).toHaveTextContent("1585.00 cr");
  });

  it("stays open however long the member takes to read it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      stub([]);
      renderPage(<SchedulePage />);
      const modal = await vi.waitFor(async () => {
        const cells = screen.getAllByRole("button", { name: /^Book Court .* for 50\.00 cr/ });
        fireEvent.click(cells[0]);
        return screen.getByRole("dialog", { name: "Confirm booking" });
      });

      // The old inline confirmation disarmed after 3000 ms and the second tap re-armed
      // rather than confirming, so a member who paused to read the price could tap for
      // ever and never book. Twelve seconds is the gap finder B measured.
      await vi.advanceTimersByTimeAsync(12_000);

      expect(modal).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Book for 50.00 cr" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("books only when the member confirms in the modal", async () => {
    const fetchStub = stub([
      { method: "POST", path: "/api/v1/bookings/", body: { booking_id: BOOKING_ID, balance_after_credits: 1585 } },
    ]);
    renderPage(<SchedulePage />);
    await openBookingModal();

    // Opening the modal must not have booked anything.
    expect(fetchStub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/bookings/")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));

    await waitFor(() => {
      const posts = fetchStub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/bookings/");
      expect(posts).toHaveLength(1);
      expect(posts[0].body).toMatchObject({ courtId: COURT, sliceCount: 1 });
    });
  });

  // ---- F1 / F10: refusals say which rule, and a lost session says so ----

  it("names the peak-hours rule and the window instead of 'Booking failed'", async () => {
    stub([{
      method: "POST", path: "/api/v1/bookings/", status: 409,
      body: { error: "peak_hours_league_only", peak_start: "16:00", peak_end: "19:00", regular_advance_hours: 1 },
    }]);
    renderPage(<SchedulePage />);
    await openBookingModal();
    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));

    expect(await screen.findByText(/16:00–19:00 is reserved for league and senior members until an hour before the slot/))
      .toBeInTheDocument();
  });

  it("tells a capped member how many of their own minutes are already booked", async () => {
    stub([{
      method: "POST", path: "/api/v1/bookings/", status: 409,
      body: { error: "per_day_cap_exceeded", cap_minutes: 60, already_booked_minutes: 60, attempted_minutes: 15 },
    }]);
    renderPage(<SchedulePage />);
    await openBookingModal();
    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));

    expect(await screen.findByText(/You already have 60 of your 60 minutes booked for that day/)).toBeInTheDocument();
  });

  it("says the club is closed, with that day's hours", async () => {
    stub([{
      method: "POST", path: "/api/v1/bookings/", status: 409,
      body: { error: "out_of_hours", opens_at: "07:00", closes_at: "20:00" },
    }]);
    renderPage(<SchedulePage />);
    await openBookingModal();
    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));

    expect(await screen.findByText(/The club is open 07:00–20:00 that day/)).toBeInTheDocument();
  });

  it("says the session expired rather than claiming an evening slot is in the past", async () => {
    // The tenancy middleware answers 400 tenant_unresolved for a lapsed bearer on a
    // deployment whose hostname carries no tenant subdomain. The page used to map EVERY
    // 400 to "That slot is in the past.", so a member with a dead session tapped a free
    // 8 p.m. slot and was told it had already happened.
    stub([{
      method: "POST", path: "/api/v1/bookings/", status: 400,
      body: { error: "tenant_unresolved", message: "No tenant could be resolved from this request." },
    }]);
    renderPage(<SchedulePage />);
    await openBookingModal();
    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));

    expect(await screen.findByText(/Your session has expired/)).toBeInTheDocument();
    expect(screen.queryByText(/in the past/)).not.toBeInTheDocument();
  });

  it("still says 'in the past' when the slot genuinely is", async () => {
    stub([{ method: "POST", path: "/api/v1/bookings/", status: 400, body: { error: "past_time" } }]);
    renderPage(<SchedulePage />);
    await openBookingModal();
    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));

    expect(await screen.findByText(/That slot has already started/)).toBeInTheDocument();
  });

  // ---- F4 / F5 / F8: the cancellation states its price first ----

  const QUOTE = {
    bookingId: BOOKING_ID,
    amountChargedCredits: 50,
    refundCredits: 50,
    penaltyCredits: 0,
    penaltyPct: 30,
    penaltyWindowMinutes: 15,
    insidePenaltyWindow: false,
    checkedIn: false,
    alreadyStarted: false,
  };

  function stubWithMyBooking(
    quote: Partial<typeof QUOTE>, extra: StubRoute[] = [], slotOverrides: Partial<typeof MY_SLOT> = {},
  ) {
    const whoami = signIn({ isAdmin: false });
    return stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: WALLET },
      { path: "/api/v1/admin/members/", body: [] },
      { path: "/api/v1/schedule", body: { ...DAY, slots: [{ ...MY_SLOT, ...slotOverrides }] } },
      { path: `/api/v1/bookings/${BOOKING_ID}/cancellation-quote`, body: { ...QUOTE, ...quote } },
      ...extra,
    ]);
  }

  it("states the exact penalty and the net refund before the member commits", async () => {
    stubWithMyBooking({ insidePenaltyWindow: true, penaltyCredits: 15, refundCredits: 35 });
    renderPage(<SchedulePage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Cancel your booking on Court / }));

    const modal = await screen.findByRole("dialog", { name: "Cancel this booking?" });
    // §7 asks for both figures, and 15.00 credits used to be taken with nothing on
    // screen about it before or after.
    await waitFor(() => expect(modal).toHaveTextContent(/A 30% penalty of 15\.00 cr is deducted/));
    expect(modal).toHaveTextContent("35.00 cr");
  });

  it("warns that nothing comes back once the member has checked in", async () => {
    stubWithMyBooking({ checkedIn: true, refundCredits: 0, penaltyCredits: 0 }, [], { checkedIn: true });
    renderPage(<SchedulePage />);

    // The grid says it too — the schedule projection did not carry attendance at all, so
    // no screen in the product could tell a member their court was lit.
    const cell = await screen.findByRole("button", { name: /^Cancel your booking on Court .* — checked in$/ });
    fireEvent.click(cell);

    const modal = await screen.findByRole("dialog", { name: "Cancel this booking?" });
    await waitFor(() => expect(modal).toHaveTextContent(/nothing is refunded/i));
    expect(modal).toHaveTextContent("50.00 cr");
  });

  it("says a free cancellation is free", async () => {
    stubWithMyBooking({});
    renderPage(<SchedulePage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Cancel your booking on Court / }));

    const modal = await screen.findByRole("dialog", { name: "Cancel this booking?" });
    await waitFor(() => expect(modal).toHaveTextContent(/Cancelling now is free/));
  });

  it("reports what actually moved, not 'refund pending'", async () => {
    stubWithMyBooking({ insidePenaltyWindow: true, penaltyCredits: 15, refundCredits: 35 }, [
      { method: "POST", path: `/api/v1/bookings/${BOOKING_ID}/cancel`, body: { refunded_credits: 50, penalty_credits: 15 } },
    ]);
    renderPage(<SchedulePage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Cancel your booking on Court / }));
    await screen.findByRole("dialog", { name: "Cancel this booking?" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel the booking" }));

    expect(await screen.findByText(/35\.00 cr back to your credit, 15\.00 cr kept as the late-cancellation penalty/))
      .toBeInTheDocument();
    expect(screen.queryByText(/refund pending/i)).not.toBeInTheDocument();
  });

  // ---- F11: the admin can act on the grid ----

  it("lets an admin cancel another member's booking and waive the penalty", async () => {
    const theirs = { ...MY_SLOT, isMine: false, ownerUserId: "55555555-5555-5555-5555-555555555555" };
    const whoami = signIn({ isAdmin: true });
    const fetchStub = stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: WALLET },
      { path: "/api/v1/admin/members/", body: [] },
      { path: "/api/v1/schedule", body: { ...DAY, slots: [theirs] } },
      { path: `/api/v1/bookings/${BOOKING_ID}/cancellation-quote`, body: { ...QUOTE, insidePenaltyWindow: true, penaltyCredits: 15, refundCredits: 35 } },
      { method: "POST", path: `/api/v1/admin/bookings/${BOOKING_ID}/cancel`, body: { refunded_credits: 50, penalty_credits: 0 } },
    ]);
    renderPage(<SchedulePage />);

    // Another member's slot used to be inert text — a photo and a first name, no control —
    // while POST /api/v1/admin/bookings/{id}/cancel existed and was simply unreachable.
    fireEvent.click(await screen.findByRole("button", { name: /cancel on their behalf/ }));
    await screen.findByRole("dialog", { name: "Cancel this booking?" });

    fireEvent.click(await screen.findByLabelText(/Waive the 15\.00 cr penalty/));
    // §7's "logged with reason" — the waiver does not go without one.
    fireEvent.change(screen.getByLabelText("Why the penalty is being waived"), {
      target: { value: "Club closed the court" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel the booking" }));

    await waitFor(() => {
      const post = fetchStub.calls.find((c) => c.method === "POST" && c.path.endsWith(`/admin/bookings/${BOOKING_ID}/cancel`));
      expect(post?.body).toMatchObject({ waivePenalty: true, waiveReason: "Club closed the court" });
    });
  });

  it("books on a member's behalf out of the MEMBER's wallet, not the admin's", async () => {
    const THEM = "55555555-5555-5555-5555-555555555555";
    const whoami = signIn({ isAdmin: true });
    const fetchStub = stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      // The seeded admin's own balance is zero, which is the ordinary state of a desk
      // account: nobody tops up the club's admin login, because it never plays.
      { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [] } },
      { path: "/api/v1/admin/members/", body: [{ user_id: THEM, full_name: "Naledi Khumalo" }] },
      { path: "/api/v1/schedule", body: DAY },
      { method: "POST", path: "/api/v1/admin/bookings/", body: { booking_id: "88888888-8888-8888-8888-888888888888", balance_after_credits: 0 } },
    ]);
    renderPage(<SchedulePage />);
    await openBookingModal();

    // Booking it for THEMSELVES they genuinely cannot afford, and the modal says so.
    // This also proves the wallet answer has landed, so the assertions below are not
    // passing on a balance that is merely still null.
    await screen.findByText(/more than you have/);

    fireEvent.change(screen.getByLabelText("Book this as"), { target: { value: "member" } });
    fireEvent.change(screen.getByLabelText("Member"), { target: { value: THEM } });

    // The third admin action was unreachable: affordability was computed from the
    // SIGNED-IN user's balance whatever the mode, so the desk could cancel for a member
    // and block a court but could never book for one — the modal read "charged to the
    // member" and "that's more than you have" at the same time and disabled the button.
    // The money here is Naledi's; §8 lets an admin override even an insufficient member
    // balance, so the admin's own wallet has no say in it at all.
    expect(screen.queryByText(/more than you have/)).not.toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Book for 50.00 cr" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => {
      const post = fetchStub.calls.find((c) => c.method === "POST" && c.path === "/api/v1/admin/bookings/");
      expect(post?.body).toMatchObject({ courtId: COURT, userId: THEM, sliceCount: 1 });
    });
  });

  it("lets an admin block a slot for an event", async () => {
    const whoami = signIn({ isAdmin: true });
    const fetchStub = stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: WALLET },
      { path: "/api/v1/admin/members/", body: [] },
      { path: "/api/v1/schedule", body: DAY },
      { method: "POST", path: "/api/v1/admin/blocks/", body: { booking_id: "77777777-7777-7777-7777-777777777777" } },
    ]);
    renderPage(<SchedulePage />);
    await openBookingModal();

    // §8 has promised admin blocks since the first spec and SlotCell could already
    // RENDER one; nothing in the product could create one.
    fireEvent.change(screen.getByLabelText("Book this as"), { target: { value: "block" } });
    fireEvent.click(screen.getByRole("button", { name: "Block the court" }));

    await waitFor(() => {
      const post = fetchStub.calls.find((c) => c.method === "POST" && c.path === "/api/v1/admin/blocks/");
      expect(post?.body).toMatchObject({ courtId: COURT, sliceCount: 1, label: "Tournament" });
    });
  });

  // ---- F3 / F15: the grid's shape ----

  it("draws the day to the club's own hours for that weekday", async () => {
    stub([]);
    renderPage(<SchedulePage />);
    await screen.findByText("07:00");

    // Saturday closes at 20:00. 21:45 — the slot finder B was sold and charged for — is
    // not on the grid, because the day now carries its own hours rather than a flat pair.
    expect(screen.getByText("19:45")).toBeInTheDocument();
    expect(screen.queryByText("21:45")).not.toBeInTheDocument();
  });

  it("lets a member look back as far as they can look forward", async () => {
    stub([]);
    renderPage(<SchedulePage />);

    const picker = await screen.findByLabelText("Schedule date");
    const min = picker.getAttribute("min");
    const max = picker.getAttribute("max");
    // `min` used to be pinned to today for everyone but an admin, so a member could only
    // ever move forward — and with no bookings list anywhere else in the product, there
    // was no way to review a booking they had already played.
    expect(min).not.toBeNull();
    expect(max).not.toBeNull();
    expect(Date.parse(min!)).toBeLessThan(Date.now());
  });

  // ---- "Booking is slow" — the founder's own report, measured then fixed ----

  it("shows the new booking without waiting for the schedule to be fetched again", async () => {
    // The second /schedule answer is deliberately still EMPTY — the server "has not caught
    // up". The page used to await that refetch before anything changed on screen, so the
    // member's cell stayed "Available" for a whole extra round trip after their money had
    // moved. It now paints from the POST's own response and reconciles behind them.
    const fetchStub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: WALLET },
      // The confirming refetch is made to FAIL, so what is on screen can only have come
      // from the POST's own response.
      { path: "/api/v1/schedule", sequence: [DAY, "the network went away"], body: DAY },
      { path: `/api/v1/bookings/${BOOKING_ID}/cancellation-quote`, body: QUOTE },
      { method: "POST", path: "/api/v1/bookings/", body: { booking_id: BOOKING_ID, balance_after_credits: 1585 } },
    ]);
    renderPage(<SchedulePage />);
    await openBookingModal();
    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));

    expect(await screen.findByRole("button", { name: /^Cancel your booking on Court / })).toBeInTheDocument();
    // And the balance came off the booking response rather than a second wallet read.
    const walletReads = fetchStub.calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/v1/wallet"));
    expect(walletReads).toHaveLength(1);
  });

  it("does not rebuild the grid when a modal opens", async () => {
    stub([]);
    renderPage(<SchedulePage />);
    await screen.findAllByRole("button", { name: /^Book Court .* for 50\.00 cr/ });

    // A club day is a couple of hundred cells. Every one of them re-rendered whenever any
    // state on the page moved — opening the confirmation, closing it, arming a cancel —
    // for a dialog that touches no cell at all. Measured at 28 ms in jsdom to open a
    // dialog, 8 ms after. The memo only bites while the grid's callbacks stay stable,
    // which is what this actually pins.
    await openBookingModal();
    const before = cellLookups.count;
    fireEvent.click(screen.getByRole("button", { name: "Keep looking" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(cellLookups.count).toBe(before);
  });

  // ---- §8: "if insufficient, admin can override and create a negative balance, logged" ----

  const THEM = "55555555-5555-5555-5555-555555555555";
  const OTHER = "66666666-6666-6666-6666-666666666666";

  /**
   * A desk signed in as admin, looking at a free day, with one member on file who is
   * short. `postStatus` and `postBody` drive what the admin booking endpoint answers,
   * per attempt — the whole interaction is refuse-then-override, so a stub with one
   * answer cannot express it.
   */
  function adminAtTheDesk(postStatus: number | number[], postBody: unknown, postSequence?: unknown[]) {
    const whoami = signIn({ isAdmin: true });
    return stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      // Zero, which is the ordinary state of a club desk account: it never plays.
      { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [] } },
      { path: "/api/v1/admin/members/", body: [
        { user_id: THEM, full_name: "Naledi Khumalo", balance_credits: 10 },
        { user_id: OTHER, full_name: "Liam O'Connor", balance_credits: 500 },
      ] },
      { path: "/api/v1/schedule", body: DAY },
      { method: "POST", path: "/api/v1/admin/bookings/", status: postStatus, body: postBody, sequence: postSequence },
    ]);
  }

  const SHORT = { error: "insufficient_balance", current_credits: 10, required_credits: 50 };

  /** Opens the confirmation and switches it to "on behalf of Naledi". */
  async function chooseMember() {
    await openBookingModal();
    fireEvent.change(screen.getByLabelText("Book this as"), { target: { value: "member" } });
    fireEvent.change(screen.getByLabelText("Member"), { target: { value: THEM } });
  }

  it("tells the admin what the member is short by, instead of a toast about the admin's own wallet", async () => {
    adminAtTheDesk(402, SHORT);
    renderPage(<SchedulePage />);
    await chooseMember();

    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));

    // The refusal used to leave as "Not enough credits — top up your wallet and try
    // again.", shown to a desk account whose wallet has nothing to do with it, and the
    // modal closed on the member's name. Now the modal stays open and states the case.
    const dialog = await screen.findByRole("dialog", { name: "Confirm booking" });
    expect(dialog).toHaveTextContent("Naledi Khumalo doesn't have enough credit");
    expect(dialog).toHaveTextContent("10.00 cr");
    expect(dialog).toHaveTextContent("50.00 cr");
    expect(dialog).toHaveTextContent("-40.00 cr");
    expect(screen.queryByText(/top up your wallet/i)).not.toBeInTheDocument();
  });

  it("does not overdraw anybody until the admin asks for it a second time", async () => {
    const fetchStub = adminAtTheDesk(402, SHORT);
    renderPage(<SchedulePage />);
    await chooseMember();

    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));
    await screen.findByRole("button", { name: "Book anyway — leaves -40.00 cr" });

    // The first attempt is an ORDINARY booking. An override that rode along with it
    // would make §8's "admin can override" mean "admins are never refused", which is a
    // different and much worse promise.
    const posts = fetchStub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/admin/bookings/");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ allowNegativeBalance: false });
  });

  it("sends the override on the second press, and says what it left the member owing", async () => {
    // `sequence` and `status` are indexed together: the refusal, then the booking, with
    // the MEMBER's balance in the answer.
    const fetchStub = adminAtTheDesk([402, 200], SHORT, [
      SHORT,
      { booking_id: "88888888-8888-8888-8888-888888888888", balance_after_credits: -40 },
    ]);
    renderPage(<SchedulePage />);
    await chooseMember();

    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));
    fireEvent.click(await screen.findByRole("button", { name: "Book anyway — leaves -40.00 cr" }));

    await waitFor(() => {
      const posts = fetchStub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/admin/bookings/");
      expect(posts).toHaveLength(2);
      expect(posts[1].body).toMatchObject({ courtId: COURT, userId: THEM, allowNegativeBalance: true });
    });

    // The admin who has just put somebody in the red is told by how much, there and then,
    // and told WHOSE red it is — the confirmation used to say "that member" throughout.
    expect(await screen.findByText(/Naledi Khumalo's balance is now -40\.00 cr/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  /** Drives the modal to the point where the override is on offer against Naledi. */
  async function offerOnScreen() {
    renderPage(<SchedulePage />);
    await chooseMember();
    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));
    await screen.findByRole("button", { name: "Book anyway — leaves -40.00 cr" });
  }

  function offerIsGone() {
    expect(screen.queryByRole("button", { name: /Book anyway/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/doesn't have enough credit/)).not.toBeInTheDocument();
  }

  it("drops the offer when the admin picks a different member", async () => {
    adminAtTheDesk(402, SHORT);
    await offerOnScreen();

    // Naledi's figures must never stand over somebody else's name. Switching the member
    // is the dangerous one: the panel names a person and a shortfall, and the button
    // states a balance — all three would be about the wrong member.
    fireEvent.change(screen.getByLabelText("Member"), { target: { value: OTHER } });
    offerIsGone();
  });

  it("drops the offer when the admin stops booking on a member's behalf", async () => {
    adminAtTheDesk(402, SHORT);
    await offerOnScreen();

    fireEvent.change(screen.getByLabelText("Book this as"), { target: { value: "block" } });
    offerIsGone();
  });

  it("never tells a desk to top up its own wallet about a member's shortfall", async () => {
    // The degenerate path: `insufficient_balance` with no figures on it, so there is
    // nothing to offer an override against. The shared sentence for this code is "top up
    // YOUR wallet", which is right for a member and wrong for a club desk — the short
    // wallet is not theirs, and a desk account's balance is zero permanently.
    adminAtTheDesk(402, { error: "insufficient_balance" });
    renderPage(<SchedulePage />);
    await chooseMember();

    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));

    expect(await screen.findByText(/That member doesn't have enough credit/)).toBeInTheDocument();
    expect(screen.queryByText(/top up your wallet/i)).not.toBeInTheDocument();
  });

  it("still refuses a MEMBER booking their own slot, with no override on offer", async () => {
    const whoami = signIn({ isAdmin: false });
    const fetchStub = stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 10, entries: [] } },
      { path: "/api/v1/schedule", body: DAY },
      { method: "POST", path: "/api/v1/bookings/", status: 402, body: SHORT },
    ]);
    renderPage(<SchedulePage />);
    await openBookingModal();

    // The client refuses it before the request, and the sentence is the member's own —
    // this is the wallet that really is short.
    expect(await screen.findByText(/That's more than you have/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Book for 50.00 cr" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Book anyway/ })).not.toBeInTheDocument();
    expect(fetchStub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/bookings/")).toHaveLength(0);
  });

  // ---- J-F3: a refusal is answered IN the dialog that caused it ----

  it("puts the refusal inside the confirmation dialog, not only in a toast behind it", async () => {
    stub([{
      method: "POST", path: "/api/v1/bookings/", status: 409,
      body: { error: "per_day_cap_exceeded", cap_minutes: 60, already_booked_minutes: 60, attempted_minutes: 15 },
    }]);
    renderPage(<SchedulePage />);
    const modal = await openBookingModal();
    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));

    // The modal stayed open with NOTHING in it and its button back at rest, while the only
    // explanation painted under the modal's own 30% scrim and cleared itself after four
    // seconds. A member watching the dialog — where their attention is — saw a control
    // that did nothing and was never told why.
    await waitFor(() => expect(modal).toHaveTextContent(/You already have 60 of your 60 minutes booked/));
    expect(within(modal).getByRole("alert")).toBeInTheDocument();
  });

  it("does not tell a member to refresh the schedule when the club's own system is down", async () => {
    // An HTML body, because that is what a wedged gateway actually answers with — and
    // because the client used to JSON.parse it BEFORE constructing the ApiError, so a real
    // 502 reached the screen as a bare SyntaxError and no status-based branch could fire.
    // A stub returning JSON with a 502 status passes either way and proves nothing; this
    // one was found in a browser.
    stub([{ method: "POST", path: "/api/v1/bookings/", status: 502, body: "<html><body>502 Bad Gateway</body></html>" }]);
    renderPage(<SchedulePage />);
    const modal = await openBookingModal();
    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));

    // Every 5xx used to come out as "Refresh the schedule and try again" — advice for a
    // stale grid, and simply wrong for a gateway that is down: refreshing fails too.
    await waitFor(() => expect(modal).toHaveTextContent(/isn't answering right now/));
    expect(modal).toHaveTextContent(/no credit was taken/);
    expect(screen.queryByText(/Refresh the schedule and try again/)).not.toBeInTheDocument();
  });

  it("clears the refusal when the admin changes who is being booked for", async () => {
    adminAtTheDesk(409, { error: "slot_taken" });
    renderPage(<SchedulePage />);
    await chooseMember();
    const modal = screen.getByRole("dialog", { name: "Confirm booking" });
    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));
    await waitFor(() => expect(modal).toHaveTextContent(/Someone just took that slot/));

    // A refusal belongs to one attempt against one payer, exactly as the shortfall does.
    fireEvent.change(screen.getByLabelText("Member"), { target: { value: OTHER } });
    expect(modal).not.toHaveTextContent(/Someone just took that slot/);
  });

  // ---- I-F13 / G-F10: the desk sees whose credit, how much, and what is left ----

  it("shows the member's balance and the balance the booking leaves, before any refusal", async () => {
    adminAtTheDesk(200, { booking_id: "88888888-8888-8888-8888-888888888888", balance_after_credits: 450 });
    renderPage(<SchedulePage />);
    const modal = await openBookingModal();
    fireEvent.change(screen.getByLabelText("Book this as"), { target: { value: "member" } });
    fireEvent.change(screen.getByLabelText("Member"), { target: { value: OTHER } });

    // "Their balance: charged to the member" — a phrase where a number belongs — and no
    // "balance after" row at all. §8 asks for the member's name, their balance, the price
    // and the balance it will leave, and a member who could afford it produced none of it.
    await waitFor(() => expect(modal).toHaveTextContent("Their balance"));
    expect(modal).toHaveTextContent("500.00 cr");
    expect(modal).toHaveTextContent("Their balance after");
    expect(modal).toHaveTextContent("450.00 cr");
    expect(modal).not.toHaveTextContent("charged to the member");
  });

  it("names the member in the on-behalf confirmation", async () => {
    adminAtTheDesk(200, { booking_id: "88888888-8888-8888-8888-888888888888", balance_after_credits: 450 });
    renderPage(<SchedulePage />);
    await chooseMember();
    fireEvent.click(screen.getByRole("button", { name: "Book for 50.00 cr" }));

    // "…for that member." The admin has just picked a name from a dropdown, and repeating
    // it back is the one check that catches a mis-click.
    expect(await screen.findByText(/Booked Court 1 at .* for Naledi Khumalo\./)).toBeInTheDocument();
    expect(screen.queryByText(/for that member/)).not.toBeInTheDocument();
  });

  // ---- G-F5 / G-F6: an admin is not the member, and a waiver carries its reason ----

  const THEIRS = { ...MY_SLOT, isMine: false, ownerUserId: THEM, ownerFirstName: "Naledi" };

  function adminCancelling(quote: Partial<typeof QUOTE>, slotOverrides: Partial<typeof MY_SLOT> = {}) {
    const whoami = signIn({ isAdmin: true });
    return stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [] } },
      { path: "/api/v1/admin/members/", body: [] },
      { path: "/api/v1/schedule", body: { ...DAY, slots: [{ ...THEIRS, ...slotOverrides }] } },
      { path: `/api/v1/bookings/${BOOKING_ID}/cancellation-quote`, body: { ...QUOTE, ...quote } },
      { method: "POST", path: `/api/v1/admin/bookings/${BOOKING_ID}/cancel`, body: { refunded_credits: 50, penalty_credits: 0 } },
    ]);
  }

  async function openAdminCancel() {
    fireEvent.click(await screen.findByRole("button", { name: /cancel on their behalf/ }));
    return await screen.findByRole("dialog", { name: "Cancel this booking?" });
  }

  it("tells an admin the refund goes to the member, by name, not to 'your credit'", async () => {
    adminCancelling({});
    renderPage(<SchedulePage />);
    const modal = await openAdminCancel();

    // §7: "refunds always go to the booking's player". The dialog was written in the first
    // person throughout and never named the member, so a desk account whose own balance is
    // zero permanently was told the money was coming back to it.
    await waitFor(() => expect(modal).toHaveTextContent(/goes back to Naledi's credit/));
    expect(modal).toHaveTextContent("Naledi");
    expect(modal).not.toHaveTextContent(/back to your credit/);
  });

  it("does not tell an admin that they themselves checked in", async () => {
    adminCancelling({ checkedIn: true, refundCredits: 0, penaltyCredits: 0 }, { checkedIn: true });
    renderPage(<SchedulePage />);
    const modal = await openAdminCancel();

    await waitFor(() => expect(modal).toHaveTextContent(/Naledi has already checked in/));
    expect(modal).not.toHaveTextContent(/You've already checked in/);
  });

  it("names the member's credit in the confirmation after an admin cancellation", async () => {
    adminCancelling({});
    renderPage(<SchedulePage />);
    await openAdminCancel();
    await screen.findByText(/goes back to Naledi's credit/);

    fireEvent.click(screen.getByRole("button", { name: "Cancel the booking" }));

    expect(await screen.findByText(/50\.00 cr back to Naledi's credit/)).toBeInTheDocument();
  });

  it("refuses to waive a penalty until the admin says why, and sends the reason", async () => {
    const fetchStub = adminCancelling({ insidePenaltyWindow: true, penaltyCredits: 15, refundCredits: 35 });
    renderPage(<SchedulePage />);
    await openAdminCancel();

    fireEvent.click(await screen.findByLabelText(/Waive the 15\.00 cr penalty/));

    // §7 and §8 both say "with reason". There was no field, nothing on the wire, and the
    // audit row carried a bare `waived: true` — so a club reviewing waived penalties at
    // month end could not tell a club decision from a quiet favour.
    const confirm = screen.getByRole("button", { name: "Cancel the booking" });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Why the penalty is being waived"), {
      target: { value: "Court flooded — club's fault" },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => {
      const post = fetchStub.calls.find((c) => c.method === "POST" && c.path.endsWith(`/admin/bookings/${BOOKING_ID}/cancel`));
      expect(post?.body).toMatchObject({ waivePenalty: true, waiveReason: "Court flooded — club's fault" });
    });
  });
});
