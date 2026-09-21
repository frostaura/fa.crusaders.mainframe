import { describe, expect, it, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import MyCodePage from "./MyCode";
import { encodeQr, qrPath } from "../lib/qr";
import {
  memberDoorBookingFixture,
  memberDoorDecisionFixture,
  memberDoorFixture,
  memberDoorNotActiveFixture,
  memberDoorOfflineDecisionFixture,
  memberDoorsOnFixture,
  renderPage,
  stubFetch,
  unreachable,
} from "../test/harness";
import { CLUB_TIME_NOTE } from "../lib/memberDoorCopy";
import { forgetLastKnown, readWalkUpChoice, rememberDoor, rememberQr } from "../lib/lastKnown";
import { GATE_ROSTER_MAX_ENTRIES } from "../lib/gateCopy";

/**
 * The member's court code.
 *
 * <p>
 * The one thing this screen must never get wrong: the QR carries the bare code and
 * nothing else. The court box's scanner pipeline caps an argument at 24 bytes and
 * poisons anything longer — the previous JWT design could not identify anyone at a
 * court, ever. A URL prefix, a JSON wrapper or a tenant slug in the payload would
 * reintroduce that failure while looking like a perfectly good QR on the phone.
 * </p>
 */
describe("MyCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // The walk-up switch is remembered for the SESSION now, and jsdom hands the whole
    // file one `sessionStorage`. Without this, a test that turns the switch on decides
    // which code every later test's first fetch asks for — and the ones that assert an
    // exact `/api/v1/me/qr/generate` path fail against `?kind=ident` with no hint why.
    forgetLastKnown();
  });

  /**
   * Fake timers for the clock-and-rollover tests. fireEvent throughout, never
   * user-event: mixing user-event with fake timers deadlocks under jsdom 28 + vitest 4.
   * `advanceTimersByTimeAsync` yields between timers, which is what lets the stubbed
   * fetch's promise chain settle inside the same act.
   */
  const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  /**
   * Advances a second at a time, the way a real clock does. One long jump processes the
   * timers due inside it but does not always let each fetch's promise chain settle
   * before the next is scheduled, so a chain of re-fetches comes out short by one —
   * an artefact of the jump, not of the page.
   */
  const advanceSeconds = async (seconds: number) => { for (let i = 0; i < seconds; i++) await advance(1_000); };

  /**
   * How many times a CODE was asked for.
   *
   * <p>
   * Not `stub.calls.length`. The stub records every call it is handed, matched or not,
   * and this page now makes a second read of its own — `/api/v1/me/door` — which several
   * of these tests do not stub at all and do not need to. Counting the whole array would
   * make every one of them count a request it is not about. The assertions are unchanged;
   * only what they count is now said precisely.
   * </p>
   */
  const generates = (stub: { calls: { method: string; path: string }[] }) =>
    stub.calls.filter((c) => c.method === "POST" && c.path.startsWith("/api/v1/me/qr/generate")).length;

  const BOOKING = {
    code: "7K3M9XQ2RD5A",
    kind: "booking",
    expires_in_seconds: 900,
    booking_id: "33333333-3333-3333-3333-333333333333",
    court_number: 3,
    starts_at: "2026-09-04T15:00:00+00:00",
  };

  const IDENT = { code: "ZZ9P4T6WQ8HN", kind: "ident", expires_in_seconds: 60 };

  /**
   * The same two codes at a club that has a door gate.
   *
   * <p>
   * `doors`, `door_opens_at` and `door_closes_at` are B6's addition to
   * `/me/qr/generate`, and they exist so this page can tell the truth without reading
   * tenant settings it has no business reading: `doors` is "this club has at least one
   * enabled Gate row", and the two instants are `StartsAt − H` and the code's expiry,
   * where H is the horizon the door itself applies. A member code carries `doors` and
   * two nulls, because there is no booking to bound.
   * </p>
   */
  const BOOKING_WITH_DOORS = {
    ...BOOKING,
    doors: true,
    door_opens_at: "2026-09-04T12:50:00+00:00",
    door_closes_at: "2026-09-04T16:05:00+00:00",
  };

  const IDENT_WITH_DOORS = { ...IDENT, doors: true, door_opens_at: null, door_closes_at: null };

  // --- what a code does at a DOOR ------------------------------------------------
  //
  // Round G3, F1. Until the gate shipped, every sentence on this screen was about a
  // court box, and they were all true. They are not any more: the same twelve
  // characters open the club's front door. A member holding a booking code two hours
  // before their slot had no way to learn from this page whether it would let them into
  // the building — the page said "For your booking only — it works at that court", which
  // now reads as a denial of something the code does.

  it("says a booking code also opens the club door, and from when", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: BOOKING_WITH_DOORS }]);

    renderPage(<MyCodePage />);

    await screen.findByLabelText("Your code");
    // The hour is the viewer's local clock — the same convention the start time above it
    // already uses — so only the shape is pinned, as in the court test.
    expect(screen.getByText(/doors open earlier than its courts do: this code opens the club door from \d{2}:\d{2} until \d{2}:\d{2}\./))
      .toBeInTheDocument();
    // And the court sentence is untouched: a booking code really is refused at every
    // court but its own, whatever it does at a door.
    expect(screen.getByText(/At any other court it will not be recognised/)).toBeInTheDocument();
  });

  /**
   * An API that knows the club has doors but cannot bound the window says only the first
   * half. Printing a clock time this page did not receive would be inventing one.
   */
  it("says shortly after the booking ends when the API sends no closing time", async () => {
    stubFetch([{
      method: "POST",
      path: "/api/v1/me/qr/generate",
      body: { ...BOOKING_WITH_DOORS, door_closes_at: null },
    }]);

    renderPage(<MyCodePage />);

    await screen.findByLabelText("Your code");
    expect(screen.getByText(/opens the club door from \d{2}:\d{2} until shortly after your booking ends\./))
      .toBeInTheDocument();
  });

  /**
   * The member code's arm. This page cannot know the club's door policy — under
   * `active_member` the code opens a door at any hour, under `booking_window` it needs a
   * qualifying booking — so it must not print either. "When the club's door rules allow"
   * is the honest shape of what it does know.
   */
  it("says a member code opens the club door under the club's own rules", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: IDENT_WITH_DOORS }]);

    renderPage(<MyCodePage />);

    await screen.findByLabelText("Your code");
    expect(screen.getByText(/It also opens the club door whenever the club's door rules allow\./))
      .toBeInTheDocument();
    // Not a promise of any hour: that is true only under one of the two policies, and the
    // page is not sent which one is set.
    expect(screen.queryByText(/at any hour/)).toBeNull();
  });

  /**
   * A club with no gate, and an older API that does not send the field at all, are the
   * same case on this screen and must both be silent. Saying "it also opens the club
   * door" to a club that has no door is the defect this round fixed, inverted.
   */
  it.each([
    ["a club with no doors", { ...BOOKING, doors: false, door_opens_at: null, door_closes_at: null }],
    ["an API that does not send the fields", BOOKING],
  ])("says nothing about doors for %s", async (_name, body) => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body }]);

    renderPage(<MyCodePage />);

    await screen.findByLabelText("Your code");
    expect(screen.queryByText(/club door/)).toBeNull();
    expect(screen.queryByText(/lets you in/)).toBeNull();
    // The court sentences are all still there — this is a narrowing, not a replacement.
    expect(screen.getByText(/For your booking only/)).toBeInTheDocument();
    expect(screen.getByText(/switches the lights on and marks you as arrived/)).toBeInTheDocument();
  });

  it.each([
    ["a member code at a club with no doors", { ...IDENT, doors: false }],
    ["a member code from an API that does not send the fields", IDENT],
  ])("says nothing about doors for %s", async (_name, body) => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body }]);

    renderPage(<MyCodePage />);

    await screen.findByLabelText("Your code");
    expect(screen.queryByText(/club door/)).toBeNull();
    expect(screen.getByText(/pay for someone else's time/)).toBeInTheDocument();
  });

  /**
   * The subtitle, which is the sentence at the top of the page and the one a member reads
   * first. It said the code is for "the scanner on the court box" and that it "switches
   * the lights on and marks you as arrived" — the first half sends a member holding it at
   * a door to look for a court box, and the second is FALSE of a door: a gate decision
   * never writes a booking, a CheckedInAt or a ledger row. Opening a door is not
   * attendance, and the subtitle must not imply it is.
   */
  it("tells a member at a door what the code is for, without promising it marks attendance there", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: BOOKING_WITH_DOORS }]);

    renderPage(<MyCodePage />);

    await screen.findByLabelText("Your code");
    const subtitle = screen.getByText(/Show this to the scanner/);
    expect(subtitle).toHaveTextContent("or at the club door");
    // Attendance is claimed for the court and only for the court.
    expect(subtitle).toHaveTextContent("At a court it switches the lights on and marks you as arrived");
    expect(subtitle).toHaveTextContent("at a door it just lets you in");
  });

  /**
   * CLAIM PROBE. The door sentence is a promise about a lock, and three ways of
   * over-promising it are available to anyone editing this copy later.
   *
   * <p>
   * <b>"Always".</b> The window is real but it is not the only condition: the board may be
   * out of service, or cut off with this booking past the 48-entry roster cap. The page
   * cannot enumerate those and should not try — "also opens" claims the window and nothing
   * beyond it, and "always" would claim the rest. (The condition the page CAN be sure of
   * is membership: a barred member is refused a code outright by this very page, so a
   * member holding one is in good standing.)
   * </p>
   *
   * <p>
   * <b>Attendance.</b> A gate decision writes no booking, no `CheckedInAt`, no ledger row.
   * Any word from the court vocabulary — checked in, arrived, lights — landing in a door
   * sentence is the falsehood the admin side spent three rounds removing.
   * </p>
   *
   * <p>
   * <b>A policy the page was never sent.</b> The member arm must name neither hour nor
   * policy: `/me/qr/generate` sends `doors`, not `gate_access_policy`.
   * </p>
   */
  it.each([
    ["a booking code", BOOKING_WITH_DOORS],
    ["a member code", IDENT_WITH_DOORS],
  ])("does not over-promise what the door will do for %s", async (_name, body) => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body }]);

    renderPage(<MyCodePage />);

    await screen.findByLabelText("Your code");
    const said = document.body.textContent ?? "";
    // Located, not assumed: `indexOf` answering -1 would slice the last character of the
    // page and every assertion below would pass over a sentence that is not there.
    const start = said.indexOf("opens the club door");
    expect(start).toBeGreaterThan(-1);
    // To the end of THAT SENTENCE, not to the end of the document. D8 put the page's
    // subtitle below the code card, and the subtitle's court half legitimately says "marks
    // you as arrived" — slicing to the end swept it in and reported the door clause for a
    // phrase twenty lines further down. A probe that fails on the right words in the wrong
    // paragraph stops being read.
    const end = said.indexOf(".", start);
    const door = said.slice(start, end === -1 ? undefined : end + 1);
    expect(door).not.toMatch(/always/i);
    expect(door).not.toMatch(/guarantee/i);
    // The court vocabulary, kept out of the door sentence.
    expect(door).not.toMatch(/marks you as arrived/);
    expect(door).not.toMatch(/checked in/i);
    expect(door).not.toMatch(/lights/i);
    // And no policy this page was never told.
    expect(door).not.toMatch(/good standing/i);
    expect(door).not.toMatch(/any hour/i);
  });

  it("shows a booking code with its court and start time", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: BOOKING }]);

    renderPage(<MyCodePage />);

    // The code itself is printed, because it is short enough to type at the desk.
    expect(await screen.findByLabelText("Your code")).toHaveTextContent("7K3M9XQ2RD5A");
    // What presenting it does, in the member's terms — and which of the two codes this
    // is, because they behave differently at the box and look identical on the phone.
    // The hour is the viewer's local time, so only its shape is pinned here.
    // D4 — the tense follows the clock. `BOOKING`'s slot began in 2026, so "starts" would
    // be the page telling a member their court starts in the past; it said exactly that for
    // the whole of every booking, because the heading only ever knew how to say "starts".
    expect(screen.getByText(/^Booking code · court 3 · on now$/)).toBeInTheDocument();
    expect(screen.getByText(/For your booking only/)).toBeInTheDocument();
    expect(screen.getByText(/At any other court it will not be recognised/)).toBeInTheDocument();
    expect(screen.getByText(/Refreshes in 15m 00s/)).toBeInTheDocument();
  });

  it("encodes the bare code and nothing else", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: BOOKING }]);

    renderPage(<MyCodePage />);

    const svg = await screen.findByRole("img", { name: "QR code 7K3M9XQ2RD5A" });
    // Module-for-module the symbol for the twelve characters alone — not a URL around
    // them, not the booking id, not the tenant. Twelve bytes is a version-1 symbol; the
    // box's scanner has room for 24.
    expect(svg.querySelector("path")?.getAttribute("d")).toBe(qrPath(encodeQr("7K3M9XQ2RD5A")));
  });

  it("says an ident code identifies the member at any court", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: IDENT }]);

    renderPage(<MyCodePage />);

    expect(await screen.findByLabelText("Your code")).toHaveTextContent("ZZ9P4T6WQ8HN");
    expect(screen.getByText("Walk-up code · any court")).toBeInTheDocument();
    expect(screen.getByText(/pay for someone else's time/)).toBeInTheDocument();
    expect(screen.getByText(/Refreshes in 1m 00s/)).toBeInTheDocument();
  });

  /**
   * Review finding 6. The server's default is a booking code whenever a booking is
   * inside the roster window — up to two hours and ten minutes ahead by default, more
   * if the club widens it — and the resolver at the box takes nothing but an ident code
   * for a walk-up. So for the whole run-up to a booking, the member who uses the club
   * most had no path on the phone to a free court or to paying for a friend: the
   * scanner answered SEE THE DESK, and the desk had no idea why.
   */
  it("offers a walk-up code even while a booking code is the one on screen", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: BOOKING, sequence: [BOOKING, IDENT] }]);

    renderPage(<MyCodePage />);
    expect(await screen.findByLabelText("Your code")).toHaveTextContent("7K3M9XQ2RD5A");
    // The default fetch asks for nothing: the server decides.
    expect(stub.calls[0].path).toBe("/api/v1/me/qr/generate");

    fireEvent.click(screen.getByRole("checkbox", { name: /Walk up \/ pay for someone/ }));

    // Asked for outright, not hoped for. `kind=ident` is what makes the answer a
    // walk-up code rather than the booking code the default would hand back again.
    await waitFor(() => {
      expect(stub.calls.some((c) => c.path === "/api/v1/me/qr/generate?kind=ident")).toBe(true);
    });
    expect(await screen.findByLabelText("Your code")).toHaveTextContent("ZZ9P4T6WQ8HN");
    expect(screen.getByText("Walk-up code · any court")).toBeInTheDocument();
    // And the QR carries that code, not the booking one still in the member's memory.
    expect(screen.getByRole("img", { name: "QR code ZZ9P4T6WQ8HN" })).toBeInTheDocument();
  });

  it("goes back to letting the server choose when the walk-up switch is turned off", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: BOOKING, sequence: [BOOKING, IDENT, BOOKING] }]);

    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    const toggle = screen.getByRole("checkbox", { name: /Walk up \/ pay for someone/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Walk-up code · any court")).toBeInTheDocument());
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(stub.calls.filter((c) => c.path === "/api/v1/me/qr/generate")).toHaveLength(2);
    });
    expect(await screen.findByLabelText("Your code")).toHaveTextContent("7K3M9XQ2RD5A");
  });

  it("fetches a fresh code on demand", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: IDENT }]);

    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

    await waitFor(() => {
      expect(stub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/me/qr/generate")).toHaveLength(2);
    });
  });

  /**
   * The rotate case. This is real only because the server now mints a fresh ident code
   * when the current one has less than the pre-fetch lead left — before that,
   * `MintIdentAsync` reused the unexpired code and this test stubbed behaviour the
   * backend suite pinned as not happening (review finding 21). The reuse case is the
   * test below, and both have to hold: the server may legitimately answer either way.
   */
  it("fetches the next code before this one dies and swaps it in without a gap", async () => {
    fakeClock();
    const NEXT = { code: "8H2R5V7XM3KP", kind: "ident", expires_in_seconds: 60 };
    const stub = stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: IDENT, sequence: [IDENT, NEXT] }]);
    const generates = () => stub.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/me/qr/generate").length;

    renderPage(<MyCodePage />);
    await advance(0);
    expect(screen.getByLabelText("Your code")).toHaveTextContent("ZZ9P4T6WQ8HN");
    expect(screen.getByText(/Refreshes in 1m 00s/)).toBeInTheDocument();

    // 49 s in: still the first code, still one call. The rollover used to happen
    // only AFTER expiry, leaving the member holding a dead QR for the ~10 s the
    // paced re-fetch took.
    await advance(49_000);
    expect(generates()).toBe(1);
    expect(screen.getByLabelText("Your code")).toHaveTextContent("ZZ9P4T6WQ8HN");
    expect(screen.getByText(/Refreshes in 11s/)).toBeInTheDocument();

    // Ten seconds out, the next code is fetched and swapped in at once. The old one
    // never reaches zero on screen — no "Expired", no dimmed QR. (The second advance
    // is the zero-delay timer the tick's effect schedules; effects flush as the act ends.)
    await advance(1_000);
    await advance(0);
    expect(generates()).toBe(2);
    expect(screen.getByLabelText("Your code")).toHaveTextContent("8H2R5V7XM3KP");
    expect(screen.getByRole("img", { name: "QR code 8H2R5V7XM3KP" })).toBeInTheDocument();
    expect(screen.getByText(/Refreshes in 1m 00s/)).toBeInTheDocument();
    expect(screen.queryByText(/Expired/)).not.toBeInTheDocument();

    // And the new code is not itself pre-fetched until IT is ten seconds out: one
    // call per code, not a storm.
    await advance(40_000);
    expect(generates()).toBe(2);
  });

  /**
   * Review finding 21. A pre-fetch that comes back with the code already on screen has
   * rotated nothing — and the page used to record it as done, so the member watched the
   * QR count to zero, dim to "Expired", and only then wait out the ten-second pacing
   * gap before anything was fetched again. A scan in that window is NOT RECOGNISED.
   * Ten seconds is longer than the code has left by definition, so the answer is to
   * re-poll on a short gap instead — bounded, because a server that will not rotate
   * must not be hammered.
   */
  it("treats a server that hands back the same code as not rotated, and re-polls without the pacing gap", async () => {
    fakeClock();
    const REUSED = { ...IDENT, expires_in_seconds: 9 };
    const NEXT = { code: "8H2R5V7XM3KP", kind: "ident", expires_in_seconds: 60 };
    const stub = stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: IDENT, sequence: [IDENT, REUSED, NEXT] }]);
    const generates = () => stub.calls.filter((c) => c.method === "POST").length;

    renderPage(<MyCodePage />);
    await advance(0);
    expect(generates()).toBe(1);

    // Ten seconds out the pre-fetch fires, and the server answers with the code the
    // page is already holding — the whole of what the pre-fetch achieved before this
    // fix was one extra request per code.
    await advance(50_000);
    await advance(0);
    expect(generates()).toBe(2);
    expect(screen.getByLabelText("Your code")).toHaveTextContent("ZZ9P4T6WQ8HN");

    // Not two seconds later: still nothing, because the short gap has not elapsed.
    await advance(1_500);
    expect(generates()).toBe(2);

    // On the short gap, not the ten-second one, and the code that finally arrives is
    // swapped in before the old one ever reaches zero.
    await advance(1_000);
    await advance(0);
    expect(generates()).toBe(3);
    expect(screen.getByLabelText("Your code")).toHaveTextContent("8H2R5V7XM3KP");
    expect(screen.queryByText(/Expired/)).not.toBeInTheDocument();
  });

  it("gives up chasing a server that will not rotate, rather than re-polling forever", async () => {
    fakeClock();
    // Every answer after the first is the code already held, with what it really has
    // left: a server that reuses and will keep reusing.
    const stub = stubFetch([{
      method: "POST",
      path: "/api/v1/me/qr/generate",
      body: IDENT,
      sequence: [IDENT, { ...IDENT, expires_in_seconds: 9 }],
    }]);
    const generates = () => stub.calls.filter((c) => c.method === "POST").length;

    renderPage(<MyCodePage />);
    await advance(0);

    // Ten seconds out: the pre-fetch, answered with the same code.
    await advance(50_000);
    await advance(0);
    expect(generates()).toBe(2);

    // Three re-polls, two seconds apart — and then it stops. The endpoint sits in the
    // auth bucket, shared with login; a server that will never rotate must cost a
    // handful of requests per code, not one every two seconds until the page is closed.
    await advanceSeconds(7);
    expect(generates()).toBe(5);

    await advanceSeconds(3);
    expect(generates()).toBe(5);
  });

  it("reads the countdown off the clock, so a phone that slept shows the true time left on wake", async () => {
    fakeClock();
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: IDENT }]);

    renderPage(<MyCodePage />);
    await advance(0);
    expect(screen.getByText(/Refreshes in 1m 00s/)).toBeInTheDocument();

    // The clock moves 35 s with no timer firing — a locked phone. A tick-based
    // countdown would still say 1m 00s over a code with 25 s left.
    vi.setSystemTime(Date.now() + 35_000);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(screen.getByText(/Refreshes in 25s/)).toBeInTheDocument();
  });

  it("paces the automatic re-fetch so a code that arrives already dead cannot become a request storm", async () => {
    fakeClock();
    const DEAD = { code: "ZZ9P4T6WQ8HN", kind: "ident", expires_in_seconds: 0 };
    const stub = stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: DEAD }]);
    const generates = () => stub.calls.filter((c) => c.method === "POST").length;

    renderPage(<MyCodePage />);
    await advance(0);
    expect(screen.getByText(/This code has run out/)).toBeInTheDocument();

    // Nothing for nine seconds; one more call on the tenth. The auth bucket this
    // endpoint sits in is shared with login.
    await advance(9_000);
    expect(generates()).toBe(1);
    await advance(1_000);
    expect(generates()).toBe(2);
    await advance(10_000);
    expect(generates()).toBe(3);
  });

  it("says so when a code cannot be fetched, and offers to try again", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", status: 500, body: { error: "boom" } }]);

    renderPage(<MyCodePage />);

    expect(await screen.findByText(/Couldn't get a code/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });

  /**
   * The screen must not promise what the box will refuse.
   *
   * <p>
   * Round 7 made a barred member's code inert at every box, so no money moves — and left
   * this screen saying the code will "start a walk-up on a free court, or pay for someone
   * else's time", with a switch inviting them to ask for exactly that. The member's only
   * way to discover otherwise was to stand at a court and read SEE THE DESK.
   * </p>
   *
   * <p>
   * So: the reason, in a sentence, and nothing else on the page — no QR, no code, no
   * countdown, no Refresh, and above all no walk-up switch. A code that cannot be used is
   * not a smaller version of a code that can.
   * </p>
   */
  it.each([
    ["member_suspended", /membership is suspended/i, /restored/i],
    ["member_not_active", /isn't active yet/i, /approve/i],
  ])("shows no code and no walk-up offer to a member the club has barred (%s)", async (code, sentence, nextStep) => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", status: 403, body: { error: code } }]);

    renderPage(<MyCodePage />);

    // The refusal, announced — a member who was holding a code a moment ago needs to be
    // told, not left to notice the QR has gone.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(sentence);
    expect(alert).toHaveTextContent(nextStep);
    // Never the raw token. The whole reason the backend guard could not ship alone.
    expect(document.body.textContent).not.toContain(code);

    // Nothing that offers the member a code, or implies one is coming.
    expect(screen.queryByLabelText("Your code")).toBeNull();
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    expect(screen.queryByLabelText("Walk up / pay for someone")).toBeNull();
    expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    expect(screen.queryByText(/start a walk-up on a free court/)).toBeNull();
    expect(screen.queryByText(/switches the lights on/)).toBeNull();
    expect(screen.queryByText(/Refreshes in/)).toBeNull();
    // And not the generic connection sentence, which would send them to their WiFi
    // settings over a decision the club took.
    expect(screen.queryByText(/Check your connection/)).toBeNull();

    // The one thing the card DOES offer: a way to ask again once the desk has acted. It
    // is not a Refresh — there is no code on screen to refresh — and the sentence beside
    // it has to say what it is for, or a member reads it as "try your luck".
    expect(screen.getByRole("button", { name: /Check again/ })).toBeEnabled();
    expect(screen.getByText(/If the desk has just sorted it out, check again/)).toBeInTheDocument();
  });

  /**
   * The dead end, closed. This state used to be terminal for the life of the tab.
   *
   * <p>
   * Dropping the code on a refusal also stops the only effect that ever re-fetches — its
   * first guard is `if (!qr …) return` — so with no control on the card there was nothing
   * left in the page that could ever ask again. Driven live in round 8: after the club
   * restored the member to Active with the tab open, the page sat on the suspension
   * sentence for ninety seconds and made ZERO further calls; only a reload brought the code
   * back. A member standing at a court whose suspension has just been lifted at the desk
   * had no control on screen at all.
   * </p>
   *
   * <p>
   * Both halves are asserted, because either alone is still a dead end: the button has to
   * make the call, and a successful call has to clear the refusal card rather than fetch a
   * perfectly good code underneath a page still saying the member is suspended.
   * </p>
   */
  it("lets a member whose suspension was just lifted get their code back without reloading", async () => {
    const stub = stubFetch([{
      method: "POST",
      path: "/api/v1/me/qr/generate",
      // `body` is ignored while `sequence` is set; the route type still wants one.
      body: {},
      status: [403, 200],
      sequence: [{ error: "member_suspended" }, IDENT],
    }]);

    renderPage(<MyCodePage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/membership is suspended/i);
    expect(generates(stub)).toBe(1);

    // The club puts it right at the desk. The member presses the only control they have.
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));

    expect(await screen.findByLabelText("Your code")).toHaveTextContent("ZZ9P4T6WQ8HN");
    expect(generates(stub)).toBe(2);
    // The refusal is gone, not sitting behind the code.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/membership is suspended/i)).toBeNull();
    // And the whole page is back, walk-up switch and all.
    expect(screen.getByRole("checkbox", { name: /Walk up \/ pay for someone/ })).toBeInTheDocument();
  });

  /**
   * Still barred: the card stays, and the member is not told to check their WiFi over a
   * decision the club took. The reason is re-read from the fresh refusal rather than left
   * as the stale one, so a member who was suspended and is now merely not-yet-approved
   * reads the sentence that is true now.
   */
  it("keeps the refusal card, and its reason current, when checking again is refused again", async () => {
    const stub = stubFetch([{
      method: "POST",
      path: "/api/v1/me/qr/generate",
      // `body` is ignored while `sequence` is set; the route type still wants one.
      body: {},
      status: 403,
      sequence: [{ error: "member_suspended" }, { error: "member_not_active" }],
    }]);

    renderPage(<MyCodePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/membership is suspended/i);

    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));

    await waitFor(() => expect(generates(stub)).toBe(2));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/isn't active yet/i));
    expect(screen.queryByLabelText("Your code")).toBeNull();
    expect(screen.queryByText(/Check your connection/)).toBeNull();
    expect(screen.getByRole("button", { name: /Check again/ })).toBeInTheDocument();
  });

  /**
   * A bad minute on the network while barred is a different thing from the bar, and the
   * card has to say so rather than swallow it — otherwise pressing the button appears to
   * do nothing at all, which is the dead end again wearing a button.
   */
  it("says so when checking again fails on the network, and keeps the refusal", async () => {
    stubFetch([{
      method: "POST",
      path: "/api/v1/me/qr/generate",
      // `body` is ignored while `sequence` is set; the route type still wants one.
      body: {},
      status: [403, 500],
      sequence: [{ error: "member_suspended" }, { error: "boom" }],
    }]);

    renderPage(<MyCodePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/membership is suspended/i);

    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));

    expect(await screen.findByText(/Couldn't get a code/)).toBeInTheDocument();
    // The club's decision still stands and still reads as the club's decision.
    expect(screen.getByRole("alert")).toHaveTextContent(/membership is suspended/i);
    expect(screen.queryByLabelText("Your code")).toBeNull();
  });

  /**
   * Suspended between two codes. The pre-fetch is silent about every other failure —
   * a dropped request is left for the expiry path — but a member holding a live QR when
   * the desk suspends them must not go on holding it.
   */
  it("drops the code already on screen when the club bars the member mid-session", async () => {
    fakeClock();
    const stub = stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: IDENT, sequence: [IDENT] },
    ]);
    renderPage(<MyCodePage />);
    await advance(0);
    expect(screen.getByLabelText("Your code")).toHaveTextContent("ZZ9P4T6WQ8HN");

    // The next answer is the refusal. Re-stubbing rather than sequencing, because the
    // status changes and `sequence` carries bodies only.
    stub.calls.length = 0;
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", status: 403, body: { error: "member_suspended" } }]);

    // Fifty seconds in, the silent pre-fetch fires — the path that used to swallow this.
    await advanceSeconds(51);
    await advance(0);

    expect(screen.queryByLabelText("Your code")).toBeNull();
    expect(screen.queryByLabelText("Walk up / pay for someone")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(/membership is suspended/i);
  });

  /**
   * The rate limit, said in the words of the screen it lands on.
   *
   * <p>
   * `/me/qr/generate` sits behind the auth rate-limit bucket, which is shared with login,
   * and the barred card's button has no pacing guard of its own — so a member pressing
   * "Check again" while the desk sorts out their membership is exactly who reaches a 429.
   * Making the error line reachable on this card made that branch reachable with it, and
   * its sentence was "Too many refreshes. Give it a moment and try again." on a card that
   * shows no code to refresh. "shows no code and no walk-up offer to a member the club has
   * barred" already asserts no control named Refresh exists on that card — but only in the
   * first-render state, which the 429 branch is not. So the wording and the absence are
   * re-asserted here together.
   * </p>
   *
   * <p>
   * Both halves are asserted, because either alone would pass on the defect: the sentence
   * this card should say, and the absence of the one that belongs to the code card.
   * </p>
   */
  it("names the control it has when checking again is rate-limited, and never offers a refresh", async () => {
    stubFetch([{
      method: "POST",
      path: "/api/v1/me/qr/generate",
      // `body` is ignored while `sequence` is set; the route type still wants one.
      body: {},
      status: [403, 429],
      sequence: [{ error: "member_suspended" }, { error: "rate_limited" }],
    }]);

    renderPage(<MyCodePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/membership is suspended/i);

    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));

    expect(await screen.findByText(/That's a lot of checking at once/)).toBeInTheDocument();
    expect(screen.getByText(/Give it a moment, then check again/)).toBeInTheDocument();
    // The code card's sentence, on a card with no code and no Refresh.
    expect(screen.queryByText(/Too many refreshes/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
    // Still a network failure, not the club changing its mind.
    expect(screen.getByRole("alert")).toHaveTextContent(/membership is suspended/i);
  });

  /**
   * The code card keeps its own sentence. The fix above splits one string into two, so the
   * half that was already right has to be held in place as well.
   */
  it("still says too many refreshes when the code card's own Refresh is rate-limited", async () => {
    stubFetch([{
      method: "POST",
      path: "/api/v1/me/qr/generate",
      body: {},
      status: [200, 429],
      sequence: [IDENT, { error: "rate_limited" }],
    }]);

    renderPage(<MyCodePage />);
    expect(await screen.findByLabelText("Your code")).toHaveTextContent("ZZ9P4T6WQ8HN");

    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

    expect(await screen.findByText(/Too many refreshes/)).toBeInTheDocument();
    expect(screen.queryByText(/lot of checking at once/)).toBeNull();
  });
});

