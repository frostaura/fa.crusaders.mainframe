import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import MyCodePage from "./MyCode";
import { encodeQr, qrPath } from "../lib/qr";
import { renderPage, stubFetch } from "../test/harness";

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
    expect(screen.getByText(/It also opens the club door from \d{2}:\d{2} until \d{2}:\d{2}\./))
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
    expect(screen.getByText(/It also opens the club door from \d{2}:\d{2} until shortly after your booking ends\./))
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
    const start = said.indexOf("It also opens the club door");
    expect(start).toBeGreaterThan(-1);
    const door = said.slice(start);
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
    expect(screen.getByText(/^Booking code · court 3 · starts \d{2}:\d{2}$/)).toBeInTheDocument();
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

    fireEvent.click(screen.getByLabelText("Walk up / pay for someone"));

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

    const toggle = screen.getByLabelText("Walk up / pay for someone");
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
    expect(screen.getByText(/Expired — refreshing/)).toBeInTheDocument();

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
    expect(stub.calls.length).toBe(1);

    // The club puts it right at the desk. The member presses the only control they have.
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));

    expect(await screen.findByLabelText("Your code")).toHaveTextContent("ZZ9P4T6WQ8HN");
    expect(stub.calls.length).toBe(2);
    // The refusal is gone, not sitting behind the code.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/membership is suspended/i)).toBeNull();
    // And the whole page is back, walk-up switch and all.
    expect(screen.getByLabelText("Walk up / pay for someone")).toBeInTheDocument();
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

    await waitFor(() => expect(stub.calls.length).toBe(2));
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
