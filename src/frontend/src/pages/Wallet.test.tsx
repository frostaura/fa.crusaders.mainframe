import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import WalletPage from "./Wallet";
import { BalanceProvider, useBalance } from "../lib/balance";
import type { BalanceFrame, BalanceTransport } from "../lib/liveBalance";
import { ledgerRowFixture, renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * The wallet, on the screen a member opens when they are arguing about their balance.
 *
 * <p>
 * The header chip follows the live wallet stream. This page fetched once on mount and
 * never again, so an admin crediting a member while they watched left <b>517.01</b> in
 * the chip and <b>510.01</b> in the card underneath it, with no +7.00 row between them
 * and no refresh control anywhere on the page. Two balances, both from the same server,
 * disagreeing in front of the person least able to explain why.
 * </p>
 *
 * <p>
 * It also asked for a member's ENTIRE history in one call, so the page grew without
 * bound with the ledger. The count now says what it is showing out of what exists.
 * </p>
 */
describe("Wallet — one balance, and a way to refresh it", () => {
  const page = (balance: number, entries: unknown[], total = entries.length) => ({
    balance_credits: balance, entries, total_entries: total, offset: 0, limit: 100,
  });

  beforeEach(() => {
    vi.stubGlobal("EventSource", class { close() {} } as unknown as typeof EventSource);
    /*
      Reduced motion, so the card SNAPS to its figure instead of counting up to it.

      Not cosmetic: under jsdom the count-up is a clock bug waiting for a slow runner. jsdom
      stamps animation frames on the WINDOW's clock (time since the environment was built) while
      `performance.now()` here is the PROCESS's, so the tween starts hundreds of milliseconds in
      the past — measured: rAF 701.6 against performance.now() 1297.7 — dips the card from
      510.01 to 389.16, and only reaches 517.01 after that offset plus 350 ms. Alone that was
      ~950 ms; on a loaded full-suite runner it overran `findByText`'s one second and the card
      was caught at 516.96. These tests are about WHICH figure the card settles on, and the
      snap path is the same figure without the frame loop.
    */
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query.includes("reduce"), media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

  const ROW = ledgerRowFixture();
  const CREDITED = page(517.01, [
    ROW,
    ledgerRowFixture({ id: "66", signedAmountCredits: 7, amountCredits: 7, type: "AdminAdjustment", comment: "Desk credit" }),
  ], 2);

  /** A stream the test pushes through by hand, so the live figure moves when the TEST says so. */
  function handStream() {
    let push: ((frame: BalanceFrame) => void) | null = null;
    const transport: BalanceTransport = {
      open: ({ onFrame }) => { push = onFrame; return Promise.resolve({ close() {} }); },
    };
    return {
      transport,
      async frame(frame: BalanceFrame) {
        await waitFor(() => expect(push).not.toBeNull());
        await act(async () => { push!(frame); });
      },
    };
  }

  /** What the header chip reads: the provider's figure, which the card must agree with. */
  function Chip() {
    const { balance } = useBalance();
    return <output aria-label="chip">{balance === null ? "—" : balance.toFixed(2)}</output>;
  }

  /*
    The server as STATE, not as a queue of answers. One `sequence` used to serve every
    `/api/v1/wallet` read, and three things read it — this page and two balance providers — so
    which of them was handed "after the credit" depended on who asked second, and the live
    figure had in fact already jumped to 517.01 before Refresh was pressed. Here the credit
    happens when the test says it does, and every read after that sees it, whoever makes it.
  */
  function club() {
    const server = { credited: false };
    const now = () => (server.credited ? CREDITED : page(510.01, [ROW]));
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", respond: now },
    ]);
    return { server, stub };
  }

  const card = () => screen.getByText("Current balance").parentElement!;
  const pageReads = (stub: { calls: { path: string }[] }) => stub.calls.filter((c) => c.path.startsWith("/api/v1/wallet?")).length;

  it("re-reads the ledger when the live balance moves, instead of leaving two numbers on screen", async () => {
    const wire = handStream();
    const { server, stub } = club();
    renderPage(<BalanceProvider transport={wire.transport}><Chip /><WalletPage /></BalanceProvider>);

    await waitFor(() => expect(within(card()).getByText("510.01")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText("chip")).toHaveTextContent("510.01"));
    const readsBefore = pageReads(stub);

    // The desk credits the member while they watch. The stream says so before anything else.
    server.credited = true;
    await wire.frame({ balance_credits: 517.01, delta_credits: 7 });

    // The page follows the same signal: it re-reads, and the card, the chip and the ledger all
    // land on the new figure — with the row that explains the difference.
    expect(await screen.findByText("Desk credit")).toBeInTheDocument();
    expect(within(card()).getByText("517.01")).toBeInTheDocument();
    expect(screen.queryByText("510.01")).not.toBeInTheDocument();
    expect(screen.getByLabelText("chip")).toHaveTextContent("517.01");
    expect(screen.getByText("2 movements")).toBeInTheDocument();
    expect(pageReads(stub)).toBeGreaterThan(readsBefore);
  });

  it("Refresh shows the figure it just read, even when the live figure it holds is older", async () => {
    // The stream has gone quiet — degraded, parked, or simply never delivered this credit — so
    // the provider still holds 510.01. The member presses Refresh because the list looks wrong.
    const { server, stub } = club();
    renderPage(<BalanceProvider transport={handStream().transport}><Chip /><WalletPage /></BalanceProvider>);

    await waitFor(() => expect(within(card()).getByText("510.01")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText("chip")).toHaveTextContent("510.01"));

    // The control that did not exist. Pressing it is the member's own answer to "the
    // number at the top and the number in the middle do not match".
    // The header's RefreshButton (R3: refresh is a right-aligned icon button). It is never
    // `disabled` — it stays focusable and says `aria-busy` while a read is in flight, and
    // ignores a press until that read lands — so "ready" is the absence of aria-busy.
    const refresh = screen.getByRole("button", { name: "Refresh" });
    await waitFor(() => expect(refresh).not.toHaveAttribute("aria-busy"));
    const readsBefore = pageReads(stub);
    server.credited = true;
    fireEvent.click(refresh);

    // The +7.00 row arrived with 517.01. A card that went on saying 510.01 above it — because
    // "live wins" and the live figure was simply the older of the two — is the two-numbers
    // defect again, on the one button that exists to end it.
    expect(await screen.findByText("Desk credit")).toBeInTheDocument();
    await waitFor(() => expect(within(card()).getByText("517.01")).toBeInTheDocument());
    expect(screen.queryByText("510.01")).not.toBeInTheDocument();
    // And the header chip agrees with the card rather than being left behind in its turn.
    expect(screen.getByLabelText("chip")).toHaveTextContent("517.01");
    expect(pageReads(stub)).toBeGreaterThan(readsBefore);
  });

  it("asks for a page of movements, not the member's whole history", async () => {
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: page(510.01, [ROW], 240) },
    ]);
    renderPage(<BalanceProvider><WalletPage /></BalanceProvider>);

    await screen.findByText("510.01");

    // Bounded. The endpoint returned every row a member had ever had, and the page
    // rendered all of them.
    const call = stub.calls.find((c) => c.path.startsWith("/api/v1/wallet?"))!;
    expect(call.path).toContain("limit=100");
    expect(call.path).toContain("offset=0");

    // The count is honest about being a window, and there is a way to the rest of it.
    expect(screen.getByText("1 of 240 movements")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show older \(239 more\)/ })).toBeInTheDocument();
  });

  it("reads each share line's booking WITH the ledger, never one booking at a time (perf round)", async () => {
    const share = ledgerRowFixture({
      id: "77", type: "ShareTransfer", signedAmountCredits: 25, amountCredits: 25, comment: "Share of a split booking",
      relatedBookingId: "b1", actorUserId: "55555555-5555-5555-5555-555555555555", actorName: "Sam Petersen",
    });
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: { ...page(510.01, [share], 1), share_bookings: { b1: {
        booking_id: "b1", court_name: "Court 3", starts_at: "2026-09-30T16:00:00Z",
        organiser: { user_id: "44444444-4444-4444-4444-444444444444", name: "Ada Lovelace", photo_url: null },
        partners: [{ user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen", paid_credits: 25 }],
      } } } },
    ]);
    renderPage(<BalanceProvider><WalletPage /></BalanceProvider>);

    expect(await screen.findByRole("button", { name: /^Shares for Court 3 · Wed 30 Sep from 1 partner/ })).toBeInTheDocument();
    const pageRead = stub.calls.find((c) => c.path.startsWith("/api/v1/wallet?") && c.path.includes("limit=100"))!;
    expect(pageRead.path).toContain("include=share_bookings");
    expect(stub.calls.filter((c) => c.path.startsWith("/api/v1/bookings/"))).toHaveLength(0);
  });

  it("says nothing about a ledger it could not load", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", status: 500, body: { error: "server_error" } },
    ]);
    renderPage(<BalanceProvider><WalletPage /></BalanceProvider>);

    // R12: the failure is the shared StateBlock's sentence — the action, then why.
    expect(await screen.findByText(/Couldn't load your wallet/)).toBeInTheDocument();
    // "No movements yet" over a failed fetch tells a member their history is gone.
    expect(screen.queryByText(/No movements yet/)).not.toBeInTheDocument();
  });

  /*
    R11 / R12: one page shell, the wallet's two views as links, and a read in flight shown as
    the page's own shape rather than "Loading…".
  */
  it("draws its own shape while it reads, and offers its Activity view as a link", async () => {
    let answer: (() => void) | null = null;
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: page(510.01, [ROW]) },
    ]);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith("/api/v1/wallet?")
      ? new Promise<void>((resolve) => { answer = resolve; }).then(() => realFetch(input, init))
      : realFetch(input, init)));
    renderPage(<BalanceProvider><WalletPage /></BalanceProvider>, { initialEntries: ["/wallet"], reactStrictMode: true });

    await waitFor(() => expect(document.querySelector("[data-state-block=loading][aria-busy=true]")).not.toBeNull());
    expect(screen.queryByText(/Loading…/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Wallet" })).toBeInTheDocument();
    const views = screen.getByRole("navigation", { name: "Wallet views" });
    expect(within(views).getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/wallet/activity");
    expect(within(views).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");

    await waitFor(() => expect(answer).not.toBeNull());
    answer!();
    await waitFor(() => expect(within(card()).getByText("510.01")).toBeInTheDocument());
    expect(document.querySelector("[data-state-block=loading]")).toBeNull();
  });
});

