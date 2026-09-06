import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import TopUpStatusPage from "./TopUpStatus";
import { BalanceProvider } from "../lib/balance";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * What a member is told when a payment does not complete.
 *
 * <p>
 * The page rendered the raw <code>FailureReason</code> column. A member whose R500
 * payment failed was shown <code>amount_mismatch:reported=100,00:expected=500,00</code>
 * — an internal string, with en-ZA comma decimals, as their explanation — and nothing
 * about what to do next or whether they had been charged. And a payment the member
 * deliberately CANCELLED at PayFast was stored and shown as "Failed", so backing out of
 * a purchase told them their payment had gone wrong.
 * </p>
 *
 * <p>
 * The API's contract is the stable snake_case code; the sentence belongs on this side.
 * The assertions check both halves: the sentence is there, and the code is not.
 * </p>
 */
describe("Top-up status — failure copy", () => {
  const ID = "aaaa1111-0000-0000-0000-000000000001";

  const snapshot = (over: Record<string, unknown>) => ({
    id: ID, status: "Pending", amount_zar: 500, conversion_rate: 1.6, failure_code: null, ...over,
  });

  beforeEach(() => {
    // BalanceProvider opens an EventSource on mount and jsdom has none. The stream is not
    // what is on trial here; a no-op constructor keeps it out of the way.
    vi.stubGlobal("EventSource", class {
      close() {}
      // The provider listens for the stream's named `ping` keep-alive; a double without
      // this throws where the real EventSource would not.
      addEventListener() {}
      removeEventListener() {}
    } as unknown as typeof EventSource);
  });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const show = (status: unknown) => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: `/api/v1/credit/topup/${ID}`, body: status },
      { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    ]);
    renderPage(
      <BalanceProvider>
        <Routes><Route path="/wallet/topup/:topupId" element={<TopUpStatusPage />} /></Routes>
      </BalanceProvider>,
      { initialEntries: [`/wallet/topup/${ID}`] },
    );
  };

  it("explains an amount mismatch in the member's own words, and never shows the code", async () => {
    show(snapshot({ status: "Failed", failure_code: "amount_mismatch" }));

    expect(await screen.findByText(/PayFast reported a different amount/)).toBeInTheDocument();
    // What to do next, which the raw string never said: whether money moved, and who to ask.
    expect(screen.getByText(/send the club your PayFast reference/)).toBeInTheDocument();

    // The string that was actually on screen, in every one of its parts.
    expect(screen.queryByText(/amount_mismatch/)).not.toBeInTheDocument();
    expect(screen.queryByText(/reported=/)).not.toBeInTheDocument();
    expect(screen.queryByText(/100,00/)).not.toBeInTheDocument();

    // And a way back, rather than a dead end.
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("treats a cancelled payment as cancelled, not as a failure", async () => {
    show(snapshot({ status: "Cancelled" }));

    // The member's own decision. Telling them it "failed" invites a support call about a
    // payment that worked exactly as they asked.
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText(/You cancelled this payment, so nothing was charged/)).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("falls back to a sentence, not a blank, for a code it has never seen", async () => {
    show(snapshot({ status: "Failed", failure_code: "some_new_code_from_a_later_release" }));

    expect(await screen.findByText(/This payment didn't go through/)).toBeInTheDocument();
    expect(screen.queryByText(/some_new_code/)).not.toBeInTheDocument();
  });

  it("says the payment is in flight while it is still pending", async () => {
    show(snapshot({ status: "Pending" }));

    expect(await screen.findByText(/Waiting for confirmation from PayFast/)).toBeInTheDocument();
    expect(screen.getByText("R500.00")).toBeInTheDocument();
  });
});

/**
 * What the page does while it waits, and what it does when it stops waiting.
 *
 * <p>
 * The poll was a flat <code>attempts &lt; 30</code> at two seconds, so it stopped after
 * 62 seconds — and said nothing. PayFast retries an ITN for hours and an EFT clears when
 * it clears, so the common case is that the money arrives AFTER the page has quietly given
 * up: a member whose R500 had landed sat reading "Waiting for confirmation from PayFast…"
 * with the credits already in their ledger, no control on the screen, and no way out but a
 * manual browser reload — which showed "Completed" immediately.
 * </p>
 *
 * <p>
 * The clock is driven here rather than the network, because the defect is entirely about
 * how long the page keeps asking and what it says when it stops.
 * </p>
 */
describe("Top-up status — waiting for a payment that has not landed yet", () => {
  const ID = "aaaa1111-0000-0000-0000-000000000002";
  const PENDING = { id: ID, status: "Pending", amount_zar: 500, conversion_rate: 1.6, failure_code: null };
  const COMPLETED = { ...PENDING, status: "Completed" };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", class {
      close() {}
      addEventListener() {}
      removeEventListener() {}
    } as unknown as typeof EventSource);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); signOut(); });

  function show(sequence: unknown[]) {
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: `/api/v1/credit/topup/${ID}`, body: null, sequence },
      { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
    ]);
    renderPage(
      <BalanceProvider>
        <Routes><Route path="/wallet/topup/:topupId" element={<TopUpStatusPage />} /></Routes>
      </BalanceProvider>,
      { initialEntries: [`/wallet/topup/${ID}`] },
    );
    return stub;
  }

  /**
   * One poll per call: a timer scheduled from inside an `advanceTimersByTimeAsync` is not
   * run by that same call, so the schedule has to be walked a step at a time.
   */
  async function walkTheClock(steps: number) {
    for (let i = 0; i < steps; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  }

  it("still notices a payment that completes long after the old 62-second budget", async () => {
    // 31 Pending answers — one more than the old budget ever asked for — and then the ITN.
    show([...Array(31).fill(PENDING), COMPLETED]);
    await walkTheClock(40);

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText(/Your wallet has been credited/)).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for confirmation from PayFast/)).not.toBeInTheDocument();
  });

  it("offers a way to ask while it is still waiting", async () => {
    show([PENDING]);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(screen.getByText(/Waiting for confirmation from PayFast/)).toBeInTheDocument();
    // The Pending branch had no control at all: only Cancelled and Failed got one.
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View wallet" })).toBeInTheDocument();
  });

  it("says it has stopped rather than claiming to still be waiting", async () => {
    show([PENDING]);
    await walkTheClock(70);

    expect(screen.queryByText(/Waiting for confirmation from PayFast/)).not.toBeInTheDocument();
    expect(screen.getByText(/We've stopped checking on this page/)).toBeInTheDocument();
    // …and says what happens next, rather than leaving the member to guess.
    expect(screen.getByText(/Your credits appear the moment it clears/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  });

  it("Check again asks again and reports the answer", async () => {
    show([PENDING, COMPLETED]);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(screen.getByText(/Waiting for confirmation from PayFast/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText(/Your wallet has been credited/)).toBeInTheDocument();
  });
});

/**
 * H-F2, the half that survived the first fix: what the page does when it cannot reach the club.
 *
 * <p>
 * The error branch was one sentence in a bare card — no Check again, no View wallet, not even
 * the page's own layout — so the only way out was the manual browser reload the whole finding
 * is about. Nothing walked a member into it before; the Check again button added in the last
 * round does, in one press. A refuter aborted the status request on a live Pending top-up,
 * pressed the button, and the page became "Couldn't load top-up status." with
 * <code>buttons: [""]</code>.
 * </p>
 *
 * <p>
 * Worth being precise about what a member is owed here, because this screen is the only thing
 * standing between them and R500 they have already paid: a way to ask again, a way back to the
 * wallet, and a sentence saying that a page which cannot reach the club has not cancelled
 * anything. And when a status HAS been read, losing it to a later network blip is itself the
 * defect — the badge and the amount stay, and the failure is a line beside them.
 * </p>
 */
describe("Top-up status — when the club cannot be reached", () => {
  const ID = "aaaa1111-0000-0000-0000-000000000003";
  const PENDING = { id: ID, status: "Pending", amount_zar: 500, conversion_rate: 1.6, failure_code: null };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", class {
      close() {}
      addEventListener() {}
      removeEventListener() {}
    } as unknown as typeof EventSource);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); signOut(); });

  /** `status` accepts an array, so the nth call can fail while the ones before it did not. */
  function show(sequence: unknown[], status: number[]) {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: `/api/v1/credit/topup/${ID}`, body: null, sequence, status },
      { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
    ]);
    renderPage(
      <BalanceProvider>
        <Routes><Route path="/wallet/topup/:topupId" element={<TopUpStatusPage />} /></Routes>
      </BalanceProvider>,
      { initialEntries: [`/wallet/topup/${ID}`] },
    );
  }

  const tick = async (ms = 50) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

  it("offers a way out instead of a sentence with nothing on it", async () => {
    show([PENDING], [500]);
    await tick();

    // The two controls the Pending branch has. Their absence was the dead end.
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "View wallet" })).toBeInTheDocument();

    // And the one thing a member watching R500 needs to be told.
    expect(screen.getByRole("alert")).toHaveTextContent(/Nothing here cancels or changes it/);
    expect(screen.queryByText("Couldn't load top-up status.")).not.toBeInTheDocument();

    // And not one thing more than the product does. This sentence used to end "we'll email you
    // either way", which no code path keeps: the only top-up mail the API sends is
    // TopUpConfirmation, from CompleteAsync — the Failed, Cancelled, amount_mismatch and
    // provider_register_failed branches send nothing at all. Asserted on the rendered alert,
    // not on the source, so moving the sentence into a constant or another file cannot lose it;
    // topup-status-email-promise.test.ts is what holds the copy against the backend itself.
    expect(screen.getByRole("alert")).not.toHaveTextContent(/either way/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/we'll email you the confirmation/i);
  });

  it("does not throw away a status it has already read when a later check fails", async () => {
    // Exactly the refuter's run: a live Pending page, then Check again against a club that
    // has stopped answering.
    show([PENDING, PENDING], [200, 500]);
    await tick();
    expect(screen.getByText("Pending")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await tick();

    // The status, the amount and both controls survive the failure…
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("R500.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "View wallet" })).toBeInTheDocument();
    // …and the page says the figures may be stale rather than pretending they are fresh.
    expect(screen.getByRole("alert")).toHaveTextContent(/may be out of date/);
  });

  it("recovers when the club answers again, so the way out is a real one", async () => {
    // A control for the two above: an escape that cannot actually escape is still a dead end.
    show([PENDING, { ...PENDING, status: "Completed" }], [500, 200]);
    await tick();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await tick();

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText(/Your wallet has been credited/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
