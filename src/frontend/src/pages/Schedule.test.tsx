import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
    const cells = await screen.findAllByRole("button", { name: /Book this slot for 50\.00 cr/ });
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
        const cells = screen.getAllByRole("button", { name: /Book this slot for 50\.00 cr/ });
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
    expect(fetchStub.calls.filter((c) => c.method === "POST")).toHaveLength(0);

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

    fireEvent.click(await screen.findByRole("button", { name: /Mine — open cancellation/ }));

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
    const cell = await screen.findByRole("button", { name: /Mine · checked in/ });
    fireEvent.click(cell);

    const modal = await screen.findByRole("dialog", { name: "Cancel this booking?" });
    await waitFor(() => expect(modal).toHaveTextContent(/nothing is refunded/i));
    expect(modal).toHaveTextContent("50.00 cr");
  });

  it("says a free cancellation is free", async () => {
    stubWithMyBooking({});
    renderPage(<SchedulePage />);
    fireEvent.click(await screen.findByRole("button", { name: /Mine — open cancellation/ }));

    const modal = await screen.findByRole("dialog", { name: "Cancel this booking?" });
    await waitFor(() => expect(modal).toHaveTextContent(/Cancelling now is free/));
  });

  it("reports what actually moved, not 'refund pending'", async () => {
    stubWithMyBooking({ insidePenaltyWindow: true, penaltyCredits: 15, refundCredits: 35 }, [
      { method: "POST", path: `/api/v1/bookings/${BOOKING_ID}/cancel`, body: { refunded_credits: 50, penalty_credits: 15 } },
    ]);
    renderPage(<SchedulePage />);
    fireEvent.click(await screen.findByRole("button", { name: /Mine — open cancellation/ }));
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
    fireEvent.click(screen.getByRole("button", { name: "Cancel the booking" }));

    await waitFor(() => {
      const post = fetchStub.calls.find((c) => c.method === "POST" && c.path.endsWith(`/admin/bookings/${BOOKING_ID}/cancel`));
      expect(post?.body).toMatchObject({ waivePenalty: true });
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

    expect(await screen.findByRole("button", { name: /Mine — open cancellation/ })).toBeInTheDocument();
    // And the balance came off the booking response rather than a second wallet read.
    const walletReads = fetchStub.calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/v1/wallet"));
    expect(walletReads).toHaveLength(1);
  });

  it("does not rebuild the grid when a modal opens", async () => {
    stub([]);
    renderPage(<SchedulePage />);
    await screen.findAllByRole("button", { name: /Book this slot for 50\.00 cr/ });

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
});