/**
 * R5 M5-9 (SPEC 3.4): on a desktop the rail's Top up is the page's PRIMARY action beside the
 * figure (it was a soft secondary next to a primary docked twin on phones), and the last 30 days
 * stand under the balance.
 */
describe("Wallet — the desktop rail", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", class { close() {} } as unknown as typeof EventSource);
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query.includes("reduce") || query.includes("min-width: 1024px"), media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

  it("draws Top up as the primary action beside the balance, with the last 30 days under it", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      // Plenty to play with: the level that used to draw a soft secondary.
      { path: "/api/v1/wallet", body: { balance_credits: 900, entries: [ledgerRowFixture()], total_entries: 1, offset: 0, limit: 100 } },
      { path: "/api/v1/reports/me/wallet", body: { top_ups_credits: 300, spent_credits: 150, refunds_credits: 0, penalties_credits: 0, adjustments_credits: 0, net_movement_credits: 150, penalty_count: 0, attended_bookings: 3, bookings: 3, minutes_on_court: 135, count: 6 } },
    ]);
    renderPage(<BalanceProvider><WalletPage /></BalanceProvider>);
    const rail = await screen.findByRole("complementary", { name: "Your balance" });
    const topUp = await within(rail).findByRole("link", { name: /Top up/ });
    expect(topUp.className.split(" ")).toContain("bg-primary");
    expect(await within(rail).findByText("+300.00 cr")).toBeInTheDocument();
    // One Top up on the page: the docked bar is the phone's.
    expect(screen.getAllByRole("link", { name: /Top up/ })).toHaveLength(1);
  });
});
