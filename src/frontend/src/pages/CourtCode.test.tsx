import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import CourtCodePage from "./CourtCode";
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
describe("CourtCode", () => {
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

  it("shows a booking code with its court and start time", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: BOOKING }]);

    renderPage(<CourtCodePage />);

    // The code itself is printed, because it is short enough to type at the desk.
    expect(await screen.findByLabelText("Court code")).toHaveTextContent("7K3M9XQ2RD5A");
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

    renderPage(<CourtCodePage />);

    const svg = await screen.findByRole("img", { name: "QR code 7K3M9XQ2RD5A" });
    // Module-for-module the symbol for the twelve characters alone — not a URL around
    // them, not the booking id, not the tenant. Twelve bytes is a version-1 symbol; the
    // box's scanner has room for 24.
    expect(svg.querySelector("path")?.getAttribute("d")).toBe(qrPath(encodeQr("7K3M9XQ2RD5A")));
  });

  it("says an ident code identifies the member at any court", async () => {
    stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: IDENT }]);

    renderPage(<CourtCodePage />);

    expect(await screen.findByLabelText("Court code")).toHaveTextContent("ZZ9P4T6WQ8HN");
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

    renderPage(<CourtCodePage />);
    expect(await screen.findByLabelText("Court code")).toHaveTextContent("7K3M9XQ2RD5A");
    // The default fetch asks for nothing: the server decides.
    expect(stub.calls[0].path).toBe("/api/v1/me/qr/generate");

    fireEvent.click(screen.getByLabelText("Walk up / pay for someone"));

    // Asked for outright, not hoped for. `kind=ident` is what makes the answer a
    // walk-up code rather than the booking code the default would hand back again.
    await waitFor(() => {
      expect(stub.calls.some((c) => c.path === "/api/v1/me/qr/generate?kind=ident")).toBe(true);
    });
    expect(await screen.findByLabelText("Court code")).toHaveTextContent("ZZ9P4T6WQ8HN");
    expect(screen.getByText("Walk-up code · any court")).toBeInTheDocument();
    // And the QR carries that code, not the booking one still in the member's memory.
    expect(screen.getByRole("img", { name: "QR code ZZ9P4T6WQ8HN" })).toBeInTheDocument();
  });

  it("goes back to letting the server choose when the walk-up switch is turned off", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: BOOKING, sequence: [BOOKING, IDENT, BOOKING] }]);

    renderPage(<CourtCodePage />);
    await screen.findByLabelText("Court code");

    const toggle = screen.getByLabelText("Walk up / pay for someone");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Walk-up code · any court")).toBeInTheDocument());
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(stub.calls.filter((c) => c.path === "/api/v1/me/qr/generate")).toHaveLength(2);
    });
    expect(await screen.findByLabelText("Court code")).toHaveTextContent("7K3M9XQ2RD5A");
  });

  it("fetches a fresh code on demand", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/me/qr/generate", body: IDENT }]);

    renderPage(<CourtCodePage />);
    await screen.findByLabelText("Court code");

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

    renderPage(<CourtCodePage />);
    await advance(0);
    expect(screen.getByLabelText("Court code")).toHaveTextContent("ZZ9P4T6WQ8HN");
    expect(screen.getByText(/Refreshes in 1m 00s/)).toBeInTheDocument();

    // 49 s in: still the first code, still one call. The rollover used to happen
    // only AFTER expiry, leaving the member holding a dead QR for the ~10 s the
    // paced re-fetch took.
    await advance(49_000);
    expect(generates()).toBe(1);
    expect(screen.getByLabelText("Court code")).toHaveTextContent("ZZ9P4T6WQ8HN");
    expect(screen.getByText(/Refreshes in 11s/)).toBeInTheDocument();

    // Ten seconds out, the next code is fetched and swapped in at once. The old one
    // never reaches zero on screen — no "Expired", no dimmed QR. (The second advance
    // is the zero-delay timer the tick's effect schedules; effects flush as the act ends.)
    await advance(1_000);
    await advance(0);
    expect(generates()).toBe(2);
    expect(screen.getByLabelText("Court code")).toHaveTextContent("8H2R5V7XM3KP");
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

    renderPage(<CourtCodePage />);
    await advance(0);
    expect(generates()).toBe(1);

    // Ten seconds out the pre-fetch fires, and the server answers with the code the
    // page is already holding — the whole of what the pre-fetch achieved before this
    // fix was one extra request per code.
    await advance(50_000);
    await advance(0);
    expect(generates()).toBe(2);
    expect(screen.getByLabelText("Court code")).toHaveTextContent("ZZ9P4T6WQ8HN");

    // Not two seconds later: still nothing, because the short gap has not elapsed.
    await advance(1_500);
    expect(generates()).toBe(2);

    // On the short gap, not the ten-second one, and the code that finally arrives is
    // swapped in before the old one ever reaches zero.
    await advance(1_000);
    await advance(0);
    expect(generates()).toBe(3);
    expect(screen.getByLabelText("Court code")).toHaveTextContent("8H2R5V7XM3KP");
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

    renderPage(<CourtCodePage />);
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

    renderPage(<CourtCodePage />);
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

    renderPage(<CourtCodePage />);
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

    renderPage(<CourtCodePage />);

    expect(await screen.findByText(/Couldn't get a code/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });
});