/**
 * The same page, at a club that has a door.
 *
 * <p>
 * Everything above this line is about a court box and none of it changes. What follows
 * is the other half of what these twelve characters do: let the holder into the
 * building. The person every case here is settled by is a member outside a locked door
 * at 06:00, in the dark, one hand on the phone, one bar of signal, with nobody to ask.
 * </p>
 *
 * <p>
 * The wave-1 wire shape is thinner than the design assumed — no `is_club_admin`, no
 * `early_entry_minutes`, no `offline` flag on a decision, no `opens_at` — so these tests
 * are written to what the server actually sends. Where a sentence would have carried a
 * number the response does not include, the assertion is that the page does not invent
 * one.
 * </p>
 */
describe("MyCode at a club with a door", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    forgetLastKnown();
  });

  const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  /**
   * A second at a time, the way a real clock does. One long jump processes the timers due
   * inside it but does not always let each fetch's promise chain settle before the next is
   * scheduled, so a chain of re-fetches comes out short by one — an artefact of the jump
   * rather than of the page. The sibling of the helper in the first describe.
   */
  const advanceSecondsHere = async (seconds: number) => { for (let i = 0; i < seconds; i++) await advance(1_000); };

  const CODE = {
    code: "7K3M9XQ2RD5A",
    kind: "booking",
    expires_in_seconds: 900,
    court_number: 3,
    starts_at: "2026-09-19T17:00:00Z",
    doors: true,
    door_opens_at: "2026-09-19T16:30:00Z",
    door_closes_at: "2026-09-19T18:05:00Z",
  };

  const IDENT_CODE = { code: "ZZ9P4T6WQ8HN", kind: "ident", expires_in_seconds: 60, doors: true };

  const BOOKING = memberDoorBookingFixture();

  /** Renders with both reads answered. `door` is the whole `/me/door` document. */
  /** `GET /me/door/history` with nothing in it — what the self-check reads by default. */
  const EMPTY_HISTORY = {
    items: [], next_cursor: null, retention_days: 90, timezone: "Africa/Johannesburg",
  };

  function renderBoth(door: Record<string, unknown>, code: Record<string, unknown> = CODE) {
    const stub = stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: code },
      { path: "/api/v1/me/door", body: door },
      // E-H2 (2) — the self-check reads the club's own record when the member presses the
      // button. Stubbed EMPTY by default, and stubbed at all deliberately: `/me/door` is a
      // prefix of `/me/door/history`, so without a route of its own the history request was
      // answered with the door object and the page spread an `items` that was not there.
      { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
    ]);
    renderPage(<MyCodePage />);
    return stub;
  }

  // --- doors: false is SILENCE, not a smaller version of the door page ----------------

  /**
   * The silent half, and the one that is easiest to break by adding a block and
   * forgetting its guard. A club with no gate must not meet the word at all — not in a
   * standing line, not in a control, not in a footer.
   */
  it("says nothing whatever about doors at a club that has none", async () => {
    renderBoth(memberDoorFixture(), { ...CODE, doors: false, door_opens_at: null, door_closes_at: null });

    await screen.findByLabelText("Your code");
    await waitFor(() => expect(screen.queryByText(/Getting your code/)).toBeNull());
    expect(document.body.textContent).not.toMatch(/door/i);
    expect(screen.queryByRole("button", { name: "The door didn't open" })).toBeNull();
  });

  /**
   * Whose clock, on the card that prints clocks. The history list said so and this did not,
   * on the same screen and in the same zone — a member travelling, or on a phone that
   * guessed its zone wrong, had no way to tell which day "starts 19:00" belonged to.
   */
  it("says whose clock the code card's times are, where it shows one", async () => {
    renderBoth(
      memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }),
      // A court still ahead of the member, which is the case that prints a clock: a slot
      // already under way reads "on now" and names an hour only if the fixture carries an
      // end, and this is about the card that shows one rather than about which it is.
      { ...CODE, starts_at: "2099-01-01T17:00:00Z" },
    );

    const card = (await screen.findByLabelText("Your code")).closest("div.rounded-lg")!;
    // The precondition, asserted rather than assumed: a note about which clock these are
    // means nothing unless a clock is on the card.
    expect(card.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(card.textContent).toContain(CLUB_TIME_NOTE);
  });

  /**
   * And not on a card with no time on it. A note about which zone the times are in, on a
   * card showing no time, is a sentence a member has to read and discard.
   */
  it("says nothing about clocks on a card that shows none", async () => {
    renderBoth(memberDoorFixture(), { ...IDENT_CODE, doors: false });

    const card = (await screen.findByLabelText("Your code")).closest("div.rounded-lg")!;
    expect(card.textContent).not.toMatch(/\d{1,2}:\d{2}/);
    expect(card.textContent).not.toContain(CLUB_TIME_NOTE);
  });

  // --- W1.7a, the standing line ---------------------------------------------------------

  it("names the booking and the hour the door starts opening, under the booking-window rule", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }));

    expect(await screen.findByText("What opens the door for you right now")).toBeInTheDocument();
    expect(screen.getByText(/the door opens for you (from|now)/)).toBeInTheDocument();
  });

  it("states the active-member rule with no clock time for a door", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "active_member", membership: "active" }));

    const line = await screen.findByText(/Your club opens its doors for any active member/);
    expect(line).toHaveTextContent(/Yours is active/);
    expect(line.textContent).not.toMatch(/\d{2}:\d{2}/);
  });

  /**
   * The de-duplication rule. `describeDoor()` and the standing line are fed by different
   * requests and say the same thing with different confidence; rendered together they are
   * a screen stating one fact twice, the second time more vaguely.
   */
  it("states the door window exactly once when both sources have it", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }));

    await screen.findByLabelText("Your code");
    await waitFor(() => expect(screen.getByText("What opens the door for you right now")).toBeInTheDocument());
    const said = document.body.textContent ?? "";
    expect(said.split("It also opens the club door from")).toHaveLength(1);
  });

  /**
   * The screen must not argue with itself, which is the whole reason one response carries
   * both blocks.
   *
   * <p>
   * Found by looking at the rendered page, not by reading the design: a member the club
   * has as not active read "no code of yours opens a door until they change that" with
   * "It also opens the club door from 20:54 until 22:29." a centimetre above it, because
   * the suppression rule keyed on the standing line having a CLOCK WINDOW and this arm
   * has none. The rule is the contradiction, not the duplication.
   * </p>
   */
  it("never promises a door window over a sentence saying no door will open", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "booking_window", membership: "not_active", next_booking: BOOKING }));

    await screen.findByText(/no code of yours opens a door until they change that/);
    expect(screen.queryByText(/It also opens the club door/)).toBeNull();
  });

  it("says the same for a member with nothing booked, whose code claims the club's rules allow it", async () => {
    renderBoth(
      memberDoorsOnFixture({ policy: "booking_window", membership: "active", next_booking: null }),
      { code: "ZZ9P4T6WQ8HN", kind: "ident", expires_in_seconds: 60, doors: true },
    );

    await screen.findByText(/a door won't open for you/);
    expect(screen.queryByText(/It also opens the club door/)).toBeNull();
  });

  /**
   * And the arm where the clause EARNS its place: the active-member line carries no clock
   * time at all, so deleting the code card's would leave the member without one.
   */
  it("keeps the code's own door window when the standing line has no clock of its own", async () => {
    // A MEMBER code on screen: the standing line has no clock, the code has no window of
    // its own, and the code card's clause is the only place the rule can be stated at all.
    renderBoth(
      memberDoorsOnFixture({ policy: "active_member", membership: "active", next_booking: null }),
      IDENT_CODE,
    );

    await screen.findByText(/Your club opens its doors for any active member/);
    expect(screen.getByText(/It also opens the club door whenever the club's door rules allow/))
      .toBeInTheDocument();
  });

  /**
   * E-H2 (1), D5 — the same club with a BOOKING code on screen, which is the case that put
   * two sentences on the page arguing with each other.
   *
   * <p>
   * "A live code of yours opens the club door" sat directly above "this code opens the club
   * door from 08:05 until 10:50", with nothing to say the first was about the member's OTHER
   * code. One sentence now, in the standing section, naming which code it is about — so the
   * code card's vaguer copy of it is suppressed rather than printed a centimetre away.
   * </p>
   */
  it("says which code the window belongs to when a booking code is the one on screen", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "active_member", membership: "active", next_booking: null }));

    expect(await screen.findByText(/The booking code on screen is bounded by its own window/))
      .toHaveTextContent(/whatever rule a club applies/);
    // And the code card's own clause is gone, because it would be a second, vaguer copy.
    expect(screen.queryByText(/doors open earlier than its courts do/)).toBeNull();
    // With the offer to switch, which is what a member holding the wrong code needs.
    expect(screen.getAllByRole("button", { name: "Use your member code instead" }).length).toBeGreaterThan(0);
  });

  /**
   * And the other half of that rule, which is why it is a suppression rather than a
   * deletion: `/me/qr/generate` is a different request and survives a `/me/door` that did
   * not. The fallback sentence comes back, and the page says plainly that it could not
   * check the rest.
   */
  it("falls back to the code's own door sentence when the door read failed", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
      { path: "/api/v1/me/door", status: 500, body: { error: "boom" } },
    ]);
    renderPage(<MyCodePage />);

    await screen.findByLabelText("Your code");
    expect(await screen.findByText(/can't check/)).toBeInTheDocument();
    expect(screen.getByText(/doors open earlier than its courts do: this code opens the club door from \d{2}:\d{2} until \d{2}:\d{2}\./)).toBeInTheDocument();
  });

  /**
   * A cached sentence rendered as though it were fresh is worse than no sentence: a
   * screen telling a member what their club's doors need, from a reading that may be
   * hours old, with nothing to say so.
   */
  it("says how old the door facts are when it is serving them from the last good read", async () => {
    rememberDoor(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }) as never);
    stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
      { path: "/api/v1/me/door", status: 500, body: { error: "boom" } },
    ]);
    renderPage(<MyCodePage />);

    const said = await screen.findByText(/ago it said/);
    // A 500 from the club: the cached sentence still travels with its age, but the lead
    // names the club's system rather than this member's phone.
    expect(said).toHaveTextContent(/answered with an error/);
    expect(said).toHaveTextContent(/a court booked/);
    expect(said).toHaveTextContent(/That may have changed since/);
  });

  /**
   * The offline half, served from the cache, still carries the CLUB's cap.
   *
   * <p>
   * The one reading where getting it wrong matters most: this sentence is about what
   * happens when a door is cut off, and it is being shown to somebody whose phone is cut
   * off too. Falling back to the shared constant here would print 48 at a club whose
   * boards hold twelve — which is the page guessing on the one screen where it has a
   * stored answer and a member has no way to check.
   * </p>
   */
  it("keeps the club's own roster cap when the standing line comes from the cache", async () => {
    rememberDoor(memberDoorsOnFixture({
      policy: "booking_window", next_booking: BOOKING, roster_max_entries: 12,
    }) as never);
    stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
      { path: "/api/v1/me/door", status: 500, body: { error: "boom" } },
    ]);
    renderPage(<MyCodePage />);

    const summary = await screen.findByText("What if the door is offline?");
    fireEvent.click(summary);
    const body = screen.getByText(/decides from a list of bookings/);
    expect(body).toHaveTextContent(/next 12 bookings/);
    expect(body).not.toHaveTextContent(new RegExp(`first ${GATE_ROSTER_MAX_ENTRIES} bookings`));
  });

  /** And with nothing cached, a different sentence — three silences, three sentences. */
  it("says it cannot tell the member anything when there is no cached copy either", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
      { path: "/api/v1/me/door", status: 500, body: { error: "boom" } },
    ]);
    renderPage(<MyCodePage />);

    const said = await screen.findByText(/can't tell you what its doors need/);
    expect(said.textContent).not.toMatch(/ago it said/);
  });

  it("states the offline half of the conditional, with the roster cap it was given", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }));

    const summary = await screen.findByText("What if the door is offline?");
    fireEvent.click(summary);
    const body = screen.getByText(/decides from a list of bookings/);
    expect(body).toHaveTextContent(String(GATE_ROSTER_MAX_ENTRIES));
    expect(body).toHaveTextContent(/bookings/);
    expect(body.textContent).not.toMatch(/lockdown|attendance/i);
  });

  // --- W1.7b, the decision card -----------------------------------------------------------

  it("tells a member the club has their membership as not active, and gives them the number", async () => {
    renderBoth(memberDoorsOnFixture({
      membership: "not_active",
      last_decision: memberDoorDecisionFixture({ reason: "member_not_active" }),
    }));

    // ONE match. The visible line and the screen-reader twin are only split when they
    // DIFFER — which is when a countdown is ticking in one of them. On an arm with no
    // countdown, two copies inside an atomic live region is the sentence read out twice.
    expect((await screen.findAllByText(/The club has your membership as not active\./)).length).toBe(1);
    // D6 appended the age to the stamp.
    expect(screen.getByText(/^front-door · \d{2}:\d{2} · just now$/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Call the club" })[0]).toHaveAttribute("href", "tel:0215550134");
  });

  /**
   * `too_early` is a clock fact, not a fault. The contract says it in as many words: no
   * error styling. So the card carries an `info` tone, and NOTHING in it is a `danger`
   * class or an assertive alert.
   */
  it("counts a too-early member down without dressing it as an error", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:02:48Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      next_booking: BOOKING,
      last_decision: memberDoorDecisionFixture({ at: "2026-09-19T16:02:00Z", reason: "too_early" }),
    }));
    await advance(0);

    const card = screen.getByRole("status");
    expect(card).toHaveTextContent(/Too early — the door opens for you in 27m 12s\./);
    expect(card.querySelector(".text-danger-strong")).toBeNull();
    expect(card.querySelector("[role='alert']")).toBeNull();
    // The CHROME as well as the text. A calm sentence inside a red rule still reads as a
    // fault from two metres away, which is the whole of what "no error styling" means.
    expect(card.className).toContain("border-info-strong");
    expect(card.className).not.toContain("danger");

    // It counts DOWN, off the clock, not up from a tick counter.
    await advance(5_000);
    expect(card).toHaveTextContent(/27m 07s/);
  });

  it("says the door opens now when the window arrives, and does not change tone", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:29:58Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      next_booking: BOOKING,
      last_decision: memberDoorDecisionFixture({ at: "2026-09-19T16:29:00Z", reason: "too_early" }),
    }));
    await advance(0);
    await advance(3_000);

    const card = screen.getByRole("status");
    expect(card).toHaveTextContent(/The door opens for you now\./);
    expect(card.querySelector(".text-danger-strong")).toBeNull();
  });

  /**
   * Both sources of a countdown absent at once: no `opens_at` on the decision, and no
   * booking in the same document. That is what the endpoint sends when the booking behind
   * the refusal has since been cancelled — `TooEarlyOpensAtAsync` returns null — and the
   * card says so rather than counting down to a time nobody sent.
   */
  it("states too early with no countdown when the server sent no window", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      next_booking: null,
      last_decision: memberDoorDecisionFixture({ reason: "too_early" }),
    }));

    const card = await screen.findByRole("status");
    expect(card).toHaveTextContent(/Too early — the door hadn't opened for you yet\./);
    expect(card.textContent).not.toMatch(/\d+m \d+s/);
  });

  it("offers a court to book when the door wanted one", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      last_decision: memberDoorDecisionFixture({ reason: "no_booking" }),
    }));

    const book = await screen.findByRole("link", { name: "Book a court" });
    expect(book).toHaveAttribute("href", "/schedule");
  });

  /**
   * The dead-code arm, and the two things it must not do: say "no refusals found", and
   * make the member ask for the fresh code the page can fetch on its own.
   */
  it("fetches a fresh code by itself when the door said the last one was not live", async () => {
    const stub = renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ reason: "not_recognised" }),
    }));

    // One match, for the reason the not-active test above carries in full: the split is
    // a countdown affordance, and this arm has no countdown.
    expect((await screen.findAllByText(/That code wasn't live any more\./)).length).toBe(1);
    await waitFor(() => {
      expect(stub.calls.filter((c) => c.method === "POST" && c.path.startsWith("/api/v1/me/qr/generate")).length)
        .toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByRole("button", { name: "Refresh the code" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/no refusal|nothing to show|no recent/i);
  });

  /**
   * D7. It said "a door the club hasn't named yet", which is an admin fact a member
   * cannot act on — and which contradicted the same member's own history, where a named
   * door's offline rows were arriving with the name stripped and being labelled the same
   * way beside releases the offline disclosure says such a door cannot make.
   */
  it("calls a door this response carried no name for a club door", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ door_name: null, reason: "no_booking" }),
    }));

    expect(await screen.findByText(/^a club door · \d{2}:\d{2} · just now$/)).toBeInTheDocument();
    expect(screen.queryByText(/hasn't named/i)).toBeNull();
  });

  /** The claim probe, on the card that is most tempting to over-promise. */
  it("makes no claim about a door moving, or about anyone arriving", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ reason: "ok", released: true }),
    }));

    const card = await screen.findByRole("status");
    const said = card.textContent ?? "";
    expect(said).toMatch(/lock released/i);
    for (const banned of ["attendance", "checked in", "marks you as arrived", "lights", "relay", "lockdown"]) {
      expect(said.toLowerCase()).not.toContain(banned);
    }
  });

  /**
   * The a11y contract, which is done once or done wrong. The visible digits change every
   * second; a live region that reads them is a screen reader talking over a member's own
   * thoughts for as long as they stand there.
   */
  it("hides the ticking digits from the accessibility tree and speaks in whole minutes", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:02:48Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      next_booking: BOOKING,
      last_decision: memberDoorDecisionFixture({ at: "2026-09-19T16:02:00Z", reason: "too_early" }),
    }));
    await advance(0);

    const card = screen.getByRole("status");
    expect(card).toHaveAttribute("aria-live", "polite");
    const ticking = screen.getByText(/27m 12s/);
    expect(ticking).toHaveAttribute("aria-hidden", "true");
    expect(card.querySelector(".sr-only")?.textContent).toMatch(/27 minutes/);
    expect(document.querySelector("[aria-live='assertive']")).toBeNull();
  });

  /**
   * Two minutes is the SERVER's fetch window, not a display window.
   *
   * <p>
   * The poll is DRIVEN here rather than assumed: the second answer has the row gone —
   * which is what the endpoint does after 120 seconds — and the card must still be on
   * screen, because one that vanishes mid-sentence while a cold member reads it is the
   * defect this rule exists to prevent. Only the member, or a newer decision, takes it
   * away.
   * </p>
   */
  it("keeps the card when the server stops sending the row, and drops it when the member says so", async () => {
    fakeClock();
    const first = memberDoorDecisionFixture({ at: "2026-09-19T06:04:00Z", reason: "no_booking" });
    const stub = stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
      {
        path: "/api/v1/me/door",
        body: {},
        sequence: [
          memberDoorsOnFixture({ last_decision: first }),
          memberDoorsOnFixture({ last_decision: null }),
        ],
      },
    ]);
    renderPage(<MyCodePage />);
    await advance(0);

    expect(screen.getByRole("status")).toHaveTextContent(/The door needs a court booked\./);

    // The next poll lands, and the row is gone from the response.
    await advance(6_000);
    expect(stub.calls.filter((c) => c.method === "GET" && c.path === "/api/v1/me/door").length)
      .toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("status")).toHaveTextContent(/The door needs a court booked\./);

    // The member's own Dismiss does take it away — and a later poll does not hand it
    // straight back, which is the other half of the same rule.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await advance(0);
    expect(screen.queryByRole("status")).toBeNull();
    await advance(31_000);
    expect(screen.queryByRole("status")).toBeNull();
  });

  /**
   * A3.1: the control is PERMANENT, not something a refusal reveals. The commonest
   * refusal of all — an unknown or malformed token — names nobody and can therefore never
   * arrive by polling, so a member who has just been refused still needs the way in.
   */
  it("keeps the way in on screen even while a refusal card is showing", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ reason: "no_booking" }),
    }));

    await screen.findByRole("status");
    expect(screen.getByRole("button", { name: "The door didn't open" })).toBeEnabled();
  });

  it("shows nothing at all when the member has no decision, and still offers the way in", async () => {
    renderBoth(memberDoorsOnFixture({ last_decision: null }));

    await screen.findByLabelText("Your code");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "The door didn't open" })).toBeEnabled();
    expect(document.body.textContent).not.toMatch(/no refusal|nothing to show|no recent/i);
  });

  // --- W1.7b, the self-diagnosis -----------------------------------------------------------

  it("forces both reads and asks six questions", async () => {
    const stub = renderBoth(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }));
    await screen.findByLabelText("Your code");
    const before = stub.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));

    await waitFor(() => expect(screen.getByRole("group", { name: /work out why/i })).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());
    const after = stub.calls.slice(before);
    expect(after.some((c) => c.method === "GET" && c.path === "/api/v1/me/door")).toBe(true);
    expect(after.some((c) => c.method === "POST" && c.path.startsWith("/api/v1/me/qr/generate"))).toBe(true);
    expect(screen.getByRole("group", { name: /work out why/i }).querySelectorAll("li")).toHaveLength(6);
  });

  /**
   * The all-clear arm. It is the one that matters and the one that would be easiest to
   * omit, and it is never "no refusals found", never "nothing to show", never blank.
   */
  it("concludes that the problem is at the door when nothing on the phone is wrong", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:45:00Z"));
    renderBoth(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }));
    await advance(0);

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await advance(0);

    const panel = screen.getByRole("group", { name: /work out why/i });
    expect(panel).toHaveTextContent(/whatever went wrong is at the door/i);
    expect(panel).toHaveTextContent("021 555 0134");
    expect(panel.textContent).not.toMatch(/no refusal|nothing to show/i);
  });

  it("names the membership and nothing else when that is the first thing wrong", async () => {
    renderBoth(memberDoorNotActiveFixture("suspended", { policy: "booking_window", next_booking: BOOKING }));
    await screen.findByLabelText("Your code");

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());

    const panel = screen.getByRole("group", { name: /work out why/i });
    expect(panel).toHaveTextContent(/only the club can change it/i);
    expect(panel.textContent).not.toMatch(/had run out/i);
  });

  /**
   * The checklist says WHICH not-active, exactly as the standing line does. A member who
   * reads "suspended" in the line and "not active" two centimetres below it is reading a
   * screen that has two answers to one question.
   */
  it.each([
    ["pending_approval", "not yet approved"],
    ["suspended", "suspended"],
    ["rejected", "turned down"],
  ] as const)("names %s on the checklist row and in its conclusion", async (detail, word) => {
    renderBoth(memberDoorNotActiveFixture(detail, { policy: "booking_window", next_booking: BOOKING }));
    await screen.findByLabelText("Your code");

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());

    const panel = screen.getByRole("group", { name: /work out why/i });
    const row = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("Your membership"));
    expect(row?.textContent).toContain(word);
    expect(row?.textContent).toContain("Failed");
    expect(panel).toHaveTextContent(new RegExp(`membership as ${word}`));
  });

  /**
   * And the row that must NOT fail. A member with no membership row is not barred — the
   * door lets them in — so failing this row would hand them "that's the whole reason"
   * about a rule nothing applies to them, while whatever is really wrong goes unnamed.
   */
  it("neither passes nor fails the membership row for a member the club has nothing on file for", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: BOOKING,
      membership: "none", membership_detail: "none",
    }));
    await screen.findByLabelText("Your code");

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());

    const panel = screen.getByRole("group", { name: /work out why/i });
    const row = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("Your membership"));
    // D3: neither a failure — nothing is barring her — nor a tick, which would be this
    // screen telling somebody the club has no record of that her records are in order.
    expect(row?.textContent).not.toContain("Passed");
    expect(row?.textContent).not.toContain("Failed");
    expect(row?.textContent).toContain("Unusual — tell the club");
    expect(row?.textContent).toContain("nothing barring you");
    expect(panel.textContent).not.toMatch(/that's the whole reason/i);
  });

  /**
   * The checklist's window row reads the same instant the decision card counts down from,
   * and it has to: `too_early` is exactly the state in which `next_booking` is null, so a
   * row fed only by the booking would answer "no window to wait for" to the one member
   * who has a window and is waiting it out.
   */
  it("judges the door's window from the decision's own instant when there is no booking", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:03:00Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null,
      last_decision: memberDoorDecisionFixture({
        at: "2026-09-19T16:02:00Z", reason: "too_early", opens_at: "2026-09-19T16:30:00Z",
      }),
    }));
    await advance(0);

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await advance(0);

    const panel = screen.getByRole("group", { name: /work out why/i });
    const row = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("The door's window"));
    // E-H2 (1) — the row is about the code ON SCREEN, which here is a booking code with a
    // window of its own. The instant is the same one either way; what changed is that the
    // sentence now says which code it belongs to.
    expect(row?.textContent).toContain("this booking code works at a door from 18:30");
    expect(row?.textContent).not.toContain("no window to wait for");

    // And the booking row must not fail either. `opens_at` is only ever computed BECAUSE
    // a qualifying booking was found; telling this member they have none, and sending
    // them to book another, is the checklist contradicting the countdown above it.
    const booking = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("Your booking"));
    expect(booking?.textContent).toContain("Passed");
    // E-H2 (2) — the conclusion LEADS with the club's own record of the refusal, which is
    // the one line on this control that is not an inference from what the phone can see.
    // It used to reason its way to "the window hasn't opened yet" while the club's record,
    // one request away, said so in the club's own words.
    expect(panel).toHaveTextContent(/club's own record/i);
    expect(panel).toHaveTextContent(/hadn't opened the door yet/i);
    expect(panel.textContent).not.toMatch(/Book one from the schedule/);
  });

  /**
   * And with nothing on the club's record, the same member gets the reasoned answer — which
   * is what makes the arm above an addition rather than a replacement.
   */
  it("reasons its way to the window when the club has no recent refusal recorded", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:03:00Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null,
      // An hour old: past the fifteen minutes the check will lead with, and the server
      // would not have sent it at all. The page must not reach back for it.
      last_decision: memberDoorDecisionFixture({
        at: "2026-09-19T15:02:00Z", reason: "too_early", opens_at: "2026-09-19T16:30:00Z",
      }),
      // A MEMBER code on screen, which has no window of its own — so the row and the
      // conclusion both fall back to what the club's decision said the window was.
    }), IDENT_CODE);
    await advance(0);

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await advance(0);

    const panel = screen.getByRole("group", { name: /work out why/i });
    expect(panel.textContent).not.toMatch(/club's own record/i);
    expect(panel).toHaveTextContent(/window hasn't opened yet/i);
    expect(panel).toHaveTextContent(/Everything else is fine/i);
  });

  /** The other half: genuinely nothing booked, and the row fails and says so. */
  it("fails the booking row when there is neither a booking nor a window to wait for", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null,
      last_decision: memberDoorDecisionFixture({ reason: "no_booking", opens_at: null }),
    }));
    await screen.findByLabelText("Your code");

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());

    const panel = screen.getByRole("group", { name: /work out why/i });
    const booking = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("Your booking"));
    expect(booking?.textContent).toContain("Failed");
    expect(booking?.textContent).toContain("none starting soon");
    // E-H2 (2) — the club wrote down why, so that leads; the way to a court is still on
    // screen as a control, which is what the member actually needs to press.
    expect(panel).toHaveTextContent(/club's own record/i);
    expect(panel).toHaveTextContent(/no court booked that the door would open for/i);
    // Two of them on the page — the standing line's and the check's — and both are the
    // one thing this member needs to press.
    expect(screen.getAllByRole("link", { name: "Book a court" }).length).toBeGreaterThan(0);
  });

  /**
   * Colour is never the only signal: the failed row says "Failed" in words — and it is
   * only the phone's row to fail when the phone is genuinely what failed. See below.
   */
  it("marks the connection row as failed in words when the phone could not reach the club", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
      unreachable("/api/v1/me/door"),
    ]);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());

    const panel = screen.getByRole("group", { name: /work out why/i });
    const connection = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("This phone's line"));
    expect(connection?.textContent).toContain("Failed");
    // And the four rows only the club can answer say they were never asked, rather than
    // defaulting to fine above a row that has just failed. This stub has no cached copy.
    expect(panel).toHaveTextContent(/unanswered rather than fine/i);
    expect(panel).toHaveTextContent(/no answer from the club/);
    expect(panel).not.toHaveTextContent(/Your membership.*active.*Passed/);
  });

  /**
   * D2, on the assembled page. The club's API answered 500 — the phone carried the
   * request there and brought the answer back — and the screen scored the phone's own line
   * ✗ Failed and told the member their phone could not reach the club. Both false, and the
   * member spent the next minute looking for signal they already had.
   */
  it("does not fail the phone's row when it was the club's system that answered with an error", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
      { path: "/api/v1/me/door", status: 500, body: { error: "boom" } },
    ]);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull());

    const panel = screen.getByRole("group", { name: /work out why/i });
    const connection = [...panel.querySelectorAll("li")].find((li) => li.textContent?.includes("This phone's line"));
    expect(connection?.textContent).not.toContain("Failed");
    expect(connection?.textContent).toContain("Not what failed here");
    expect(panel).toHaveTextContent(/answered with an error/i);
    expect(panel).toHaveTextContent(/not your phone/i);
    expect(document.body.textContent).not.toMatch(/Your phone can't reach the club/);
  });

  // --- W1.7c, club contact ------------------------------------------------------------------

  it("keeps the club's number on the page whether or not anything was refused", async () => {
    renderBoth(memberDoorsOnFixture({ last_decision: null }));

    const tel = await screen.findByRole("link", { name: "021 555 0134" });
    expect(tel).toHaveAttribute("href", "tel:0215550134");
    // A 44px hit area, not sixteen-pixel text a cold thumb cannot find.
    expect(tel.className).toContain("min-h-11");
    expect(screen.getByRole("link", { name: "info@crusaders.co.za" }))
      .toHaveAttribute("href", "mailto:info@crusaders.co.za");
  });

  it("tells a member with no club contact where the only remaining answer is", async () => {
    renderBoth(memberDoorsOnFixture({
      contact: { phone: null, email: null },
      last_decision: memberDoorDecisionFixture({ reason: "member_not_active" }),
    }));

    await screen.findAllByText(/The club has your membership as not active\./);
    expect(screen.getAllByText(/Whatever is written on the door is the only way from here/).length)
      .toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: /Call the club/ })).toBeNull();
  });

  // --- offline, which the service worker cannot serve -----------------------------------------

  /** Both reads dead. The three arms differ, and each is the honest one for its case. */
  function renderOffline() {
    stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", status: 500, body: { error: "boom" } },
      { path: "/api/v1/me/door", status: 500, body: { error: "boom" } },
    ]);
    renderPage(<MyCodePage />);
  }

  /**
   * The subtitle on the page a member reads while standing at a door with no signal. It
   * said "Show this to the scanner on the court box" and stopped — sending exactly that
   * member to go and look for a court box.
   */
  it("still names the club door on the offline page", async () => {
    rememberQr({ ...CODE, kind: "booking", expires_in_seconds: 900 } as never);
    rememberDoor(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }) as never);
    renderOffline();

    // The OFFLINE page's subtitle, which means waiting for the offline page. The first
    // render is the ordinary one and its subtitle already names the door, so matching on
    // the subtitle alone passes over a broken offline arm — which is exactly what it did.
    await screen.findByText(/This is the code it last managed to get/);
    expect(screen.getByText(/Show this to the scanner/)).toHaveTextContent(/or at the club door/);
  });

  it("renders the code it last had, with its age, when the network is gone", async () => {
    rememberQr({ ...CODE, kind: "booking", expires_in_seconds: 900 } as never);
    rememberDoor(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }) as never);
    renderOffline();

    expect(await screen.findByText(/This is the code it last managed to get/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "QR code 7K3M9XQ2RD5A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("draws no QR at all once the code it last had has run out", async () => {
    rememberQr({ ...CODE, expires_in_seconds: -60 } as never);
    rememberDoor(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }) as never);
    renderOffline();

    expect(await screen.findByText(/the code it last had has run out/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    // Twice over, and both are wanted: the sentence names the number so it can be read
    // aloud to somebody, and the footer link below it is what a cold thumb presses.
    expect(screen.getAllByText(/021 555 0134/).length).toBeGreaterThan(0);
  });

  /**
   * D5, and the sharpest honest sentence on this surface. An ident code lives about a
   * minute; a door that has also lost the network decides from a roster of BOOKINGS and
   * nothing else. This member cannot get in, and the page owes them that instead of a
   * hopeful QR.
   */
  it("tells a member holding only an ident code that it cannot open a cut-off door", async () => {
    rememberQr(IDENT_CODE as never);
    rememberDoor(memberDoorsOnFixture({ policy: "active_member", next_booking: null }) as never);
    renderOffline();

    const said = await screen.findByText(/lasts about a minute/);
    expect(said).toHaveTextContent(/a court booked/);
    expect(said).toHaveTextContent("021 555 0134");
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
  });

  // --- what the real endpoint sends, on the rendered page -------------------------------

  /**
   * The fixture against the endpoint's own key set.
   *
   * <p>
   * This page was built against a stub and the stub was narrower than the API. A fixture
   * that is narrower than the response is the mechanism by which that happens twice: every
   * assertion below it passes, and the field nobody stubbed is the field nobody renders.
   * The list is `MeDoorEndpoints.DoorAsync`'s anonymous type, key for key.
   * </p>
   */
  it("stubs every key GET /api/v1/me/door actually returns", () => {
    expect(Object.keys(memberDoorFixture()).sort()).toEqual([
      "contact", "door_log_retention_days", "doors", "doors_shut", "early_entry_minutes",
      "is_club_admin", "last_decision", "membership", "membership_detail", "next_booking",
      "policy", "roster_max_entries", "timezone",
    ]);
    expect(Object.keys(memberDoorBookingFixture()).sort()).toEqual([
      "court_number", "door_closes_at", "door_opens_at", "ends_at", "starts_at",
    ]);
    expect(Object.keys(memberDoorDecisionFixture()).sort()).toEqual([
      "at", "delivered_at", "door_name", "offline", "opens_at", "reason", "released",
    ]);
  });

  // --- WIRE-R1 §2 / §8: the two instants a door scan has -----------------------------------

  /**
   * `at` is when the code was held up; `delivered_at` is when the club heard. They differ
   * only for a door that had lost the network and decided alone — and that gap is the
   * answer to a question a member really does ask, which is why the club's own screens
   * showed nothing while they were being let in.
   */
  it("says when the club heard, on a decision a cut-off door made alone", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorOfflineDecisionFixture({ door_name: "front-door" }),
    }));

    // D6 appended the age. A member who pocketed the phone for ninety seconds cannot tell
    // a fresh card from a stale one off an absolute time alone.
    expect(await screen.findByText(/^front-door · \d{2}:\d{2} · the club heard at \d{2}:\d{2} · just now$/))
      .toBeInTheDocument();
  });

  /**
   * And says nothing of the sort for a row that never made that journey. A delivery time
   * on a scan the door asked the club about at the time is a delay that did not happen.
   */
  it("prints no delivery time for a decision the door asked the club about", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ reason: "no_booking" }),
    }));

    expect(await screen.findByText(/^front-door · \d{2}:\d{2} · just now$/)).toBeInTheDocument();
    expect(screen.queryByText(/the club heard at/)).toBeNull();
  });

  /**
   * §6.2 row 7. `GateAccess` lets a club admin past the BOOKING check under
   * `booking_window`, so the page was sending its own club's admins to book a court to
   * open a door that would have opened anyway.
   */
  it("tells a club admin under the booking rule that a door opens without a booking", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", is_club_admin: true, next_booking: null,
    }));

    const line = await screen.findByText(/You're a club admin/);
    expect(line).toHaveTextContent(/without one/);
    // P6's half, which is the whole point of saying it here rather than nowhere.
    expect(line).toHaveTextContent(/bookings, not admins/);
    expect(screen.queryByRole("link", { name: "Book a court" })).toBeNull();
  });

  /** The carve-out is the booking check only. A suspended admin is still refused. */
  it("does not offer the admin carve-out to an admin the club has suspended", async () => {
    renderBoth(memberDoorNotActiveFixture("suspended", {
      policy: "booking_window", is_club_admin: true, next_booking: null,
    }));

    expect(await screen.findByText(/as suspended/)).toBeInTheDocument();
    expect(screen.queryByText(/club admin/i)).toBeNull();
  });

  // --- membership_detail: which not-active this is -------------------------------------

  it.each([
    ["pending_approval", /not yet approved/],
    ["suspended", /as suspended/],
    ["rejected", /turned down/],
  ] as const)("says on the page which not-active %s is", async (detail, expected) => {
    renderBoth(memberDoorNotActiveFixture(detail, { policy: "active_member" }));

    expect(await screen.findByText(expected)).toBeInTheDocument();
    // The old sentence, which said the same thing to all three, must be gone rather than
    // sitting beside the new one.
    expect(screen.queryByText(/as not active,/)).toBeNull();
  });

  /**
   * `membership: "none"` — a user with no membership row — and the page must not
   * contradict the door. `StatusIfBarredAsync` answers null for that member, so
   * `GateAccess` walks past the check and the door opens.
   */
  it("does not tell a member with no membership row that theirs is not active", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "active_member", membership: "none", membership_detail: "none",
    }));

    const line = await screen.findByText(/no membership on file for you/);
    // R3-5: the mechanism, stated — and NOT the bare promise on top of it. It used to end
    // "A live member code of yours opens the club door" directly after telling her the club
    // has no record of her and that it is worth putting right, which reads as the screen
    // arguing with itself. What the door does is still said; what it no longer does is
    // finish on a promise as though the records were in order.
    expect(line).toHaveTextContent(/This club's doors don't check for one/);
    expect(line).not.toHaveTextContent(/A live member code of yours opens the club door/);
    // Neither neighbour's sentence: not "yours is active" and not "yours is not active".
    expect(line).not.toHaveTextContent(/Yours is active/);
    expect(screen.queryByText(/not active/i)).toBeNull();
    // And the door's clock times are still on the page — in the sentence that says WHICH
    // code they belong to, because the code on screen here is a booking code. E-H2 (1).
    expect(screen.getByText(/The booking code on screen is bounded by its own window/))
      // The DAY travels with the clock when the window is not today — `next_booking` has no
      // horizon any more, so a bare "18:30" could mean a time three days out.
      .toHaveTextContent(/works at a door from .*\d{2}:\d{2} until .*\d{2}:\d{2}/);
  });

  // --- early_entry_minutes: the club's own number --------------------------------------

  it("names the club's own early-entry window when there is nothing booked", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null, early_entry_minutes: 45,
    }));

    expect(await screen.findByText(/nothing booked in the next 45 minutes/)).toBeInTheDocument();
  });

  it("says it wordlessly when the club has no early-entry window set", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null, early_entry_minutes: 0,
    }));

    expect(await screen.findByText(/nothing booked soon enough for a door to open/)).toBeInTheDocument();
    expect(screen.queryByText(/next 0 minutes/)).toBeNull();
  });

  it("names it on the no_booking refusal card too", async () => {
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null, early_entry_minutes: 90,
      last_decision: memberDoorDecisionFixture({ reason: "no_booking" }),
    }));

    expect(await screen.findByText(/none starting in the next 1 hour 30 minutes/)).toBeInTheDocument();
  });

  // --- last_decision.opens_at: the countdown that could not fire -----------------------

  /**
   * The countdown the page could almost never draw.
   *
   * <p>
   * It used to come from `next_booking.door_opens_at`, and `too_early` means the booking's
   * window has NOT opened — which is exactly the condition under which `NextBookingAsync`
   * returns null. So the commonest too-early card on the product carried no countdown at
   * all. This fixture is that case: a refusal with `opens_at` on it and NO booking beside
   * it, which is what the endpoint really sends.
   * </p>
   */
  it("counts down from the decision's own instant when there is no booking to fall back to", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:03:00Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      next_booking: null,
      last_decision: memberDoorDecisionFixture({
        at: "2026-09-19T16:02:00Z", reason: "too_early", opens_at: "2026-09-19T16:30:00Z",
      }),
    }));
    await advance(0);

    const card = screen.getByRole("status");
    expect(card).toHaveTextContent(/Too early — the door opens for you in 27m 00s\./);
    await advance(60_000);
    expect(card).toHaveTextContent(/26m 00s/);
  });

  /** The decision's instant outranks the booking's when both are there. */
  it("prefers the decision's instant over the booking's window", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:03:00Z"));
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window",
      next_booking: memberDoorBookingFixture({ door_opens_at: "2026-09-19T16:10:00Z" }),
      last_decision: memberDoorDecisionFixture({
        at: "2026-09-19T16:02:00Z", reason: "too_early", opens_at: "2026-09-19T16:30:00Z",
      }),
    }));
    await advance(0);

    const card = screen.getByRole("status");
    expect(card).toHaveTextContent(/opens for you in 27m 00s/);
    // The booking's own window would have given 7m — a countdown to the wrong instant,
    // which is a member watching a clock reach zero at a door that refuses them.
    expect(card).not.toHaveTextContent(/\b7m 00s/);
    expect(card).toHaveTextContent(/until 18:30/);
  });

  /**
   * Only `too_early` gets a clock, and the difference is a running interval rather than
   * anything on screen.
   *
   * <p>
   * The mutation pass found nothing holding this: every other arm ignores `ctx.countdown`,
   * so counting down on a `no_booking` card renders identically and costs a member a
   * re-render a second for as long as the card is open. Measured rather than reasoned
   * about — the two fixtures differ in one field, so the extra timer is the whole of the
   * difference between them.
   * </p>
   */
  it("starts no per-second clock on a refusal that is not a matter of waiting", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:03:00Z"));
    const opensAt = "2026-09-19T16:30:00Z";

    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null,
      last_decision: memberDoorDecisionFixture({ at: "2026-09-19T16:02:00Z", reason: "too_early", opens_at: opensAt }),
    }));
    await advance(0);
    const withClock = vi.getTimerCount();

    cleanup();
    renderBoth(memberDoorsOnFixture({
      policy: "booking_window", next_booking: null,
      last_decision: memberDoorDecisionFixture({ at: "2026-09-19T16:02:00Z", reason: "no_booking", opens_at: opensAt }),
    }));
    await advance(0);

    expect(vi.getTimerCount()).toBe(withClock - 1);
  });

  // --- last_decision.offline: the other half of the open -------------------------------

  /**
   * §6.1's second `ok` arm, and P6. A door that had lost the club's network matched the
   * code against a list it downloaded earlier; the club's record of it arrived afterwards.
   * A member told only "the lock released" has not been told either fact.
   */
  it("distinguishes an open the door decided alone from one the club answered", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ reason: "ok", released: true, offline: true }),
    }));

    const card = await screen.findByRole("status");
    expect(card).toHaveTextContent(/from the door's own list/);
    expect(card).toHaveTextContent(/couldn't reach the club/);
    expect(card).toHaveTextContent(/arrived afterwards/);
    // A1.2 holds on this arm exactly as it does on the other.
    expect(card).not.toHaveTextContent(/door opened|let you in|walked in/);
  });

  it("says the shorter sentence for an open the club was reachable for", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ reason: "ok", released: true, offline: false }),
    }));

    const card = await screen.findByRole("status");
    expect(card).toHaveTextContent(/The lock released\./);
    expect(card).not.toHaveTextContent(/own list/);
  });

  // --- roster_max_entries: the club's own cap ------------------------------------------

  it("takes the offline roster cap from the response rather than from its own constant", async () => {
    renderBoth(memberDoorsOnFixture({ roster_max_entries: 12 }));

    await screen.findByText(/What if the door is offline/);
    expect(screen.getByText(/next 12 bookings due to start/)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`first ${GATE_ROSTER_MAX_ENTRIES} bookings`))).toBeNull();
  });

  // --- D4: the boundaries the page already knows about ---------------------------------

  /**
   * An open page kept a finished booking's code, in the present tense, with a healthy
   * countdown under it, twenty minutes after the court had ended.
   *
   * <p>
   * Nothing was broken. Everything on that screen was true when it was fetched, and the
   * only thing standing between the member and a wrong answer was how often the page
   * happened to ask again — a booking code lives forty-five minutes, so the switch fired
   * when the code died rather than when the booking did. A poll rate is not an argument.
   * The booking's end is a field the page is already rendering.
   * </p>
   */
  it("re-reads when the booking it is showing a code for ends", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T17:40:00Z"));
    const stub = stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }) },
    ]);
    renderPage(<MyCodePage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // The CODE fetch, not the door read. `useMemberDoor` polls on its own every thirty
    // seconds, so a count of door reads grows across any five-minute advance whatever this
    // hook does — a mutation pass proved exactly that, by deleting the booking's end from
    // the boundary list and watching this test stay green. A code fetch is paced and
    // nothing else is due: at 17:40 the code on screen has fifteen minutes left, so the
    // pre-fetch cannot fire, and the only thing that can ask for another is a boundary.
    const codes = () => stub.calls.filter((c) => c.method === "POST" && c.path.startsWith("/api/v1/me/qr/generate")).length;
    const before = codes();
    // BOOKING ends at 17:45, and it is the only boundary inside this window: both edges of
    // the door window are 16:30 and 18:05.
    await advance(5 * 60_000 + 1_000);

    expect(codes()).toBeGreaterThan(before);
  });

  /**
   * The same rule from the other side: a door window that OPENS is a boundary too, and
   * the member watching a too-early countdown run to zero is the most attentive reader
   * this page ever has.
   */
  it("re-reads the moment a door window it is counting down to opens", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T16:25:00Z"));
    const stub = stubFetch([
      // The code carries NO door window of its own. Both reads send these instants, and a
      // fixture where they agree cannot tell which of the two the page is actually
      // watching: a mutation pass deleted the door read's `door_opens_at` from the
      // boundary list and this test stayed green on the code's copy of the same minute.
      { method: "POST", path: "/api/v1/me/qr/generate", body: { ...CODE, door_opens_at: null, door_closes_at: null } },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }) },
    ]);
    renderPage(<MyCodePage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // Counted on the code fetch for the reason the test above carries in full.
    const codes = () => stub.calls.filter((c) => c.method === "POST" && c.path.startsWith("/api/v1/me/qr/generate")).length;
    const before = codes();
    // BOOKING's door_opens_at is 16:30, and it is the only boundary inside this window:
    // the booking ends at 17:45 and its window closes at 18:05.
    await advance(5 * 60_000 + 1_000);
    expect(codes()).toBeGreaterThan(before);
  });

  // --- D5: an expired code is replaced, never dimmed ------------------------------------

  /**
   * It was drawn at forty per cent opacity under "Expired — refreshing" and left there
   * for minutes with no signal to renew it. Forty per cent still decodes: a member held a
   * dead code up to a scanner in the dark, repeatedly, while the screen promised a refresh
   * that could not happen.
   */
  it("replaces an expired code that cannot be renewed, rather than dimming it", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T17:00:00Z"));
    stubFetch([
      {
        method: "POST",
        path: "/api/v1/me/qr/generate",
        // One good answer, then nothing ever again — a phone that lost signal holding a
        // sixty-second code, which is the exact shape of the finding.
        respond: (() => {
          let served = 0;
          return () => {
            if (served++ === 0) return IDENT_CODE;
            throw new TypeError("Failed to fetch");
          };
        })(),
      },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);
    renderPage(<MyCodePage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("img", { name: /QR code/ })).toBeInTheDocument();

    // Past the sixty seconds, with every renewal refused.
    await advance(75_000);

    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    expect(screen.getByText(/can't be renewed without signal/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Expired — refreshing/);
    // The fallback code goes with the symbol. It is the SAME dead code in a form somebody
    // can type at a desk, and leaving it — with "Identifies you at any court box" under it
    // in the present tense — is the same false offer with an extra step.
    expect(screen.queryByLabelText("Your code")).toBeNull();
    expect(document.body.textContent).not.toContain("ZZ9P4T6WQ8HN");
    expect(document.body.textContent).not.toMatch(/Identifies you at any court box/);
  });

  // --- D9: the door section says a question is being asked -------------------------------

  /**
   * `/me/door` took four seconds and more, and for all of it the page rendered the
   * court-only copy with total confidence and no door section at all — then grew one
   * under the member's thumb.
   */
  it("says it is still finding out, rather than rendering the court-only page confidently", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: { ...CODE, doors: false, door_opens_at: null, door_closes_at: null } },
    ]);
    // A read still IN FLIGHT, which is the state the harness has no shape for: a route it
    // does not know rejects, and a rejection is a read that failed. The finding is about
    // the four seconds before either answer — so the door route hangs, and nothing else
    // about the stub changes.
    const stubbed = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => (
      String(input).startsWith("/api/v1/me/door")
        ? new Promise<Response>(() => {})
        : (stubbed as typeof fetch)(input, init)
    )));
    renderPage(<MyCodePage />);

    expect(await screen.findByText(/Checking whether this club's doors/)).toBeInTheDocument();
    // And it is not the court-only page rendered with complete confidence.
    expect(screen.queryByText(/The door didn't open/)).toBeNull();
  });

  it("stops saying it once the club has answered that it has no door", async () => {
    renderBoth(memberDoorFixture(), { ...CODE, doors: false, door_opens_at: null, door_closes_at: null });
    await screen.findByLabelText("Your code");

    await waitFor(() => expect(screen.queryByText(/Checking whether this club's doors/)).toBeNull());
    // And the club with no door still meets the word nowhere.
    expect(screen.queryByText(/door/i)).toBeNull();
  });

  // --- D13: the escape hatch, remembered and offered --------------------------------------

  it("gives the walk-up switch a target a thumb can hit in the dark", async () => {
    renderBoth(memberDoorsOnFixture());
    await screen.findByLabelText("Your code");

    const label = screen.getByText("Walk up / pay for someone").closest("label")!;
    // 16px was the finding. The whole row is the label and the whole row is the target.
    expect(label.className).toContain("min-h-11");
    expect(label.querySelector("input")).toBeTruthy();
  });

  it("remembers the walk-up choice for the rest of the session", async () => {
    renderBoth(memberDoorsOnFixture(), IDENT_CODE);
    await screen.findByLabelText("Your code");
    fireEvent.click(screen.getByRole("checkbox", { name: /Walk up \/ pay for someone/ }));
    await waitFor(() => expect(readWalkUpChoice()).toBe(true));

    cleanup();
    const stub = renderBoth(memberDoorsOnFixture(), IDENT_CODE);
    await screen.findByLabelText("Your code");

    // The remembered choice decides the FIRST fetch, not merely the checkbox's tick.
    await waitFor(() => {
      expect(stub.calls.some((c) => c.method === "POST" && c.path.includes("kind=ident"))).toBe(true);
    });
    expect(screen.getByRole("checkbox", { name: /Walk up \/ pay for someone/ })).toBeChecked();
  });

  /**
   * The member whose booking's door window has closed is holding a code the door will
   * refuse, with the only alternative behind a checkbox lower down the page labelled for
   * a court errand. The page knows the window has closed — it is a field it is rendering.
   */
  it("offers the member code once the booking code's door window has passed", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T18:10:00Z"));
    renderBoth(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // CODE's door_closes_at is 18:05 — five minutes ago.
    expect(screen.getByText(/door window has closed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use your member code instead" })).toBeInTheDocument();
  });

  it("says nothing of the sort while the window is still open", async () => {
    fakeClock();
    vi.setSystemTime(new Date("2026-09-19T17:30:00Z"));
    renderBoth(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(screen.queryByText(/door window has closed/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Use your member code instead" })).toBeNull();
  });

  // --- D14: the member's own record, one tap away ------------------------------------------

  it("links to the member's own door history from the code page", async () => {
    renderBoth(memberDoorsOnFixture());
    await screen.findByLabelText("Your code");

    const link = screen.getByRole("link", { name: "Your door history" });
    expect(link).toHaveAttribute("href", "/profile#door-history");
  });

  it("offers no such link at a club with no door", async () => {
    renderBoth(memberDoorFixture(), { ...CODE, doors: false, door_opens_at: null, door_closes_at: null });
    await screen.findByLabelText("Your code");

    expect(screen.queryByRole("link", { name: "Your door history" })).toBeNull();
  });

  // --- D1, on the assembled page ------------------------------------------------------------

  /**
   * The screenshot that opened the finding: a `/me/door` that never landed, and a page
   * telling a member standing outside a locked building that their club has given the app
   * no number — then telling them to fix it under Admin settings.
   */
  it("never says the club has no number off a read it could not make", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
      unreachable("/api/v1/me/door"),
    ]);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    await waitFor(() => expect(screen.getByText(/Couldn't load the club's number/)).toBeInTheDocument());
    expect(screen.queryByText(/hasn't given the app a number/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Admin settings/i);
  });

  it("says the same off a club system that answered with an error", async () => {
    stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
      { path: "/api/v1/me/door", status: 500, body: { error: "boom" } },
    ]);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    await waitFor(() => expect(screen.getByText(/Couldn't load the club's number/)).toBeInTheDocument());
    expect(screen.queryByText(/hasn't given the app a number/)).toBeNull();
  });

  it("still offers a last-known number, with its age, rather than nothing", async () => {
    rememberDoor(memberDoorsOnFixture({ contact: { phone: "021 555 0134", email: null } }) as never);
    stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
      unreachable("/api/v1/me/door"),
    ]);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    await waitFor(() => expect(screen.getByRole("link", { name: "021 555 0134" })).toBeInTheDocument());
    expect(screen.getByText(/This is the number it gave/)).toBeInTheDocument();
  });

  // --- D6: the code itself, at a root font this page did not survive --------------------------

  /**
   * Nothing between the glass and the symbol is measured in the reader's own font size.
   *
   * <p>
   * <b>The property, not the class string.</b> The first version of this assertion named
   * the exact arbitrary value the fix had used — and that value was itself wrong: it
   * subtracted the page gutter as it measures at the DEFAULT root, so at a 32px root the
   * symbol wanted more width than the card had and dragged the page column off the glass.
   * A test pinned to the literal would have stayed green through every step of that, because
   * the string it was asserting never changed. What makes the symbol root-invariant is that
   * every length in the chain — the card's width, the card's padding, the cap on the symbol
   * — is a pixel or a viewport unit, and that is what is checked.
   * </p>
   *
   * <p>
   * jsdom computes no layout, so the sizes themselves are measured in `e2e/my-code.spec.ts`
   * at two viewports and two root fonts. This holds the rule those measurements come from.
   * </p>
   */
  function expectRootInvariantCode(qrBox: HTMLElement) {
    const card = qrBox.closest("div.rounded-lg")!;
    // A rem anywhere in the width chain is the defect, in any spelling: `max-w-xs`, a `p-4`
    // on this card, or a `20rem` inside an arbitrary value.
    const chain = `${qrBox.className} ${card.className}`;
    expect(chain).not.toMatch(/rem/);
    expect(chain).not.toMatch(/\b(max-)?w-(xs|sm|md|lg|xl)\b/);
    expect(chain).not.toMatch(/\bp-\d/);

    // The symbol fills what the card has, up to the size a scanner needs at arm's length.
    expect(qrBox.className).toContain("w-full");
    // R3-29 (D-M2) added a HEIGHT bound beside the px ceiling: at 320x568 a 288px square put
    // the readable code and the "which code" label below the fold. `vh` is not `rem` — it is
    // the viewport, not the reader's font — so the root-invariance rule above is untouched.
    expect(qrBox.className).toMatch(/max-w-\[min\(\d+px,\d+vh\)\]/);
    // And the card is what is pinned: a px gutter off the viewport below `sm`, px padding
    // throughout. Both halves have to be here — a pinned symbol inside a rem-padded card is
    // the arrangement that overflowed.
    expect(card.className).toMatch(/w-\[min\(100vw-\d+px,\d+px\)\]/);
    expect(card.className).toMatch(/p-\[\d+px\]/);
  }

  /**
   * `max-w-xs` is 20 REM, and a rem is whatever the reader has set. At a root font of 32px
   * it resolved to 640px inside a 360px phone: the symbol ran off both edges, the
   * twelve-character fallback ran off with it, and the whole page scrolled sideways. A
   * jsdom test cannot see the overflow — the Playwright one below can — but it CAN hold
   * the rule that caused it, which is what a regression would change.
   */
  it("caps the code and the QR against the column, not against the root font", async () => {
    renderBoth(memberDoorsOnFixture());
    const code = await screen.findByLabelText("Your code");

    expect(code.className).toContain("break-all");
    expect(code.className).toContain("max-w-full");
    expectRootInvariantCode(screen.getByRole("img", { name: /QR code/ }).parentElement!);
  });

  /**
   * The offline page draws its own cached symbol and its own fallback code, from a second
   * block that a fix applied to the live card leaves untouched. A member with no signal is
   * exactly the member least able to work around a code running off the edge of the glass.
   */
  it("caps the cached code and QR on the offline page too", async () => {
    rememberQr({ ...CODE, expires_in_seconds: 900 } as never);
    rememberDoor(memberDoorsOnFixture() as never);
    stubFetch([
      unreachable("/api/v1/me/qr/generate", "POST"),
      unreachable("/api/v1/me/door"),
    ]);
    renderPage(<MyCodePage />);

    const code = await screen.findByLabelText("Your code");
    expect(code.className).toContain("break-all");
    expect(code.className).toContain("max-w-full");
    expectRootInvariantCode(screen.getByRole("img", { name: /QR code/ }).parentElement!);
  });

  // --- D1: the door section does not belong to the code read -------------------------
  //
  // Each read failing ALONE was handled well, and the two failing together deleted the
  // whole subject: no door section, no self-check, no link to the member's own record, and
  // not one tel: or mailto: anywhere on the screen — for the member standing at the door in
  // the dark, who is the entire reason this surface exists. So the matrix is swept rather
  // than sampled: two reads, each failing or landing, times a last-known store that is
  // there or is not.

  /** Every combination of the two reads, with and without something cached. */
  const READ_COMBINATIONS = [
    ["both reads land", false, false],
    ["the code read fails", true, false],
    ["the door read fails", false, true],
    ["both reads fail", true, true],
  ] as const;

  function seedCache() {
    rememberQr({ ...CODE, expires_in_seconds: 900 } as never);
    rememberDoor(memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }) as never);
  }

  it.each(READ_COMBINATIONS.flatMap(([name, codeFails, doorFails]) =>
    [true, false].map((cached) => [`${name}, ${cached ? "with" : "without"} a cached copy`, codeFails, doorFails, cached] as const)))(
    "keeps the door section, the self-check, the history link and a way to a human when %s",
    async (_name, codeFails, doorFails, cached) => {
      if (cached) seedCache();
      stubFetch([
        codeFails
          ? unreachable("/api/v1/me/qr/generate", "POST")
          : { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
        doorFails
          ? unreachable("/api/v1/me/door")
          : { path: "/api/v1/me/door", body: memberDoorsOnFixture({ policy: "booking_window", next_booking: BOOKING }) },
        { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
      ]);
      renderPage(<MyCodePage />);

      // The door section exists in every one of the eight, whatever it can say in it.
      await screen.findByRole("heading", { name: /What opens the door for you right now/ });
      // The self-check exists, because "the door didn't open" is the question this page is
      // for and no read failing makes it stop being asked.
      expect(screen.getByRole("button", { name: "The door didn't open" })).toBeInTheDocument();
      // The member's own record is one tap away.
      expect(screen.getByRole("link", { name: "Your door history" })).toBeInTheDocument();
      // And a way to a human: either a real link, or an honest admission that the page
      // could not find one — never silence, and never a false negative about the club.
      const reachable = screen.queryAllByRole("link").some((a) => /^(tel|mailto):/.test(a.getAttribute("href") ?? ""));
      const admitted = !!document.body.textContent?.match(/couldn't load the club's number|couldn't reach the club/i);
      expect(reachable || admitted).toBe(true);
    },
  );

  /**
   * And the shape of the one that used to be silent: both reads failed and nothing was ever
   * cached, so the page had never been told this club HAS a door. It must not conclude that
   * it has none — that is an answer, and the page does not have one.
   */
  it("says it could not find out, rather than that the club has no door, when it never heard either read", async () => {
    stubFetch([
      unreachable("/api/v1/me/qr/generate", "POST"),
      unreachable("/api/v1/me/door"),
      { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
    ]);
    renderPage(<MyCodePage />);

    expect(await screen.findByText(/can't tell you what its doors need from you/i))
      .toHaveTextContent(/or whether this club has any/i);
    // It does not invent a club with no door, and it does not invent one with doors either.
    expect(screen.queryByText(/opens the club door/)).toBeNull();
  });

  /** A club that has genuinely ANSWERED that it has no door stays silent, as it always has. */
  it("still says nothing at all once the club has answered that it has no door", async () => {
    stubFetch([
      unreachable("/api/v1/me/qr/generate", "POST"),
      { path: "/api/v1/me/door", body: memberDoorFixture() },
      { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
    ]);
    renderPage(<MyCodePage />);

    await screen.findByText(/Couldn't get a code/);
    expect(screen.queryByRole("heading", { name: /What opens the door for you right now/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Your door history" })).toBeNull();
  });

  // --- D6: a fact from earlier carries its age --------------------------------------

  /**
   * `useMemberDoor` keeps the last good answer when a later read fails, which is right —
   * throwing away a true answer because the next request did not land leaves the member
   * with less. What was wrong is that it went on being rendered in the present tense, with
   * nothing to say it was from ten minutes ago, beside a code card saying "Run out".
   */
  it("says nothing about the age of door facts it can still re-read", async () => {
    renderBoth(memberDoorsOnFixture({ policy: "active_member" }));

    const heading = await screen.findByRole("heading", { name: /What opens the door for you right now/ });
    expect(heading.textContent).not.toMatch(/may have changed/);
  });

  it("marks the door facts as from earlier once it can no longer re-read them", async () => {
    let doorReads = 0;
    stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: CODE },
      {
        path: "/api/v1/me/door",
        respond: () => {
          doorReads += 1;
          // The FIRST read lands, so the page holds a true answer; every one after it
          // fails, which is the state `useMemberDoor` deliberately keeps that answer
          // through — and the state in which it used to go on being rendered in the
          // present tense with nothing to say how old it was.
          if (doorReads > 1) throw new TypeError("Failed to fetch");
          return memberDoorsOnFixture({ policy: "active_member" });
        },
      },
      { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
    ]);
    renderPage(<MyCodePage />);

    await screen.findByRole("heading", { name: /What opens the door for you right now/ });
    fireEvent.click(screen.getByRole("button", { name: "The door didn't open" }));
    await waitFor(() => expect(doorReads).toBeGreaterThan(1));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /What opens the door for you right now/ }).textContent)
        .toMatch(/as of \d{2}:\d{2} — may have changed/));
    // And the sentence itself is still the club's own answer, not an apology in its place.
    expect(screen.getByText(/Your club opens its doors for any active member/)).toBeInTheDocument();
  });

  /**
   * D6, amending A3.2. The card stays until it is superseded or dismissed — a card that
   * vanishes mid-sentence while a cold member is reading it is the defect that rule exists
   * for. What A3.2 did not say is that it then stayed at full size and full confidence for
   * as long as the page was open: a green "The lock released · 10:02" was still the largest
   * thing on the screen twenty minutes later, over a code that had since run out.
   */
  it("ages the decision card and collapses it to one line, still dismissible", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorOfflineDecisionFixture({
        at: new Date(Date.now() - 12 * 60_000).toISOString(),
        delivered_at: new Date(Date.now() - 11 * 60_000).toISOString(),
      }),
    }));

    expect(await screen.findByText(/12 min ago/)).toBeInTheDocument();
    // Collapsed: the body of the card is gone, the headline and the stamp are not. The
    // fixture is the OFFLINE open, so the body to look for is that arm's — a negative
    // assertion aimed at the online arm's sentence passes whether or not anything
    // collapsed, which is how this one first went green against a mutation.
    expect(screen.getByText(/The lock released/)).toBeInTheDocument();
    expect(screen.queryByText(/decided from the list of/)).toBeNull();
    // One line: the headline and its stamp, and nothing else.
    expect(screen.queryByText(/Nothing about your booking changed/)).toBeNull();
    // And it can still be got rid of. A collapsed card a member cannot dismiss is worse
    // than a big one they can.
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("keeps a fresh decision at full size, with its body and its age", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ released: true, reason: "ok" }),
    }));

    expect(await screen.findByText(/There is no sensor on a door here/)).toBeInTheDocument();
    expect(screen.getByText(/just now/)).toBeInTheDocument();
  });

  // --- D8 / D10: the code is first, and nothing that comes and goes may move it --------

  /**
   * <b>D8.</b> The page opened with a heading, a two-line subtitle and a decision card, so
   * at 320×568 the QR was entirely below the fold: a member at a scanner had to scroll to
   * find the one thing they opened the page for. jsdom has no layout, so what is held here
   * is DOCUMENT ORDER — the QR before every explanation — and the Playwright spec measures
   * the fold itself.
   *
   * <p>
   * <b>D10</b> is the same edit from the other side: a decision arriving moved the QR down
   * 290 px on a screen somebody was holding against a scanner, and dismissing it moved the
   * QR back up. Below the code it cannot.
   * </p>
   */
  it("puts the code before every explanation of it, with or without a decision", async () => {
    renderBoth(memberDoorsOnFixture({
      last_decision: memberDoorDecisionFixture({ released: true, reason: "ok" }),
    }));

    await screen.findByText(/The lock released/);
    const order = (node: Element | null) => [...document.querySelectorAll("*")].indexOf(node!);
    const qr = order(screen.getByRole("img", { name: /QR code/ }));
    expect(qr).toBeLessThan(order(screen.getByText(/The lock released/)));
    expect(qr).toBeLessThan(order(screen.getByText(/Show this to the scanner/)));
    expect(qr).toBeLessThan(order(screen.getByRole("heading", { name: /What opens the door/ })));
    expect(qr).toBeLessThan(order(screen.getByRole("checkbox", { name: /Walk up/ })));
  });

  // --- D12: the full-screen overlay --------------------------------------------------

  it("shows the code's own countdown on the full-screen overlay", async () => {
    renderBoth(memberDoorsOnFixture());
    fireEvent.click(await screen.findByRole("button", { name: "Show your code full screen" }));

    const dialog = await screen.findByRole("dialog", { name: /full screen/i });
    expect(dialog).toHaveTextContent(/Refreshes in 15m 00s/);
  });

  /**
   * <b>It used to close itself.</b> The overlay was rendered on `qr && !dead`, so the moment
   * the code ran out it unmounted: a member holding the phone against a scanner in the dark
   * had the screen go back to the page by itself, with no explanation, led by whatever card
   * happened to be at the top. Closing is the member's gesture.
   */
  it("stays open when the code dies, and says so where the member is already looking", async () => {
    fakeClock();
    // One code, five seconds on it, and every attempt to replace it refused — which is the
    // member with no signal, holding the phone against a scanner in the dark.
    let served = 0;
    stubFetch([
      {
        method: "POST",
        path: "/api/v1/me/qr/generate",
        respond: () => {
          served += 1;
          if (served > 1) throw new TypeError("Failed to fetch");
          return { ...CODE, expires_in_seconds: 5 };
        },
      },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
      { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
    ]);
    renderPage(<MyCodePage />);
    await advance(0);

    // `fireEvent` and `advance`, never `findBy`: the async matchers poll on real timers and
    // deadlock against the fake clock this file runs its expiry tests on.
    fireEvent.click(screen.getByRole("button", { name: "Show your code full screen" }));
    await advance(0);
    expect(screen.getByRole("dialog", { name: /full screen/i })).toBeInTheDocument();

    // Past its expiry, and past the pacing gap that bounds the replacement attempt.
    await advanceSecondsHere(20);

    const dialog = screen.getByRole("dialog", { name: /full screen/i });
    expect(dialog).toHaveTextContent(/This code has run out/);
    expect(dialog).toHaveTextContent(/nothing on this screen for a door or a court box to read/i);
    // The dead symbol is REPLACED, not dimmed: 40% opacity is a QR that still decodes, and
    // a member held one up repeatedly while a screen promised a refresh that could not
    // happen.
    expect(within(dialog).queryByRole("img", { name: /QR code/ })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  // --- C9 / D14: the dialog honours what it claims -----------------------------------

  /**
   * `aria-modal="true"` was a claim this overlay did not honour: Tab walked straight out of
   * it and through the page underneath — the header, the tab strip, every link on the code
   * page — while a screen reader went on announcing a dialog. For a keyboard or
   * screen-reader user that is worse than no dialog semantics at all, because the promise is
   * what stops them looking for the way out.
   */
  it("inerts the page behind the full-screen code and locks the background scroll", async () => {
    renderBoth(memberDoorsOnFixture());
    fireEvent.click(await screen.findByRole("button", { name: "Show your code full screen" }));
    await screen.findByRole("dialog", { name: /full screen/i });

    // Every sibling of the overlay, so the guard does not depend on an id that exists in
    // index.html and in no test harness.
    const behind = [...document.body.children].filter((n) => n.getAttribute("role") !== "dialog");
    expect(behind.length).toBeGreaterThan(0);
    expect(behind.every((n) => n.hasAttribute("inert"))).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Restored to what it was, not to a default: another overlay may own them, and
    // clearing somebody else's lock is how a page ends up permanently unscrollable.
    expect([...document.body.children].some((n) => n.hasAttribute("inert"))).toBe(false);
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps Tab inside the full-screen code", async () => {
    renderBoth(memberDoorsOnFixture());
    fireEvent.click(await screen.findByRole("button", { name: "Show your code full screen" }));
    const dialog = await screen.findByRole("dialog", { name: /full screen/i });
    const done = within(dialog).getByRole("button", { name: "Done" });

    // From the dialog itself, forward, to its only stop.
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(done);
    // And from the last stop, forward, back round to the first rather than out to the page.
    done.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  // --- C17 and the LOW list ------------------------------------------------------------

  /**
   * C17 — the checkbox's accessible NAME was thirty words long, because the whole
   * explanation sat inside the label. A screen-reader user tabbing past heard the entire
   * paragraph read out as the name of a checkbox, every time, with no way to skip to the
   * state.
   */
  it("gives the walk-up switch a short name and its explanation as a description", async () => {
    renderBoth(memberDoorsOnFixture());
    const box = await screen.findByRole("checkbox", { name: "Walk up / pay for someone" });

    const describedBy = box.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const explanation = document.getElementById(describedBy!);
    expect(explanation?.textContent).toMatch(/starting on a free court now/);
    // The LOW note: it sticks, and it says so. A member who turns it on and finds it still
    // on concludes the switch is broken; one who is told what it does concludes nothing.
    expect(explanation?.textContent).toMatch(/Stays on for the rest of this visit/);
  });

  /** The hint that explains the page's one gesture, at 14px rather than 12. */
  it("sets the fill-the-screen hint at 14px", async () => {
    renderBoth(memberDoorsOnFixture());
    const hint = await screen.findByText(/Tap the code to fill the screen/);
    expect(hint.className).toContain("text-sm");
    expect(hint.className).not.toContain("text-xs");
  });
});
